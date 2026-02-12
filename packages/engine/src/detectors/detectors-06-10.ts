import type { Detector, ParsedProgram, FindingResult } from "../types";

// ── Detector 6: Reinitialization / Double-Init ──
export const Reinitialization: Detector = {
  id: 6,
  name: "Reinitialization / Double-Init",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      const isInitLike = ix.name.includes("init") || ix.name.includes("create") || ix.name.includes("setup");
      if (!isInitLike) continue;

      // Check if init constraint is properly used (Anchor)
      const hasAnchorInit = ix.body.includes("#[account(init") || ix.body.includes("init,");
      const hasIsInitializedCheck = ix.body.includes("is_initialized") ||
        ix.body.includes("initialized == true") ||
        ix.body.includes("initialized == false") ||
        ix.body.includes("!= 0") ||
        ix.body.match(/require!\s*\(\s*!\s*\w+\.initialized/);

      if (!hasAnchorInit && !hasIsInitializedCheck) {
        findings.push({
          classId: 6,
          className: "Reinitialization / Double-Init",
          severity: "HIGH",
          title: `${ix.name}: account can be re-initialized`,
          location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
          confidence: 0.85,
          hypothesis: `Instruction '${ix.name}' creates/initializes account data without checking if already initialized. Calling twice overwrites existing state, potentially changing authority or resetting critical values.`,
          proofPlan: {
            steps: [
              `Initialize account with user A as authority`,
              `Call '${ix.name}' again with user B's data`,
              `Assert authority changed from A to B`,
            ],
            deltaSchema: {
              preState: { authority: "userA", initialized: true },
              postState: { authority: "userB", initialized: true },
              assertion: "Authority changed via re-initialization",
            },
          },
          fixPlan: {
            pattern: "init_constraint",
            description: program.framework === "anchor"
              ? "Use Anchor `init` constraint which automatically checks if account is already initialized."
              : "Add an `is_initialized` flag and check it before writing.",
            code: program.framework === "anchor"
              ? `#[account(init, payer = payer, space = 8 + DataStruct::INIT_SPACE)]`
              : `if account_data.is_initialized {\n    return Err(ProgramError::AccountAlreadyInitialized);\n}`,
          },
        });
      }
    }
    return findings;
  },
};

// ── Detector 7: Close-then-Revive / Closure without Zeroing ──
export const CloseThenRevive: Detector = {
  id: 7,
  name: "Close-then-Revive / Closure without Zeroing",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      const isCloseLike = ix.name.includes("close") || ix.name.includes("delete") ||
        ix.name.includes("withdraw_all") || ix.name.includes("remove");
      const hasLamportDrain = ix.body.includes("lamports()") &&
        (ix.body.includes("= 0") || ix.body.includes("-="));
      const hasAnchorClose = ix.body.includes("#[account(") && ix.body.includes("close");

      if (isCloseLike || hasLamportDrain) {
        // Check if data is zeroed
        const dataZeroed = ix.body.includes("fill(0)") ||
          ix.body.includes("0u8; ") ||
          ix.body.includes(".data.borrow_mut()") ||
          hasAnchorClose;

        if (!dataZeroed && !hasAnchorClose) {
          findings.push({
            classId: 7,
            className: "Close-then-Revive",
            severity: "HIGH",
            title: `${ix.name}: account closed without zeroing data`,
            location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
            confidence: 0.82,
            hypothesis: `When '${ix.name}' closes an account by draining lamports, the account data is not zeroed. Within the same transaction, the account can be "revived" with a small lamport transfer, resurrecting stale data.`,
            proofPlan: {
              steps: [
                "Initialize account with funds",
                `Call '${ix.name}' to close/drain the account`,
                "In the same transaction, send lamports back to revive it",
                "Assert account data is still readable and exploitable",
              ],
            },
            fixPlan: {
              pattern: "zero_on_close",
              description: "Zero account data before draining lamports, or use Anchor's close constraint.",
              code: program.framework === "anchor"
                ? `#[account(mut, close = recipient)]`
                : `let data = account.try_borrow_mut_data()?;\ndata.fill(0);\n// Then drain lamports`,
            },
          });
        }
      }
    }
    return findings;
  },
};

// ── Detector 8: Unchecked Realloc / Stale Memory ──
export const UncheckedRealloc: Detector = {
  id: 8,
  name: "Unchecked Realloc / Stale Memory",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    for (const ix of program.instructions) {
      const hasRealloc = ix.body.includes("realloc") || ix.body.includes("AccountInfo::realloc");
      const hasReallocConstraint = ix.body.includes("#[account(") && ix.body.includes("realloc");

      if (hasRealloc || hasReallocConstraint) {
        // Check if zero_init is used with realloc
        const hasZeroInit = ix.body.includes("zero_init") || ix.body.includes("realloc::zero = true");

        if (!hasZeroInit) {
          findings.push({
            classId: 8,
            className: "Unchecked Realloc / Stale Memory",
            severity: "MEDIUM",
            title: `${ix.name}: realloc without zero-init`,
            location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
            confidence: 0.78,
            hypothesis: `Account reallocation in '${ix.name}' does not zero new memory. Extended memory contains stale heap data that may be interpreted as valid account fields.`,
            fixPlan: {
              pattern: "zero_realloc",
              description: "Use realloc::zero = true in Anchor or manually zero extended bytes.",
              code: `#[account(mut, realloc = new_size, realloc::payer = payer, realloc::zero = true)]`,
            },
          });
        }
      }
    }
    return findings;
  },
};

// ── Detector 9: Integer Overflow/Underflow ──
export const IntegerOverflow: Detector = {
  id: 9,
  name: "Integer Overflow/Underflow",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];
    const seenLocations = new Set<string>();

    for (const ix of program.instructions) {
      for (const op of ix.arithmeticOps) {
        if (!op.checked) {
          const locKey = `${op.file}:${op.line}`;
          if (seenLocations.has(locKey)) continue;
          seenLocations.add(locKey);

          findings.push({
            classId: 9,
            className: "Integer Overflow/Underflow",
            severity: "HIGH",
            title: `${ix.name}: unchecked arithmetic at ${op.file}:${op.line}`,
            location: { file: op.file, line: op.line, instruction: ix.name },
            confidence: 0.80,
            hypothesis: `Unchecked '${op.op}' operation on value-type data (amounts/balances) can overflow or underflow, leading to incorrect token amounts, bypassed limits, or fund theft.`,
            proofPlan: {
              steps: [
                `Set up state with values near ${op.op === "-" ? "0" : "u64::MAX"}`,
                `Call '${ix.name}' with values that cause ${op.op === "-" ? "underflow" : "overflow"}`,
                "Assert unexpected behavior or panic",
              ],
            },
            fixPlan: {
              pattern: "checked_math",
              description: "Use checked arithmetic methods.",
              code: op.op === "+"
                ? "amount_a.checked_add(amount_b).ok_or(ErrorCode::MathOverflow)?"
                : op.op === "-"
                  ? "amount_a.checked_sub(amount_b).ok_or(ErrorCode::MathUnderflow)?"
                  : op.op === "*"
                    ? "amount_a.checked_mul(amount_b).ok_or(ErrorCode::MathOverflow)?"
                    : "amount_a.checked_div(amount_b).ok_or(ErrorCode::MathDivisionByZero)?",
              regressionTests: [
                `Test ${ix.name} with boundary values`,
                `Test ${ix.name} with zero values`,
              ],
            },
          });
        }
      }
    }
    return findings;
  },
};

// ── Detector 10: State Machine Violations ──
export const StateMachineViolation: Detector = {
  id: 10,
  name: "State Machine Violation",
  detect(program: ParsedProgram): FindingResult[] {
    const findings: FindingResult[] = [];

    // Find state-transition instructions
    for (const ix of program.instructions) {
      const isClaimLike = ix.name.includes("claim") || ix.name.includes("redeem") ||
        ix.name.includes("withdraw") || ix.name.includes("finalize");
      const isTransitionLike = ix.name.includes("update") || ix.name.includes("transition") ||
        ix.name.includes("complete") || ix.name.includes("cancel");

      if (isClaimLike || isTransitionLike) {
        // Check if state is verified before transition
        const hasStateCheck = ix.body.match(
          /(?:require|assert|match|if).*(?:state|status|phase|stage)/s
        );

        if (!hasStateCheck) {
          findings.push({
            classId: 10,
            className: "State Machine Violation",
            severity: "HIGH",
            title: `${ix.name}: no state guard on transition/claim instruction`,
            location: { file: ix.file, line: ix.line, endLine: ix.endLine, instruction: ix.name },
            confidence: 0.75,
            hypothesis: `Instruction '${ix.name}' performs a state-dependent action without verifying current state. An attacker can call it in an invalid state (e.g., double-claim, claim before completion).`,
            proofPlan: {
              steps: [
                "Set account to non-qualifying state",
                `Call '${ix.name}'`,
                "Assert it succeeds when it should have been blocked",
              ],
            },
            fixPlan: {
              pattern: "add_state_guard",
              description: "Add require! or constraint checking current state before allowing transition.",
              code: `require!(account.state == ExpectedState::Ready, ErrorCode::InvalidState);`,
            },
          });
        }
      }
    }
    return findings;
  },
};
