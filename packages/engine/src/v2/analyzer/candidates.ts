/**
 * Phase 2 — Deterministic Candidate Generation (sink-first).
 *
 * Scans extracted sinks and verifies guard rails using the parsed
 * constraint model. Does NOT use LLM — purely structural analysis.
 *
 * For each value sink (transfer, mint, burn, close, set_authority, etc.):
 *   1. Identify the instruction it belongs to
 *   2. Look up the account struct via Context<T>
 *   3. Determine expected guards (signer, owner, has_one, constraint)
 *   4. If guards are missing or insufficient → emit candidate
 *   5. Score severity based on sink type + reachability
 */

import type {
  ParsedProgramV2,
  VulnCandidate,
  VulnClass,
  CandidateSeverity,
  AccountStructV2,
  AccountFieldV2,
  SinkV2,
  InstructionV2,
  CPICallV2,
} from "../types";
import { getAccountsForInstruction } from "../parser/cross-file-resolver";

// ─── Candidate Builder ──────────────────────────────────────

let nextCandidateId = 0;

function makeCandidate(
  vulnClass: VulnClass,
  severity: CandidateSeverity,
  confidence: number,
  instruction: string,
  ref: { file: string; startLine: number; endLine: number },
  involvedAccounts: { name: string; constraints: string[] }[],
  reason: string,
  sinkId: number | undefined,
  excerpt: string,
): VulnCandidate {
  const fp = `${vulnClass}:${instruction}:${ref.file}:${ref.startLine}:${involvedAccounts.map((a) => a.name).sort().join(",")}`;
  return {
    id: nextCandidateId++,
    vulnClass,
    severity,
    confidence,
    instruction,
    ref,
    involvedAccounts,
    reason,
    sinkId,
    fingerprint: fp,
    excerpt: excerpt.slice(0, 500),
  };
}

// ─── Guard Analysis Helpers ─────────────────────────────────

/**
 * Check if a field has signer protection.
 * Signer protection = Signer<'info> type OR #[account(signer)] constraint.
 */
function hasSigner(field: AccountFieldV2): boolean {
  if (field.anchorType === "Signer") return true;
  if (field.isSigner) return true;
  return field.constraints.some((c) => c.kind === "signer");
}

/**
 * Check if a field has owner validation.
 * Owner validation = Account<'info, T> (Anchor auto-validates) OR explicit owner constraint.
 */
function hasOwnerValidation(field: AccountFieldV2): boolean {
  if (field.anchorType === "Account") return true;
  if (field.anchorType === "Program") return true;
  if (field.anchorType === "InterfaceAccount") return true;
  if (field.anchorType === "Interface") return true;
  return field.constraints.some((c) => c.kind === "owner");
}

/**
 * Check if struct has any authority check for a given account.
 * Authority = has_one referencing this field, or a constraint expression that involves the field.
 */
function hasAuthorityCheck(
  struct: AccountStructV2,
  accountName: string,
  bodyExcerpt: string,
): boolean {
  // has_one pointing to this account
  for (const field of struct.fields) {
    const hasOneToThis = field.constraints.some(
      (c) => c.kind === "has_one" && c.expression === accountName,
    );
    if (hasOneToThis) return true;
  }

  // constraint expression referencing this account's key
  for (const field of struct.fields) {
    const constraintCheck = field.constraints.some(
      (c) =>
        c.kind === "constraint" &&
        c.expression &&
        c.expression.includes(accountName),
    );
    if (constraintCheck) return true;
  }

  // Body-level require! checks
  if (
    bodyExcerpt.includes(`require!(`) &&
    (bodyExcerpt.includes(`${accountName}.key()`) ||
      bodyExcerpt.includes(`${accountName}.is_signer`))
  ) {
    return true;
  }

  return false;
}

/**
 * Find fields that look like authority/signer accounts.
 */
function findAuthorityFields(struct: AccountStructV2): AccountFieldV2[] {
  return struct.fields.filter(
    (f) =>
      f.name.includes("authority") ||
      f.name.includes("owner") ||
      f.name.includes("admin") ||
      f.name.includes("payer") ||
      f.name.includes("signer") ||
      f.anchorType === "Signer",
  );
}

/**
 * Determine if a field's constraints list is human-readable.
 */
function constraintSummary(field: AccountFieldV2): string[] {
  return field.constraints.map((c) => {
    if (c.expression) return `${c.kind}=${c.expression}`;
    return c.kind;
  });
}

// ─── Sink-Specific Scanners ─────────────────────────────────

function scanTokenTransferSinks(
  program: ParsedProgramV2,
  sink: SinkV2,
  ix: InstructionV2,
  struct: AccountStructV2 | undefined,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];
  if (!struct) return candidates;

  // Token transfer needs:
  // 1. Authority account that is_signer (who approves the transfer)
  // 2. The source token account's authority should match the signer
  const authorityFields = findAuthorityFields(struct);
  const hasAnySigner = authorityFields.some((f) => hasSigner(f));

  if (!hasAnySigner && authorityFields.length > 0) {
    candidates.push(
      makeCandidate(
        "missing_signer",
        "CRITICAL",
        0.88,
        ix.name,
        sink.ref,
        authorityFields.map((f) => ({
          name: f.name,
          constraints: constraintSummary(f),
        })),
        `Token transfer in '${ix.name}' has authority account(s) [${authorityFields.map((f) => f.name).join(", ")}] without signer verification. An attacker could pass any account as authority.`,
        sink.id,
        sink.excerpt,
      ),
    );
  }

  if (authorityFields.length === 0) {
    // No authority account at all — might be PDA-signed (check CPI context)
    const hasPDASigner = sink.excerpt.includes("CpiContext::new_with_signer") ||
      sink.excerpt.includes("invoke_signed");
    if (!hasPDASigner) {
      candidates.push(
        makeCandidate(
          "missing_signer",
          "HIGH",
          0.72,
          ix.name,
          sink.ref,
          sink.involvedAccounts.map((a) => ({ name: a, constraints: [] })),
          `Token transfer in '${ix.name}' has no identifiable authority/signer account and no PDA signing context.`,
          sink.id,
          sink.excerpt,
        ),
      );
    }
  }

  // Check token authority constraint
  const tokenAccounts = struct.fields.filter(
    (f) =>
      f.innerType === "TokenAccount" ||
      f.innerType === "token::TokenAccount" ||
      f.rawType.includes("TokenAccount"),
  );

  for (const ta of tokenAccounts) {
    const hasAuthConstraint = ta.constraints.some(
      (c) => c.kind === "token_authority",
    );
    const hasMintConstraint = ta.constraints.some(
      (c) => c.kind === "token_mint",
    );
    if (!hasAuthConstraint && sink.involvedAccounts.includes(ta.name)) {
      candidates.push(
        makeCandidate(
          "token_authority_mismatch",
          "HIGH",
          0.78,
          ix.name,
          ta.ref,
          [{ name: ta.name, constraints: constraintSummary(ta) }],
          `Token account '${ta.name}' used in transfer in '${ix.name}' lacks token::authority constraint. An attacker could substitute a token account they control.`,
          sink.id,
          sink.excerpt,
        ),
      );
    }
  }

  return candidates;
}

function scanSOLTransferSinks(
  program: ParsedProgramV2,
  sink: SinkV2,
  ix: InstructionV2,
  struct: AccountStructV2 | undefined,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];
  if (!struct) return candidates;

  const authorityFields = findAuthorityFields(struct);
  const hasAnySigner = authorityFields.some((f) => hasSigner(f));

  if (!hasAnySigner && authorityFields.length > 0) {
    candidates.push(
      makeCandidate(
        "missing_signer",
        "CRITICAL",
        0.85,
        ix.name,
        sink.ref,
        authorityFields.map((f) => ({
          name: f.name,
          constraints: constraintSummary(f),
        })),
        `SOL transfer in '${ix.name}' has authority account(s) without signer check. Attacker could drain lamports.`,
        sink.id,
        sink.excerpt,
      ),
    );
  }

  return candidates;
}

function scanAccountCloseSinks(
  program: ParsedProgramV2,
  sink: SinkV2,
  ix: InstructionV2,
  struct: AccountStructV2 | undefined,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];
  if (!struct) return candidates;

  // Check for close constraint — Anchor handles this properly when present
  const hasCloseConstraint = struct.fields.some((f) =>
    f.constraints.some((c) => c.kind === "close"),
  );

  if (hasCloseConstraint) {
    // Check if the close target is properly constrained
    const closeFields = struct.fields.filter((f) =>
      f.constraints.some((c) => c.kind === "close"),
    );
    for (const cf of closeFields) {
      // The field being closed should also check that it can't be revived
      // (Anchor zeroes discriminator on close, but custom close may not)
      if (!cf.constraints.some((c) => c.kind === "close")) continue;
    }
  } else if (sink.excerpt.includes("lamports") && sink.excerpt.includes("= 0")) {
    // Manual lamport drain without Anchor close constraint
    const authorityFields = findAuthorityFields(struct);
    const hasAnySigner = authorityFields.some((f) => hasSigner(f));

    if (!hasAnySigner) {
      candidates.push(
        makeCandidate(
          "close_revive",
          "CRITICAL",
          0.82,
          ix.name,
          sink.ref,
          sink.involvedAccounts.map((a) => ({ name: a, constraints: [] })),
          `Manual account close in '${ix.name}' via lamport drain without signer verification. Account could be revived after close (no discriminator zeroing).`,
          sink.id,
          sink.excerpt,
        ),
      );
    }
  }

  return candidates;
}

function scanSetAuthoritySinks(
  program: ParsedProgramV2,
  sink: SinkV2,
  ix: InstructionV2,
  struct: AccountStructV2 | undefined,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];
  if (!struct) return candidates;

  const authorityFields = findAuthorityFields(struct);
  const hasAnySigner = authorityFields.some((f) => hasSigner(f));

  if (!hasAnySigner) {
    candidates.push(
      makeCandidate(
        "missing_signer",
        "CRITICAL",
        0.90,
        ix.name,
        sink.ref,
        authorityFields.map((f) => ({
          name: f.name,
          constraints: constraintSummary(f),
        })),
        `set_authority in '${ix.name}' without signer verification. An attacker could change the authority of token accounts.`,
        sink.id,
        sink.excerpt,
      ),
    );
  }

  return candidates;
}

function scanOracleSinks(
  program: ParsedProgramV2,
  sink: SinkV2,
  ix: InstructionV2,
  struct: AccountStructV2 | undefined,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];
  if (!struct) return candidates;

  // Oracle account should have owner check (Pyth/Switchboard program)
  const oracleAccounts = struct.fields.filter(
    (f) =>
      f.name.includes("oracle") ||
      f.name.includes("price") ||
      f.name.includes("feed") ||
      f.name.includes("aggregator"),
  );

  for (const oa of oracleAccounts) {
    if (!hasOwnerValidation(oa)) {
      candidates.push(
        makeCandidate(
          "oracle_validation",
          "CRITICAL",
          0.80,
          ix.name,
          oa.ref,
          [{ name: oa.name, constraints: constraintSummary(oa) }],
          `Oracle account '${oa.name}' in '${ix.name}' lacks owner validation. An attacker could supply a fake oracle with manipulated prices.`,
          sink.id,
          sink.excerpt,
        ),
      );
    }

    // Check for staleness validation in body
    const bodyHasStaleness =
      ix.bodyExcerpt.includes("timestamp") ||
      ix.bodyExcerpt.includes("stale") ||
      ix.bodyExcerpt.includes("max_age") ||
      ix.bodyExcerpt.includes("confidence");

    if (!bodyHasStaleness) {
      candidates.push(
        makeCandidate(
          "oracle_validation",
          "HIGH",
          0.65,
          ix.name,
          oa.ref,
          [{ name: oa.name, constraints: constraintSummary(oa) }],
          `Oracle account '${oa.name}' in '${ix.name}' may lack staleness/confidence validation. Stale prices could be exploited.`,
          sink.id,
          sink.excerpt,
        ),
      );
    }
  }

  return candidates;
}

// ─── Structural Scanners (non-sink-based) ───────────────────

function scanInitReinit(
  program: ParsedProgramV2,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  // Look for instructions that modify state accounts with init but
  // no is_initialized check for non-init instructions
  const initInstructions = new Set<string>();
  for (const struct of program.accountStructs) {
    if (struct.hasInit) {
      // Find the instruction that uses this struct
      const ix = program.instructions.find(
        (i) => i.accountsTypeName === struct.name,
      );
      if (ix) initInstructions.add(ix.name);
    }
  }

  // For each non-init instruction that has mut state accounts:
  // check that the account can't be re-initialized
  for (const struct of program.accountStructs) {
    if (!struct.isAccountsDerive) continue;
    const ix = program.instructions.find(
      (i) => i.accountsTypeName === struct.name,
    );
    if (!ix) continue;

    for (const field of struct.fields) {
      const hasInit = field.constraints.some(
        (c) => c.kind === "init" || c.kind === "init_if_needed",
      );
      if (!hasInit) continue;

      const hasInitIfNeeded = field.constraints.some(
        (c) => c.kind === "init_if_needed",
      );
      if (hasInitIfNeeded) {
        candidates.push(
          makeCandidate(
            "reinit",
            "HIGH",
            0.70,
            ix.name,
            field.ref,
            [{ name: field.name, constraints: constraintSummary(field) }],
            `Account '${field.name}' in '${ix.name}' uses init_if_needed which is prone to re-initialization attacks unless additional guards are present.`,
            undefined,
            ix.bodyExcerpt.slice(0, 200),
          ),
        );
      }
    }
  }

  return candidates;
}

function scanCPITargets(program: ParsedProgramV2): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  for (const cpi of program.cpiCalls) {
    if (!cpi.programValidated && cpi.callType.includes("invoke")) {
      candidates.push(
        makeCandidate(
          "arbitrary_cpi",
          "CRITICAL",
          0.85,
          cpi.instruction,
          cpi.ref,
          [],
          `CPI call (${cpi.callType}) in '${cpi.instruction}' targets a program passed via accounts without validation. An attacker could redirect CPI to a malicious program.`,
          undefined,
          cpi.excerpt,
        ),
      );
    }
  }

  return candidates;
}

function scanPDADerivations(program: ParsedProgramV2): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  for (const pda of program.pdaDerivations) {
    if (pda.bumpHandling === "unchecked") {
      candidates.push(
        makeCandidate(
          "pda_derivation",
          "HIGH",
          0.75,
          pda.instruction,
          pda.ref,
          [],
          `PDA derivation in '${pda.instruction}' uses create_program_address with unchecked bump. An attacker could supply a non-canonical bump to derive a different PDA.`,
          undefined,
          pda.seeds.join(", "),
        ),
      );
    }
    if (pda.bumpHandling === "missing" && pda.source === "constraint") {
      candidates.push(
        makeCandidate(
          "pda_derivation",
          "MEDIUM",
          0.60,
          pda.instruction,
          pda.ref,
          [],
          `PDA constraint in '${pda.instruction}' has seeds but no bump specified. Anchor may default to canonical bump, but explicit bump is safer.`,
          undefined,
          pda.seeds.join(", "),
        ),
      );
    }
  }

  return candidates;
}

function scanMissingSigner(
  program: ParsedProgramV2,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  for (const ix of program.instructions) {
    const struct = getAccountsForInstruction(ix, program.accountStructs);
    if (!struct) continue;

    // Any instruction that has sinks but no signer at all
    if (ix.sinkRefs.length > 0) {
      const hasAnySigner = struct.fields.some((f) => hasSigner(f));
      if (!hasAnySigner) {
        const sinkTypes = ix.sinkRefs
          .map((id) => program.sinks.find((s) => s.id === id))
          .filter(Boolean)
          .map((s) => s!.type);

        const hasDangerousSink = sinkTypes.some(
          (t) =>
            t === "token_transfer" ||
            t === "sol_transfer" ||
            t === "token_burn" ||
            t === "account_close" ||
            t === "set_authority",
        );

        if (hasDangerousSink) {
          candidates.push(
            makeCandidate(
              "missing_signer",
              "CRITICAL",
              0.90,
              ix.name,
              ix.ref,
              struct.fields.map((f) => ({
                name: f.name,
                constraints: constraintSummary(f),
              })),
              `Instruction '${ix.name}' has value-critical operations (${sinkTypes.join(", ")}) but no signer account in its Accounts struct.`,
              undefined,
              ix.bodyExcerpt.slice(0, 200),
            ),
          );
        }
      }
    }

    // Authority-named accounts without signer constraint
    const authorityFields = findAuthorityFields(struct);
    for (const af of authorityFields) {
      if (!hasSigner(af) && af.isMut) {
        // Check if there's a body-level check
        if (!hasAuthorityCheck(struct, af.name, ix.bodyExcerpt)) {
          candidates.push(
            makeCandidate(
              "missing_signer",
              "HIGH",
              0.78,
              ix.name,
              af.ref,
              [{ name: af.name, constraints: constraintSummary(af) }],
              `Authority account '${af.name}' in '${ix.name}' is mutable but not marked as signer. No has_one or constraint expression validates it.`,
              undefined,
              ix.bodyExcerpt.slice(0, 200),
            ),
          );
        }
      }
    }
  }

  return candidates;
}

function scanUncheckedAccounts(
  program: ParsedProgramV2,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  for (const struct of program.accountStructs) {
    if (!struct.isAccountsDerive) continue;

    const ix = program.instructions.find(
      (i) => i.accountsTypeName === struct.name,
    );
    if (!ix) continue;

    for (const field of struct.fields) {
      // UncheckedAccount or AccountInfo with no explicit checks
      if (
        (field.anchorType === "UncheckedAccount" ||
          field.anchorType === "AccountInfo") &&
        field.isMut
      ) {
        // Check if there's a CHECK comment or constraint
        const hasCheck = field.constraints.some(
          (c) => c.kind === "constraint" || c.kind === "address" || c.kind === "owner",
        );
        if (!hasCheck) {
          candidates.push(
            makeCandidate(
              "missing_owner",
              "HIGH",
              0.72,
              ix.name,
              field.ref,
              [{ name: field.name, constraints: constraintSummary(field) }],
              `Mutable UncheckedAccount/AccountInfo '${field.name}' in '${ix.name}' has no constraint, address, or owner check. Attacker could pass any account.`,
              undefined,
              ix.bodyExcerpt.slice(0, 200),
            ),
          );
        }
      }
    }
  }

  return candidates;
}

function scanIntegerOverflow(
  program: ParsedProgramV2,
): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  for (const ix of program.instructions) {
    const body = ix.bodyExcerpt;

    // Look for arithmetic on amount/balance/price without checked_ or saturating_
    const arithmeticLines = body.split("\n");
    for (let i = 0; i < arithmeticLines.length; i++) {
      const line = arithmeticLines[i];
      if (line.trimStart().startsWith("//")) continue;

      // Has arithmetic operator near financial-sounding variable
      const hasArith = /[+\-*]\s*[^=>]/.test(line) || /\bas\s+u(64|128)\b/.test(line);
      const hasFinVar = /amount|balance|lamports|price|fee|rate|supply|reserve/i.test(line);
      const isChecked =
        /checked_|saturating_|try_|\.checked_add|\.checked_sub|\.checked_mul|\.checked_div/.test(line);

      if (hasArith && hasFinVar && !isChecked) {
        candidates.push(
          makeCandidate(
            "integer_overflow",
            "HIGH",
            0.55,
            ix.name,
            { file: ix.ref.file, startLine: ix.ref.startLine + i, endLine: ix.ref.startLine + i },
            [],
            `Potential unchecked arithmetic on financial variable in '${ix.name}': ${line.trim().slice(0, 100)}`,
            undefined,
            line.trim(),
          ),
        );
      }
    }
  }

  return candidates;
}

// ─── Main Entry ─────────────────────────────────────────────

/**
 * Generate vulnerability candidates from the parsed program.
 *
 * Returns deduplicated, sorted candidates.
 */
export function generateCandidates(program: ParsedProgramV2): VulnCandidate[] {
  nextCandidateId = 0;
  const all: VulnCandidate[] = [];

  // ── Sink-based scanning ──
  for (const sink of program.sinks) {
    const ix = program.instructions.find((i) => i.name === sink.instruction);
    if (!ix) continue;
    const struct = ix.accountsTypeName
      ? program.accountStructs.find((s) => s.name === ix.accountsTypeName)
      : undefined;

    switch (sink.type) {
      case "token_transfer":
        all.push(...scanTokenTransferSinks(program, sink, ix, struct));
        break;
      case "sol_transfer":
        all.push(...scanSOLTransferSinks(program, sink, ix, struct));
        break;
      case "account_close":
        all.push(...scanAccountCloseSinks(program, sink, ix, struct));
        break;
      case "set_authority":
        all.push(...scanSetAuthoritySinks(program, sink, ix, struct));
        break;
      case "oracle_read":
        all.push(...scanOracleSinks(program, sink, ix, struct));
        break;
      case "token_mint_to":
      case "token_burn":
        // Similar to token transfer — need authority signer
        all.push(...scanTokenTransferSinks(program, sink, ix, struct));
        break;
      // state_write, invoke_signed, realloc handled by structural scanners below
    }
  }

  // ── Structural scanning (non-sink-based) ──
  all.push(...scanMissingSigner(program));
  all.push(...scanUncheckedAccounts(program));
  all.push(...scanInitReinit(program));
  all.push(...scanCPITargets(program));
  all.push(...scanPDADerivations(program));
  all.push(...scanIntegerOverflow(program));

  // ── Deduplicate by fingerprint ──
  const seen = new Map<string, VulnCandidate>();
  for (const c of all) {
    const existing = seen.get(c.fingerprint);
    if (!existing || c.confidence > existing.confidence) {
      seen.set(c.fingerprint, c);
    }
  }

  // ── Sort by severity × confidence ──
  const severityWeight: Record<CandidateSeverity, number> = {
    CRITICAL: 100,
    HIGH: 75,
    MEDIUM: 50,
    LOW: 25,
    INFO: 10,
  };

  const deduped = [...seen.values()];
  deduped.sort(
    (a, b) =>
      severityWeight[b.severity] * b.confidence -
      severityWeight[a.severity] * a.confidence,
  );

  // Re-number IDs after dedup
  for (let i = 0; i < deduped.length; i++) {
    deduped[i].id = i;
  }

  return deduped;
}
