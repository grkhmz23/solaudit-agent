import type { Detector, ParsedProgram, FindingResult } from "../types";

// ── Detector 11: Remaining Accounts Privilege Injection ──
export const RemainingAccountsInjection: Detector = {
  id: 11,
  name: "Remaining Accounts Privilege Injection",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      if (ix.body.includes("remaining_accounts") || ix.body.includes("ctx.remaining_accounts")) {
        // Check if remaining accounts are validated
        const hasValidation = ix.body.includes("remaining_accounts.iter()") &&
          (ix.body.includes("key()") || ix.body.includes("owner") || ix.body.includes("is_signer"));
        const hasLengthCheck = ix.body.match(/remaining_accounts\.len\(\)\s*[<>=!]/);

        if (!hasValidation) {
          findings.push({
            classId: 11,
            className: "Remaining Accounts Privilege Injection",
            severity: "HIGH",
            title: `${ix.name}: remaining_accounts used without validation`,
            location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
            confidence: 0.85,
            hypothesis: `Instruction '${ix.name}' iterates remaining_accounts without verifying their identity or ownership. An attacker can inject arbitrary accounts to escalate privileges or bypass checks.`,
            proofPlan: {
              steps: [
                `Call '${ix.name}' with injected malicious accounts in remaining_accounts`,
                "Assert unexpected privilege escalation or state change",
              ],
            },
            fixPlan: {
              pattern: "validate_remaining_accounts",
              description: "Validate each remaining account's key, owner, and/or signer status.",
              code: `for acc in ctx.remaining_accounts.iter() {\n    require!(acc.owner == &expected_program::ID, ErrorCode::InvalidAccount);\n}`,
            },
          });
        }

        if (!hasLengthCheck) {
          findings.push({
            classId: 11,
            className: "Remaining Accounts Privilege Injection",
            severity: "MEDIUM",
            title: `${ix.name}: remaining_accounts count not bounded`,
            location: { file: ix.file, line: ix.line, instruction: ix.name },
            confidence: 0.65,
            hypothesis: `No length check on remaining_accounts may allow excess accounts that affect compute budget or bypass iteration logic.`,
            fixPlan: {
              pattern: "bound_remaining_accounts",
              description: "Add a length check on remaining_accounts.",
              code: `require!(ctx.remaining_accounts.len() <= MAX_EXPECTED, ErrorCode::TooManyAccounts);`,
            },
          });
        }
      }
    }
    return findings;
  },
};

// ── Detector 12: Oracle Validation Failures ──
export const OracleValidationFailure: Detector = {
  id: 12,
  name: "Oracle Validation Failure",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      // Detect oracle/price feed usage
      const usesOracle = ix.body.includes("price") || ix.body.includes("oracle") ||
        ix.body.includes("pyth") || ix.body.includes("switchboard") ||
        ix.body.includes("chainlink") || ix.body.includes("price_feed");

      if (!usesOracle) continue;

      // Check for staleness validation
      const checksStaleness = ix.body.includes("timestamp") ||
        ix.body.includes("last_updated") ||
        ix.body.includes("stale") ||
        ix.body.includes("age") ||
        ix.body.includes("slot") && ix.body.includes("current");

      if (!checksStaleness) {
        findings.push({
          classId: 12,
          className: "Oracle Validation Failure",
          severity: "HIGH",
          title: `${ix.name}: oracle price used without staleness check`,
          location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
          confidence: 0.82,
          hypothesis: `Oracle data in '${ix.name}' is consumed without verifying freshness. An attacker can exploit stale prices during market volatility.`,
          fixPlan: {
            pattern: "oracle_staleness_check",
            description: "Validate oracle update timestamp against maximum acceptable age.",
            code: `let age = Clock::get()?.unix_timestamp - price_feed.timestamp;\nrequire!(age < MAX_ORACLE_AGE, ErrorCode::StaleOracle);`,
          },
        });
      }

      // Check for confidence interval validation
      const checksConfidence = ix.body.includes("confidence") || ix.body.includes("conf") ||
        ix.body.includes("deviation") || ix.body.includes("twap");

      if (!checksConfidence) {
        findings.push({
          classId: 12,
          className: "Oracle Validation Failure",
          severity: "MEDIUM",
          title: `${ix.name}: oracle price used without confidence check`,
          location: { file: ix.file, line: ix.line, instruction: ix.name },
          confidence: 0.70,
          hypothesis: `Oracle price consumed without checking confidence interval. Wide confidence bands during volatility may lead to incorrect valuations.`,
          fixPlan: {
            pattern: "oracle_confidence_check",
            description: "Validate oracle confidence interval is within acceptable bounds.",
            code: `require!(price_feed.conf < price_feed.price / MAX_CONF_RATIO, ErrorCode::OracleConfidenceTooWide);`,
          },
        });
      }

      // Check for oracle owner validation
      const checksOwner = ix.body.includes("oracle") &&
        (ix.ownerChecks.length > 0 || ix.body.includes("owner"));

      if (!checksOwner) {
        findings.push({
          classId: 12,
          className: "Oracle Validation Failure",
          severity: "CRITICAL",
          title: `${ix.name}: oracle account owner not validated`,
          location: { file: ix.file, line: ix.line, instruction: ix.name },
          confidence: 0.88,
          hypothesis: `Oracle account in '${ix.name}' is not verified against the expected oracle program. An attacker can pass a fake oracle with arbitrary prices.`,
          fixPlan: {
            pattern: "oracle_owner_check",
            description: "Verify the oracle account is owned by the expected oracle program.",
            code: `require!(\n    oracle_account.owner == &pyth_program::ID,\n    ErrorCode::InvalidOracle\n);`,
          },
        });
      }
    }
    return findings;
  },
};

// ── Detector 13: Token Account Authority/Mint Mismatch ──
export const TokenAccountMismatch: Detector = {
  id: 13,
  name: "Token Account Authority/Mint Mismatch",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      // Look for token account usage
      const usesTokens = ix.body.includes("TokenAccount") || ix.body.includes("token_account") ||
        ix.body.includes("token::") || ix.body.includes("spl_token");

      if (!usesTokens) continue;

      // Check for mint validation
      const hasMinCheck = ix.body.includes("mint =") || ix.body.includes("token::mint") ||
        ix.body.match(/constraint.*mint.*key\(\)/);

      if (!hasMinCheck && ix.body.includes("mint")) {
        findings.push({
          classId: 13,
          className: "Token Account Authority/Mint Mismatch",
          severity: "HIGH",
          title: `${ix.name}: token account mint not validated`,
          location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
          confidence: 0.83,
          hypothesis: `Token account mint in '${ix.name}' is not validated. An attacker can pass a token account with a different mint, bypassing value checks.`,
          fixPlan: {
            pattern: "validate_token_mint",
            description: "Add token::mint constraint to verify token account's mint.",
            code: `#[account(\n    token::mint = expected_mint,\n    token::authority = expected_authority\n)]`,
          },
        });
      }

      // Check for authority validation on token accounts
      const hasAuthorityCheck = ix.body.includes("token::authority") ||
        ix.body.includes("authority =") ||
        ix.body.match(/constraint.*authority.*key\(\)/);

      if (!hasAuthorityCheck && (ix.body.includes("vault") || ix.body.includes("treasury") || ix.body.includes("pool"))) {
        findings.push({
          classId: 13,
          className: "Token Account Authority/Mint Mismatch",
          severity: "HIGH",
          title: `${ix.name}: vault/pool token authority not validated`,
          location: { file: ix.file, line: ix.line, instruction: ix.name },
          confidence: 0.80,
          hypothesis: `Vault/pool token account authority in '${ix.name}' is not verified. An attacker can substitute a vault they control.`,
          fixPlan: {
            pattern: "validate_token_authority",
            description: "Add token::authority constraint to verify the token account's authority.",
            code: `#[account(token::authority = program_pda)]`,
          },
        });
      }
    }
    return findings;
  },
};

// ── Detector 14: Post-CPI Stale Reads ──
export const PostCPIStaleRead: Detector = {
  id: 14,
  name: "Post-CPI Stale Read",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const cpi of program.cpiCalls) {
      // Find instruction body containing this CPI
      const ix = program.instructions.find((i) => i.name === cpi.instruction);
      if (!ix) continue;

      // Check if any accounts are read after CPI without reload
      const cpiLineInBody = ix.body.split("\n").findIndex(
        (line) => line.includes("invoke") || line.includes("CpiContext")
      );

      if (cpiLineInBody >= 0) {
        const afterCPI = ix.body.split("\n").slice(cpiLineInBody + 1).join("\n");
        const accountReadsAfter = afterCPI.matchAll(/(\w+)\.(amount|lamports|data|key)/g);

        for (const read of accountReadsAfter) {
          const accName = read[1];
          const hasReload = cpi.accountsAfterCPI.includes(accName) ||
            afterCPI.includes(`${accName}.reload()`);

          if (!hasReload && accName !== "ctx" && accName !== "self") {
            findings.push({
              classId: 14,
              className: "Post-CPI Stale Read",
              severity: "HIGH",
              title: `${cpi.instruction}: '${accName}' read after CPI without reload`,
              location: { file: cpi.file, line: cpi.line, instruction: cpi.instruction },
              confidence: 0.78,
              hypothesis: `After CPI at ${cpi.file}:${cpi.line}, account '${accName}' is read without calling .reload(). The CPI may have modified this account, and the cached deserialized data is stale.`,
              fixPlan: {
                pattern: "post_cpi_reload",
                description: `Call ${accName}.reload()? after the CPI before reading its data.`,
                code: `// After CPI:\n${accName}.reload()?;\nlet current_amount = ${accName}.amount;`,
              },
            });
            break; // One finding per CPI is enough
          }
        }
      }
    }
    return findings;
  },
};

// ── Detector 15: Duplicate Account Injection / Account Aliasing ──
export const DuplicateAccountInjection: Detector = {
  id: 15,
  name: "Duplicate Account Injection / Account Aliasing",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      // Find pairs of mutable accounts that could be the same
      const mutAccounts = ix.accounts.filter((a) => a.isMut);

      if (mutAccounts.length < 2) continue;

      // Check for explicit key inequality constraints
      const hasKeyInequality = ix.body.includes("key() !=") ||
        ix.body.includes("!= ") && ix.body.includes(".key()") ||
        ix.body.match(/constraint\s*=.*key\(\)\s*!=\s*.*key\(\)/);

      if (!hasKeyInequality) {
        // Check common aliasing patterns
        const pairs: Array<[string, string]> = [];
        for (let i = 0; i < mutAccounts.length; i++) {
          for (let j = i + 1; j < mutAccounts.length; j++) {
            const a = mutAccounts[i].name;
            const b = mutAccounts[j].name;
            // Common dangerous pairs
            if (
              (a.includes("from") && b.includes("to")) ||
              (a.includes("source") && b.includes("dest")) ||
              (a.includes("sender") && b.includes("receiver")) ||
              (a.includes("user") && b.includes("vault")) ||
              (a === "account_a" && b === "account_b") ||
              (mutAccounts.length === 2) // Any two-mut-account instruction
            ) {
              pairs.push([a, b]);
            }
          }
        }

        for (const [a, b] of pairs) {
          findings.push({
            classId: 15,
            className: "Duplicate Account Injection / Account Aliasing",
            severity: "HIGH",
            title: `${ix.name}: '${a}' and '${b}' not checked for aliasing`,
            location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
            confidence: 0.75,
            hypothesis: `Passing the same account for both '${a}' and '${b}' in '${ix.name}' may cause double-counting, self-transfer exploits, or unexpected state corruption.`,
            proofPlan: {
              steps: [
                `Call '${ix.name}' with the same account for both '${a}' and '${b}'`,
                "Assert unexpected balance change or state corruption",
              ],
            },
            fixPlan: {
              pattern: "key_inequality_check",
              description: `Add constraint ensuring ${a} and ${b} are different accounts.`,
              code: program.framework === "anchor"
                ? `#[account(constraint = ${a}.key() != ${b}.key() @ ErrorCode::DuplicateAccount)]`
                : `if ${a}.key == ${b}.key {\n    return Err(ProgramError::InvalidArgument);\n}`,
              regressionTests: [
                `Test ${ix.name} with same account for both ${a} and ${b} (should fail)`,
              ],
            },
          });
        }
      }
    }
    return findings;
  },
};
