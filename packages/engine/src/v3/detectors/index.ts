/**
 * V3 Detectors
 *
 * New vulnerability detection logic that operates on V2's ParsedProgramV2.
 * These detectors fill gaps in V2's analysis:
 *
 * 1. oracle_validation — detects oracle price reads without staleness/confidence checks
 * 2. native_owner_check — for native programs, detects account use without owner validation
 * 3. stale_post_cpi — detects account reads after CPI that may reference stale data
 * 4. native_instruction_remap — extracts real instruction names from match dispatch tables
 *
 * Each detector produces VulnCandidate objects compatible with V2's pipeline.
 */

import type {
  ParsedProgramV2,
  VulnCandidate,
  VulnClass,
  CandidateSeverity,
  SinkV2,
  InstructionV2,
  CPICallV2,
} from "../../v2/types";

let v3CandidateIdBase = 10_000; // Offset to avoid collision with V2 IDs

function makeV3Candidate(
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
  const fp = `v3:${vulnClass}:${instruction}:${ref.file}:${ref.startLine}:${involvedAccounts.map((a) => a.name).sort().join(",")}`;
  return {
    id: v3CandidateIdBase++,
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

// ─── 1. Oracle Validation Detector ──────────────────────────
//
// Detects oracle price reads without staleness or confidence checks.
// Targets: Mango V3, Jet V1, any program using Pyth/Switchboard.
//
// Pattern: oracle_read sink exists BUT the function body lacks:
//   - staleness checks (slot_diff, last_updated, age, stale, valid_slot)
//   - confidence checks (confidence, deviation, twap)
//   - price bound checks (min_price, max_price, price > 0)

const STALENESS_PATTERNS = [
  /slot[-_]?diff/i,
  /last[-_]?update/i,
  /stale/i,
  /valid[-_]?slot/i,
  /age\s*[<>]/,
  /current[-_]?slot\s*-/i,
  /clock\.slot\s*-/i,
  /oracle_staleness/i,
  /max[-_]?age/i,
  /freshness/i,
  /expires?[-_]?at/i,
  /timestamp[-_]?diff/i,
  /unix[-_]?timestamp/i,
  /slots?[-_]?since/i,
];

const CONFIDENCE_PATTERNS = [
  /confidence/i,
  /deviation/i,
  /twap/i,
  /ema[-_]?price/i,
  /price[-_]?range/i,
  /oracle[-_]?guard/i,
];

const PRICE_SANITY_PATTERNS = [
  /price\s*[><=!]=?\s*0/,
  /min[-_]?price/i,
  /max[-_]?price/i,
  /price[-_]?bound/i,
  /assert.*price/i,
  /require.*price/i,
];

export function detectOracleValidation(program: ParsedProgramV2): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];
  const seenInstructions = new Set<string>();

  // Strategy 1: Find oracle_read sinks (V2 classified)
  const oracleSinks = program.sinks.filter((s) => s.type === "oracle_read");

  for (const sink of oracleSinks) {
    const ix = program.instructions.find((i) => i.name === sink.instruction);
    if (!ix) continue;
    // Max 1 oracle finding per instruction
    if (seenInstructions.has(ix.name)) continue;

    const body = ix.bodyExcerpt;
    const hasStalenessCheck = STALENESS_PATTERNS.some((p) => p.test(body));
    const hasConfidenceCheck = CONFIDENCE_PATTERNS.some((p) => p.test(body));
    const hasPriceSanity = PRICE_SANITY_PATTERNS.some((p) => p.test(body));

    const calledFns = ix.calledFunctions || [];
    const hasValidationCall = calledFns.some(
      (fn) =>
        /valid/i.test(fn) ||
        /check.*oracle/i.test(fn) ||
        /oracle.*check/i.test(fn) ||
        /verify.*price/i.test(fn) ||
        /staleness/i.test(fn),
    );

    const guardCount = [hasStalenessCheck, hasConfidenceCheck, hasPriceSanity, hasValidationCall]
      .filter(Boolean).length;

    if (!hasStalenessCheck && !hasValidationCall) {
      seenInstructions.add(ix.name);
      const severity: CandidateSeverity = guardCount === 0 ? "CRITICAL" : "HIGH";
      const confidence = guardCount === 0 ? 0.82 : 0.65;

      const oracleAccounts = sink.involvedAccounts.filter(
        (a) =>
          /oracle/i.test(a) ||
          /price/i.test(a) ||
          /pyth/i.test(a) ||
          /switchboard/i.test(a) ||
          /feed/i.test(a),
      );

      const missingChecks: string[] = [];
      if (!hasStalenessCheck) missingChecks.push("staleness/freshness");
      if (!hasConfidenceCheck) missingChecks.push("confidence interval");
      if (!hasPriceSanity) missingChecks.push("price sanity bounds");

      candidates.push(
        makeV3Candidate(
          "oracle_validation",
          severity,
          confidence,
          ix.name,
          sink.ref,
          [
            ...oracleAccounts.map((a) => ({ name: a, constraints: [] })),
            ...sink.involvedAccounts
              .filter((a) => !oracleAccounts.includes(a))
              .slice(0, 2)
              .map((a) => ({ name: a, constraints: [] })),
          ],
          `Oracle price read in '${ix.name}' at line ${sink.ref.startLine} lacks ${missingChecks.join(" and ")} checks. ` +
            `An attacker could exploit stale or manipulated oracle prices.`,
          sink.id,
          sink.excerpt,
        ),
      );
    }
  }

  // Strategy 2: For native programs where V2 may not have classified oracle sinks,
  // look for oracle reading patterns in instruction bodies
  if (program.framework !== "anchor" || oracleSinks.length === 0) {
    const ORACLE_READ_PATTERNS = [
      /get_price\s*\(/i,
      /oracle.*price/i,
      /price.*oracle/i,
      /pyth.*get/i,
      /switchboard.*get/i,
      /load_price_account/i,
      /get_pyth_price/i,
      /price_account/i,
      /oracle_ai/i,
      /\.price\s*\(/,
      /get_price_data/i,
    ];

    for (const ix of program.instructions) {
      if (seenInstructions.has(ix.name)) continue;

      const body = ix.bodyExcerpt;
      const hasOracleRead = ORACLE_READ_PATTERNS.some((p) => p.test(body));
      if (!hasOracleRead) continue;

      const hasStalenessCheck = STALENESS_PATTERNS.some((p) => p.test(body));
      const calledFns = ix.calledFunctions || [];
      const hasValidationCall = calledFns.some(
        (fn) => /valid/i.test(fn) || /staleness/i.test(fn) || /check.*price/i.test(fn),
      );

      if (!hasStalenessCheck && !hasValidationCall) {
        seenInstructions.add(ix.name);
        candidates.push(
          makeV3Candidate(
            "oracle_validation",
            "HIGH",
            0.65,
            ix.name,
            ix.ref,
            [],
            `Oracle price reading detected in '${ix.name}' without staleness validation. ` +
              `Native program may be using oracle data without checking freshness.`,
            undefined,
            body.slice(0, 200),
          ),
        );
      }
    }
  }

  // Hard cap: max 5 oracle findings per program
  return candidates.slice(0, 5);
}

// ─── 2. Native Owner Check Detector ────────────────────────
//
// For native (non-Anchor) programs where V2 finds 0 account structs,
// checks whether deserialized accounts are validated for ownership.
//
// Pattern: account data is deserialized (try_from_slice, unpack, deserialize)
// BUT the function body lacks owner checks (account.owner == program_id).

const DESERIALIZE_PATTERNS = [
  /try_from_slice/,
  /unpack\s*\(/,
  /unpack_unchecked/,
  /deserialize\s*\(/,
  /from_account_info/,
  /try_deserialize/,
  /try_from_account_info/,
  /Account::unpack/,
  /AccountState::unpack/,
  /Reserve::unpack/,
  /Obligation::unpack/,
  /LendingMarket::unpack/,
  /Mint::unpack/,
  /TokenAccount::unpack/,
];

const OWNER_CHECK_PATTERNS = [
  /\.owner\s*==\s*program_id/,
  /\.owner\s*==\s*&?program_id/,
  /\.owner\s*!=\s*program_id/,
  /assert_eq!\s*\([^)]*\.owner/,
  /check_program_account/,
  /check_account_owner/,
  /assert_owned_by/,
  /owner_check/i,
  /validate_owner/i,
  /verify_account_owner/i,
  /spl_token::check_program_account/,
];

export function detectNativeMissingOwner(program: ParsedProgramV2): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  // Only relevant for native programs with no Anchor account structs
  if (program.framework === "anchor") return candidates;
  if (program.accountStructs.length > 5) return candidates; // Has some struct info

  for (const ix of program.instructions) {
    const body = ix.bodyExcerpt;
    const lines = body.split("\n");

    // Find lines with deserialization
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith("//")) continue;

      const hasDeserialize = DESERIALIZE_PATTERNS.some((p) => p.test(line));
      if (!hasDeserialize) continue;

      // Extract account name from the line if possible
      // Pattern: let foo = Foo::unpack(&account.data.borrow())?;
      const accountMatch = line.match(
        /let\s+(?:mut\s+)?(\w+)\s*=.*(?:unpack|deserialize|try_from)/,
      );
      const accountName = accountMatch?.[1] || "unknown_account";

      // Look for owner check within ±15 lines
      const contextStart = Math.max(0, i - 15);
      const contextEnd = Math.min(lines.length, i + 15);
      const context = lines.slice(contextStart, contextEnd).join("\n");

      const hasOwnerCheck = OWNER_CHECK_PATTERNS.some((p) => p.test(context));

      if (!hasOwnerCheck) {
        // Check the broader function body as fallback
        const bodyHasOwnerCheck = OWNER_CHECK_PATTERNS.some((p) => p.test(body));

        // If no owner check in the entire function, that's a real finding
        if (!bodyHasOwnerCheck) {
          candidates.push(
            makeV3Candidate(
              "missing_owner",
              "HIGH",
              0.72,
              ix.name,
              {
                file: ix.ref.file,
                startLine: ix.ref.startLine + i,
                endLine: ix.ref.startLine + i + 1,
              },
              [{ name: accountName, constraints: [] }],
              `Account '${accountName}' deserialized in '${ix.name}' at line ${ix.ref.startLine + i} without owner validation. ` +
                `In native Solana programs, accounts must be checked with 'account.owner == program_id' before trusting their data. ` +
                `An attacker could pass a fake account owned by a different program.`,
              undefined,
              line.trim(),
            ),
          );
        }
      }
    }
  }

  // Deduplicate by instruction + account
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = `${c.instruction}:${c.involvedAccounts.map((a) => a.name).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── 3. Stale Post-CPI Detector ────────────────────────────
//
// Detects account reads after CPI calls that may reference stale data.
// After a CPI, the called program may have mutated accounts that the
// caller still holds references to. Re-reading state without reload is unsafe.
//
// Pattern: invoke() or invoke_signed() call, followed by reading account
// data without reloading (reload(), try_borrow_data(), etc.)

const CPI_PATTERNS = [
  /invoke\s*\(/,
  /invoke_signed\s*\(/,
  /CpiContext::new/,
  /anchor_lang::solana_program::program::invoke/,
];

const RELOAD_PATTERNS = [
  /\.reload\s*\(\)/,
  /\.try_borrow_data\s*\(\)/,
  /AccountInfo::try_from/,
  /Account::try_from/,
  /Account::unpack/,
  /exit\s*\(\s*&/,  // Anchor exit pattern for re-serialization
];

export function detectStalePostCPI(program: ParsedProgramV2): VulnCandidate[] {
  const candidates: VulnCandidate[] = [];

  for (const ix of program.instructions) {
    const body = ix.bodyExcerpt;
    const lines = body.split("\n");

    // Find CPI call lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith("//")) continue;

      const hasCPI = CPI_PATTERNS.some((p) => p.test(line));
      if (!hasCPI) continue;

      // Look at code AFTER the CPI call (within 30 lines)
      const postCpiLines = lines.slice(i + 1, Math.min(i + 30, lines.length));
      const postCpiText = postCpiLines.join("\n");

      // Does post-CPI code read account state?
      const readsState =
        /\.amount/i.test(postCpiText) ||
        /\.lamports\(\)/i.test(postCpiText) ||
        /\.data\.borrow/i.test(postCpiText) ||
        /\.balance/i.test(postCpiText) ||
        /\.supply/i.test(postCpiText) ||
        /\.total/i.test(postCpiText) ||
        /unpack\s*\(/i.test(postCpiText);

      if (!readsState) continue;

      // Does it reload before reading?
      const reloadsFirst = RELOAD_PATTERNS.some((p) => p.test(postCpiText));

      if (!reloadsFirst) {
        // Extract CPI target info
        const cpiTarget = program.cpiCalls.find(
          (c) =>
            c.ref.startLine >= ix.ref.startLine + i - 2 &&
            c.ref.startLine <= ix.ref.startLine + i + 2,
        );

        candidates.push(
          makeV3Candidate(
            "stale_post_cpi",
            "HIGH",
            0.68,
            ix.name,
            {
              file: ix.ref.file,
              startLine: ix.ref.startLine + i,
              endLine: ix.ref.startLine + i + Math.min(postCpiLines.length, 10),
            },
            cpiTarget
              ? [{ name: cpiTarget.targetExpr || "unknown_program", constraints: [] }]
              : [],
            `Account state read after CPI call in '${ix.name}' at line ${ix.ref.startLine + i} without reload. ` +
              `The CPI target${cpiTarget ? ` (${cpiTarget.targetExpr})` : ""} may have mutated the accounts. ` +
              `Reading stale state can lead to incorrect calculations, double-spends, or fund theft.`,
            undefined,
            line.trim(),
          ),
        );
      }
    }
  }

  // Deduplicate: max 1 stale_post_cpi per instruction
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.instruction)) return false;
    seen.add(c.instruction);
    return true;
  });
}

// ─── 4. Native Instruction Remapper ────────────────────────
//
// For native programs, V2 often reports all sinks under a single
// "process_instruction" function. This remapper finds the actual
// dispatch table (match instruction_type { ... }) and maps functions
// to their instruction names.
//
// This allows the scorer to match V2 findings against expected
// instruction names like "liquidate", "deposit", "withdraw".

export interface InstructionMapping {
  /** V2 instruction name (the function name). */
  v2Name: string;
  /** Dispatched instruction names from match table. */
  dispatchNames: string[];
}

/**
 * Extract instruction dispatch mapping from a native program.
 * Looks for patterns like:
 *   match instruction { ... => process_foo(args) }
 *   match InstructionType::from(data) { ... FooInstruction => process_foo() }
 */
export function extractInstructionMapping(program: ParsedProgramV2): InstructionMapping[] {
  const mappings: InstructionMapping[] = [];

  for (const ix of program.instructions) {
    const body = ix.bodyExcerpt;

    // Look for match dispatch patterns
    // Pattern 1: match instruction { Foo => process_foo(), ... }
    const matchBlocks = body.matchAll(
      /(\w+(?:::\w+)*)\s*=>\s*\{?\s*(?:self\.|Self::)?(\w+)\s*\(/g,
    );

    const dispatchNames: string[] = [];
    for (const m of matchBlocks) {
      const enumVariant = m[1];
      const funcName = m[2];

      // Skip common non-instruction matches
      if (funcName === "err" || funcName === "msg" || funcName === "return") continue;

      // Extract the enum variant as the instruction name
      // e.g., MangoInstruction::Liquidate => "Liquidate" or "liquidate"
      const parts = enumVariant.split("::");
      const instrName = parts[parts.length - 1];

      // Map: if the function matches any V2 instruction, record the dispatch name
      const matchedIx = program.instructions.find((i) => i.name === funcName);
      if (matchedIx) {
        // Add the dispatch name to the existing instruction
        const existing = mappings.find((m) => m.v2Name === funcName);
        if (existing) {
          if (!existing.dispatchNames.includes(instrName.toLowerCase())) {
            existing.dispatchNames.push(instrName.toLowerCase());
          }
        } else {
          mappings.push({
            v2Name: funcName,
            dispatchNames: [instrName.toLowerCase()],
          });
        }
      }

      dispatchNames.push(instrName.toLowerCase());
    }

    // If the instruction itself is a dispatch function (e.g., process_instruction),
    // record all the dispatched names
    if (dispatchNames.length > 0 && !mappings.some((m) => m.v2Name === ix.name)) {
      mappings.push({
        v2Name: ix.name,
        dispatchNames,
      });
    }
  }

  return mappings;
}

/**
 * Remap a finding's instruction name using the dispatch mapping.
 * If the finding's instruction matches a dispatch table function,
 * add the dispatch names as aliases.
 */
export function remapInstruction(
  instruction: string,
  mappings: InstructionMapping[],
): string[] {
  const mapping = mappings.find((m) => m.v2Name === instruction);
  if (mapping) {
    return [instruction, ...mapping.dispatchNames];
  }
  return [instruction];
}

// ─── 5. Main V3 Detector Runner ─────────────────────────────

export interface V3DetectorResult {
  /** New candidates found by V3 detectors. */
  newCandidates: VulnCandidate[];
  /** Instruction dispatch mapping for native programs. */
  instructionMappings: InstructionMapping[];
  /** Detector execution stats. */
  stats: {
    oracleValidationFound: number;
    nativeMissingOwnerFound: number;
    stalePostCpiFound: number;
    instructionsMapped: number;
  };
}

/**
 * Run all V3 detectors on a parsed program.
 */
export function runV3Detectors(program: ParsedProgramV2): V3DetectorResult {
  v3CandidateIdBase = 10_000; // Reset

  const oracleCandidates = detectOracleValidation(program);
  const ownerCandidates = detectNativeMissingOwner(program);
  const staleCpiCandidates = detectStalePostCPI(program);
  const instructionMappings = extractInstructionMapping(program);

  return {
    newCandidates: [...oracleCandidates, ...ownerCandidates, ...staleCpiCandidates],
    instructionMappings,
    stats: {
      oracleValidationFound: oracleCandidates.length,
      nativeMissingOwnerFound: ownerCandidates.length,
      stalePostCpiFound: staleCpiCandidates.length,
      instructionsMapped: instructionMappings.reduce(
        (s, m) => s + m.dispatchNames.length,
        0,
      ),
    },
  };
}