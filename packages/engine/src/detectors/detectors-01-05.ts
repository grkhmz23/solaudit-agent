import type { Detector, ParsedProgram, FindingResult } from "../types";

// ── Detector 1: Missing Signer Check ──
export const MissingSignerCheck: Detector = {
  id: 1,
  name: "Missing Signer Check",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      // Instructions that mutate accounts but don't verify signers
      const hasMutation = ix.accounts.some((a) => a.isMut);
      const hasSignerCheck = ix.signerChecks.length > 0 ||
        ix.accounts.some((a) => a.isSigner);
      const hasBodySignerCheck = ix.body.includes("is_signer") ||
        ix.body.includes("Signer<") ||
        ix.body.includes("#[account(signer");

      if (hasMutation && !hasSignerCheck && !hasBodySignerCheck) {
        // Check for authority-pattern accounts
        const authorityAccounts = ix.accounts.filter(
          (a) => a.name.includes("authority") || a.name.includes("owner") ||
                 a.name.includes("admin") || a.name.includes("payer")
        );

        if (authorityAccounts.length > 0) {
          for (const authAcc of authorityAccounts) {
            findings.push({
              classId: 1,
              className: "Missing Signer Check",
              severity: "CRITICAL",
              title: `${ix.name}: '${authAcc.name}' not verified as signer`,
              location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
              confidence: 0.92,
              hypothesis: `Any account can call '${ix.name}' as '${authAcc.name}' since signer status is never checked, allowing unauthorized state mutations.`,
              proofPlan: {
                steps: [
                  `Create program state with legitimate authority`,
                  `Call '${ix.name}' with a different keypair as '${authAcc.name}'`,
                  `Assert instruction succeeds (should not if properly guarded)`,
                ],
                deltaSchema: {
                  preState: { [`${authAcc.name}_is_authority`]: true },
                  postState: { unauthorized_mutation: true },
                  assertion: "Non-signer can execute privileged instruction",
                },
              },
              fixPlan: {
                pattern: "add_signer_constraint",
                description: `Add signer verification for '${authAcc.name}' account.`,
                code: program.framework === "anchor"
                  ? `#[account(signer)]\npub ${authAcc.name}: Signer<'info>,`
                  : `if !${authAcc.name}.is_signer {\n    return Err(ProgramError::MissingRequiredSignature);\n}`,
                regressionTests: [
                  `Test that ${ix.name} fails with non-signer ${authAcc.name}`,
                  `Test that ${ix.name} succeeds with proper signer`,
                ],
              },
            });
          }
        } else if (ix.accounts.length > 0) {
          // No authority-named accounts but still has mutations without signer
          findings.push({
            classId: 1,
            className: "Missing Signer Check",
            severity: "HIGH",
            title: `${ix.name}: no signer verification on mutable instruction`,
            location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
            confidence: 0.75,
            hypothesis: `Instruction '${ix.name}' mutates state without verifying any signer. An attacker may invoke this instruction freely.`,
            fixPlan: {
              pattern: "add_signer_constraint",
              description: "Add an authority/signer account with proper constraint.",
            },
          });
        }
      }
    }
    return findings;
  },
};

// ── Detector 2: Missing Owner Check ──
export const MissingOwnerCheck: Detector = {
  id: 2,
  name: "Missing Owner Check",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      // In native programs, accounts need explicit owner checks
      if (program.framework === "native") {
        for (const acc of ix.accounts) {
          if (acc.isMut && !ix.ownerChecks.includes("owner_check")) {
            findings.push({
              classId: 2,
              className: "Missing Owner Check",
              severity: "CRITICAL",
              title: `${ix.name}: '${acc.name}' owner not verified`,
              location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
              confidence: 0.88,
              hypothesis: `Account '${acc.name}' is mutable but its owner is not checked against the program ID. An attacker could pass a fake account owned by a different program.`,
              fixPlan: {
                pattern: "add_owner_check",
                description: `Verify ${acc.name}.owner == program_id before trusting account data.`,
                code: `if ${acc.name}.owner != program_id {\n    return Err(ProgramError::IncorrectProgramId);\n}`,
              },
            });
          }
        }
      }

      // In Anchor, check for UncheckedAccount or AccountInfo without owner validation
      if (program.framework === "anchor") {
        const hasUnchecked = ix.body.includes("UncheckedAccount") || ix.body.includes("AccountInfo");
        const hasCheckDoc = ix.body.includes("/// CHECK:");
        if (hasUnchecked && !hasCheckDoc && !ix.ownerChecks.includes("anchor_account_type")) {
          findings.push({
            classId: 2,
            className: "Missing Owner Check",
            severity: "HIGH",
            title: `${ix.name}: UncheckedAccount/AccountInfo used without owner validation`,
            location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
            confidence: 0.82,
            hypothesis: `Unchecked accounts bypass Anchor's automatic owner validation, allowing spoofed accounts from arbitrary programs.`,
            fixPlan: {
              pattern: "use_typed_account",
              description: "Replace UncheckedAccount with typed Account<'info, T> or add manual owner check.",
              code: `/// CHECK: Validated by constraint\n#[account(constraint = account.owner == &expected_program::ID)]`,
            },
          });
        }
      }
    }
    return findings;
  },
};

// ── Detector 3: PDA Derivation Mistakes ──
export const PDADerivationMistake: Detector = {
  id: 3,
  name: "PDA Derivation Mistake",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const pda of program.pdaDerivations) {
      // Check 1: Non-canonical bump
      if (pda.bumpHandling === "unchecked") {
        findings.push({
          classId: 3,
          className: "PDA Derivation Mistake",
          severity: "HIGH",
          title: `${pda.instruction}: PDA uses non-canonical bump (seed drift risk)`,
          location: { file: pda.file, line: pda.line, instruction: pda.instruction },
          confidence: 0.85,
          hypothesis: `PDA at ${pda.file}:${pda.line} accepts a user-supplied bump instead of using the canonical (highest) bump. An attacker can derive alternative valid PDAs.`,
          fixPlan: {
            pattern: "use_canonical_bump",
            description: "Use Anchor's `bump` constraint without explicit value to enforce canonical bump.",
            code: `seeds = [${pda.seeds.join(", ")}],\nbump`,
          },
        });
      }

      // Check 2: Insufficient seeds (only static seeds, no user-specific component)
      const hasUserSeed = pda.seeds.some(
        (s) => s.includes("key()") || s.includes("pubkey") || s.includes("authority") ||
               s.includes("user") || s.includes("owner") || s.includes(".as_ref()")
      );
      if (!hasUserSeed && pda.seeds.length <= 1) {
        findings.push({
          classId: 3,
          className: "PDA Derivation Mistake",
          severity: "HIGH",
          title: `${pda.instruction}: PDA has insufficient seeds (collision risk)`,
          location: { file: pda.file, line: pda.line, instruction: pda.instruction },
          confidence: 0.80,
          hypothesis: `PDA derived with seeds [${pda.seeds.join(", ")}] lacks user-specific components, allowing only one instance or enabling cross-user collisions.`,
          fixPlan: {
            pattern: "add_pda_seeds",
            description: "Include user-specific seeds (e.g., authority pubkey, unique nonce).",
            code: `seeds = [b"prefix", authority.key().as_ref()]`,
          },
        });
      }

      // Check 3: Missing bump entirely
      if (pda.bumpHandling === "missing") {
        findings.push({
          classId: 3,
          className: "PDA Derivation Mistake",
          severity: "MEDIUM",
          title: `${pda.instruction}: PDA derivation without bump validation`,
          location: { file: pda.file, line: pda.line, instruction: pda.instruction },
          confidence: 0.70,
          hypothesis: `PDA derivation at ${pda.file}:${pda.line} doesn't validate the bump seed, which could allow passing arbitrary accounts.`,
          fixPlan: {
            pattern: "add_bump_validation",
            description: "Store and verify the canonical bump.",
          },
        });
      }
    }
    return findings;
  },
};

// ── Detector 4: Arbitrary CPI Target ──
export const ArbitraryCPITarget: Detector = {
  id: 4,
  name: "Arbitrary CPI Target",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const cpi of program.cpiCalls) {
      if (!cpi.programValidated) {
        findings.push({
          classId: 4,
          className: "Arbitrary CPI Target",
          severity: "CRITICAL",
          title: `${cpi.instruction}: CPI target program not validated`,
          location: { file: cpi.file, line: cpi.line, instruction: cpi.instruction },
          confidence: 0.90,
          hypothesis: `CPI at ${cpi.file}:${cpi.line} invokes a program without verifying its address. An attacker can substitute a malicious program (fake token program, fake oracle, etc.).`,
          proofPlan: {
            steps: [
              "Deploy a malicious program that mimics the expected CPI target",
              `Call '${cpi.instruction}' passing the malicious program address`,
              "Assert the malicious program is invoked instead of the legitimate one",
            ],
          },
          fixPlan: {
            pattern: "validate_cpi_target",
            description: "Use Anchor's Program<'info, T> type or manually verify program ID.",
            code: program.framework === "anchor"
              ? `pub token_program: Program<'info, Token>,`
              : `if *program_id != expected_program::id() {\n    return Err(ProgramError::IncorrectProgramId);\n}`,
          },
        });
      }
    }
    return findings;
  },
};

// ── Detector 5: Type Confusion / Account Substitution ──
export const TypeConfusion: Detector = {
  id: 5,
  name: "Type Confusion / Account Substitution",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const acc of program.accounts) {
      // Check for missing discriminator
      if (!acc.discriminator && program.framework === "native") {
        findings.push({
          classId: 5,
          className: "Type Confusion",
          severity: "HIGH",
          title: `Account struct '${acc.name}' lacks discriminator`,
          location: { file: acc.file, line: acc.line },
          confidence: 0.80,
          hypothesis: `Without a discriminator, '${acc.name}' data can be confused with other account types. An attacker can pass an account of a different type that happens to deserialize without error.`,
          fixPlan: {
            pattern: "add_discriminator",
            description: "Add an 8-byte discriminator field and validate it on deserialization.",
            code: `const DISCRIMINATOR: [u8; 8] = [/* unique bytes */];\n// Validate at start of deserialization`,
          },
        });
      }

      // Detect unsafe deserialization patterns
      for (const file of program.files) {
        if (file.content.includes("try_from_slice") && file.content.includes(acc.name)) {
          findings.push({
            classId: 5,
            className: "Type Confusion",
            severity: "MEDIUM",
            title: `Unsafe deserialization of '${acc.name}' via try_from_slice`,
            location: { file: file.path, line: acc.line },
            confidence: 0.72,
            hypothesis: `Using try_from_slice without discriminator validation allows account substitution attacks.`,
            fixPlan: {
              pattern: "safe_deserialization",
              description: "Use Anchor's Account<T> wrapper or manually check discriminator before deserializing.",
            },
          });
        }
      }
    }
    return findings;
  },
};
