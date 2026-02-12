import type { ParsedProgram, ParsedInstruction, InstructionAccount } from "../types";

export interface AdversarialPermutation {
  instruction: string;
  description: string;
  accounts: Record<string, AccountPermutation>;
  severity: "critical" | "high" | "medium";
}

export interface AccountPermutation {
  original: string;
  substitution: string;
  rationale: string;
}

/**
 * Generate adversarial account-meta permutations for each instruction.
 * Tries substitutions that commonly lead to exploits:
 * - Replacing authority with attacker
 * - Swapping source and destination
 * - Using same account for two parameters
 * - Passing wrong program IDs
 * - Passing uninitialized accounts
 */
export function synthesizeAdversarialAccounts(
  program: ParsedProgram
): AdversarialPermutation[] {
  const permutations: AdversarialPermutation[] = [];

  for (const ix of program.instructions) {
    permutations.push(...generateSignerSubstitutions(ix));
    permutations.push(...generateAccountAliasing(ix));
    permutations.push(...generateProgramSubstitutions(ix, program));
    permutations.push(...generateUninitializedAccounts(ix));
  }

  return permutations;
}

function generateSignerSubstitutions(ix: ParsedInstruction): AdversarialPermutation[] {
  const results: AdversarialPermutation[] = [];

  const signerAccounts = ix.accounts.filter(
    (a) => a.isSigner || a.name.includes("authority") || a.name.includes("owner") || a.name.includes("admin")
  );

  for (const signer of signerAccounts) {
    results.push({
      instruction: ix.name,
      description: `Replace '${signer.name}' signer with attacker-controlled keypair`,
      accounts: {
        [signer.name]: {
          original: signer.name,
          substitution: "attacker_keypair",
          rationale: `If signer verification is missing/weak, attacker gains authority over ${ix.name}`,
        },
      },
      severity: "critical",
    });
  }

  return results;
}

function generateAccountAliasing(ix: ParsedInstruction): AdversarialPermutation[] {
  const results: AdversarialPermutation[] = [];
  const mutAccounts = ix.accounts.filter((a) => a.isMut);

  // Try all pairs
  for (let i = 0; i < mutAccounts.length; i++) {
    for (let j = i + 1; j < mutAccounts.length; j++) {
      results.push({
        instruction: ix.name,
        description: `Alias '${mutAccounts[i].name}' and '${mutAccounts[j].name}' (same account for both)`,
        accounts: {
          [mutAccounts[i].name]: {
            original: mutAccounts[i].name,
            substitution: `same_as_${mutAccounts[j].name}`,
            rationale: "Double-counting, self-transfer, or state corruption if not guarded",
          },
          [mutAccounts[j].name]: {
            original: mutAccounts[j].name,
            substitution: `same_as_${mutAccounts[i].name}`,
            rationale: "Account aliasing test",
          },
        },
        severity: "high",
      });
    }
  }

  return results;
}

function generateProgramSubstitutions(
  ix: ParsedInstruction,
  program: ParsedProgram
): AdversarialPermutation[] {
  const results: AdversarialPermutation[] = [];

  // Check if instruction body references program accounts
  const programAccounts = ix.accounts.filter(
    (a) => a.name.includes("program") || a.type?.includes("Program")
  );

  for (const progAcc of programAccounts) {
    results.push({
      instruction: ix.name,
      description: `Substitute '${progAcc.name}' with malicious program`,
      accounts: {
        [progAcc.name]: {
          original: progAcc.name,
          substitution: "malicious_program_id",
          rationale: "If program ID not validated, CPI goes to attacker's program",
        },
      },
      severity: "critical",
    });
  }

  return results;
}

function generateUninitializedAccounts(ix: ParsedInstruction): AdversarialPermutation[] {
  const results: AdversarialPermutation[] = [];

  const dataAccounts = ix.accounts.filter(
    (a) => !a.name.includes("program") && !a.name.includes("system") && !a.name.includes("rent") && !a.name.includes("clock")
  );

  for (const acc of dataAccounts) {
    results.push({
      instruction: ix.name,
      description: `Pass uninitialized/empty account for '${acc.name}'`,
      accounts: {
        [acc.name]: {
          original: acc.name,
          substitution: "empty_account",
          rationale: "Deserialization of empty data may produce zero/default values that bypass checks",
        },
      },
      severity: "medium",
    });
  }

  return results;
}
