/**
 * Cross-file resolver.
 *
 * Links:
 * - Instructions to their Accounts structs via Context<T> type parameter
 * - Sinks to the instruction they belong to
 * - PDA derivations from constraints to their instruction context
 */

import type {
  InstructionV2,
  AccountStructV2,
  SinkV2,
  PDADerivationV2,
  CPICallV2,
} from "../types";

export interface ResolvedProgram {
  instructions: InstructionV2[];
  accountStructs: AccountStructV2[];
  sinks: SinkV2[];
  cpiCalls: CPICallV2[];
  pdaDerivations: PDADerivationV2[];
}

/**
 * Resolve cross-references between instructions, account structs, sinks, and PDAs.
 */
export function resolveReferences(
  instructions: InstructionV2[],
  accountStructs: AccountStructV2[],
  sinks: SinkV2[],
  cpiCalls: CPICallV2[],
  pdaDerivations: PDADerivationV2[],
): ResolvedProgram {
  // Build lookup: struct name → AccountStructV2
  const structMap = new Map<string, AccountStructV2>();
  for (const s of accountStructs) {
    structMap.set(s.name, s);
  }

  // Link sinks to instructions by matching sink.instruction name
  const sinksByInstruction = new Map<string, number[]>();
  for (const sink of sinks) {
    const list = sinksByInstruction.get(sink.instruction) || [];
    list.push(sink.id);
    sinksByInstruction.set(sink.instruction, list);
  }

  // Resolve each instruction's sinkRefs and accountsTypeName
  for (const ix of instructions) {
    // Assign sink refs
    ix.sinkRefs = sinksByInstruction.get(ix.name) || [];

    // Verify Context<T> type links to a known struct
    if (ix.accountsTypeName && !structMap.has(ix.accountsTypeName)) {
      // Try fuzzy match (sometimes structs have generic params stripped)
      const fuzzy = accountStructs.find((s) =>
        s.name.startsWith(ix.accountsTypeName!) ||
        ix.accountsTypeName!.startsWith(s.name),
      );
      if (fuzzy) {
        ix.accountsTypeName = fuzzy.name;
      }
    }
  }

  // Resolve PDA constraint derivations: map struct name → instruction name
  for (const pda of pdaDerivations) {
    if (pda.source === "constraint") {
      // pda.instruction is currently the struct name, resolve to actual instruction
      const matchingIx = instructions.find((ix) => ix.accountsTypeName === pda.instruction);
      if (matchingIx) {
        pda.instruction = matchingIx.name;
      }
    }
  }

  return {
    instructions,
    accountStructs,
    sinks,
    cpiCalls,
    pdaDerivations,
  };
}

/**
 * Get the AccountStructV2 for a given instruction (via Context<T>).
 */
export function getAccountsForInstruction(
  ix: InstructionV2,
  structs: AccountStructV2[],
): AccountStructV2 | undefined {
  if (!ix.accountsTypeName) return undefined;
  return structs.find((s) => s.name === ix.accountsTypeName);
}
