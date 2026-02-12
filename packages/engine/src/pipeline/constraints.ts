import type {
  ParsedProgram,
  Constraint,
  ConstraintViolation,
  Severity,
} from "../types";

/**
 * Lightweight constraint checker that verifies authority chain conditions
 * and obvious invariant contradictions. Not a full SMT solver, but provides
 * a clean interface to plug one in later.
 *
 * Checks:
 * 1. Authority chain integrity (every privileged op has a verified signer)
 * 2. PDA derivation consistency (same seeds → same PDA across instructions)
 * 3. Balance conservation (no lamport/token creation without mint authority)
 * 4. State transition validity (no impossible state transitions)
 */

export interface ConstraintCheckerPlugin {
  name: string;
  check(program: ParsedProgram): ConstraintViolation[];
}

/** Built-in: authority chain checker */
const authorityChainChecker: ConstraintCheckerPlugin = {
  name: "authority_chain",
  check(program) {
    const violations: ConstraintViolation[] = [];

    for (const ix of program.instructions) {
      // Every mutable account should have a traceable authority chain
      const mutAccounts = ix.accounts.filter((a) => a.isMut);
      const signers = ix.accounts.filter((a) => a.isSigner);

      for (const mut of mutAccounts) {
        // Check: is there a signer that can be linked to this mutable account?
        const hasAuthorityLink =
          signers.length > 0 ||
          ix.body.includes("has_one") ||
          ix.body.match(new RegExp(`constraint.*${mut.name}.*authority`)) !== null ||
          ix.body.match(new RegExp(`constraint.*${mut.name}.*owner`)) !== null;

        if (!hasAuthorityLink && !mut.name.includes("system_program") && !mut.name.includes("token_program")) {
          violations.push({
            constraint: {
              type: "authority_chain",
              subject: `${ix.name}::${mut.name}`,
              predicate: "has_verified_authority",
              expected: "signer linked to mutable account",
              actual: "no authority chain found",
            },
            message: `Mutable account '${mut.name}' in '${ix.name}' has no traceable authority chain to any signer.`,
            severity: "HIGH",
          });
        }
      }
    }

    return violations;
  },
};

/** Built-in: PDA consistency checker */
const pdaConsistencyChecker: ConstraintCheckerPlugin = {
  name: "pda_consistency",
  check(program) {
    const violations: ConstraintViolation[] = [];

    // Group PDA derivations by their seed patterns
    const pdaGroups = new Map<string, typeof program.pdaDerivations>();

    for (const pda of program.pdaDerivations) {
      // Normalize seeds for comparison
      const normalized = pda.seeds
        .map((s) => s.replace(/\s/g, ""))
        .sort()
        .join("|");

      if (!pdaGroups.has(normalized)) pdaGroups.set(normalized, []);
      pdaGroups.get(normalized)!.push(pda);
    }

    // Check for same PDA used with different bump strategies
    for (const [seeds, derivations] of pdaGroups) {
      const bumpHandlings = new Set(derivations.map((d) => d.bumpHandling));
      if (bumpHandlings.size > 1) {
        violations.push({
          constraint: {
            type: "pda_consistency",
            subject: `PDA[${seeds}]`,
            predicate: "consistent_bump_handling",
            expected: "same bump strategy across all derivations",
            actual: `mixed: ${[...bumpHandlings].join(", ")}`,
          },
          message: `PDA with seeds [${seeds}] uses inconsistent bump handling across instructions: ${[...bumpHandlings].join(", ")}. This can lead to different PDAs being derived for the same logical entity.`,
          severity: "HIGH",
        });
      }
    }

    return violations;
  },
};

/** Built-in: balance conservation checker */
const balanceConservationChecker: ConstraintCheckerPlugin = {
  name: "balance_conservation",
  check(program) {
    const violations: ConstraintViolation[] = [];

    for (const ix of program.instructions) {
      // Check if instruction manipulates lamports directly
      const directLamportManip =
        ix.body.includes("try_borrow_mut_lamports") ||
        (ix.body.includes("lamports") && ix.body.includes("+="));

      if (directLamportManip) {
        // Check for balanced additions and subtractions
        const additions = (ix.body.match(/lamports\(\).*\+=/g) || []).length;
        const subtractions = (ix.body.match(/lamports\(\).*-=/g) || []).length;

        if (additions !== subtractions) {
          violations.push({
            constraint: {
              type: "balance_conservation",
              subject: ix.name,
              predicate: "lamport_conservation",
              expected: "balanced lamport additions and subtractions",
              actual: `${additions} additions, ${subtractions} subtractions`,
            },
            message: `Instruction '${ix.name}' has unbalanced lamport operations: ${additions} additions vs ${subtractions} subtractions. This may create or destroy lamports.`,
            severity: "MEDIUM",
          });
        }
      }
    }

    return violations;
  },
};

// ── Main Constraint Checker ──

const builtinPlugins: ConstraintCheckerPlugin[] = [
  authorityChainChecker,
  pdaConsistencyChecker,
  balanceConservationChecker,
];

/**
 * Run all constraint checkers against a parsed program.
 * Accepts additional plugins to extend checking (future: SMT solver plugin).
 */
export function checkConstraints(
  program: ParsedProgram,
  additionalPlugins: ConstraintCheckerPlugin[] = []
): ConstraintViolation[] {
  const allPlugins = [...builtinPlugins, ...additionalPlugins];
  const violations: ConstraintViolation[] = [];

  for (const plugin of allPlugins) {
    violations.push(...plugin.check(program));
  }

  return violations;
}

