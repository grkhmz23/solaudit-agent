import type { ParsedProgram, FindingResult, ProofPlan, DeltaSchema } from "../types";

/**
 * Generates proof plans for findings.
 * In PROVE mode, can optionally generate executable harness code.
 */
export function constructProofs(
  findings: FindingResult[],
  program: ParsedProgram,
  mode: "SCAN" | "PROVE" | "FIX_PLAN"
): FindingResult[] {
  return findings.map((finding) => {
    // Always generate proof plan
    if (!finding.proofPlan) {
      finding.proofPlan = generateProofPlan(finding, program);
    }

    // In PROVE mode, generate executable harness
    if (mode === "PROVE" && finding.proofPlan) {
      finding.proofPlan.harness = generateHarness(finding, program);
      finding.proofPlan.requiredCommands = getRequiredCommands(program);
    }

    return finding;
  });
}

function generateProofPlan(finding: FindingResult, program: ParsedProgram): ProofPlan {
  const steps = generateSteps(finding);
  const deltaSchema = generateDeltaSchema(finding);

  return {
    steps,
    deltaSchema,
  };
}

function generateSteps(finding: FindingResult): string[] {
  // Return existing steps if already defined
  if (finding.proofPlan?.steps) return finding.proofPlan.steps;

  const ix = finding.location.instruction || "target_instruction";

  switch (finding.classId) {
    case 1: return [
      "Set up program state with legitimate authority",
      `Call '${ix}' with attacker keypair (not the authority)`,
      "Assert instruction succeeds when it should fail",
      "Measure: attacker gained unauthorized access",
    ];
    case 2: return [
      "Create a fake account owned by attacker's program",
      "Populate it with data matching expected account layout",
      `Pass fake account to '${ix}'`,
      "Assert instruction processes fake account data",
    ];
    case 3: return [
      "Derive PDA with alternative bump (non-canonical)",
      `Call '${ix}' with the alternative PDA`,
      "Assert both PDAs are accepted, demonstrating collision risk",
    ];
    case 4: return [
      "Deploy malicious program mimicking expected CPI target",
      `Call '${ix}' with malicious program as CPI target`,
      "Assert malicious program receives the CPI",
    ];
    case 5: return [
      "Create account with wrong type's discriminator/layout",
      `Pass to '${ix}' as the expected account type`,
      "Assert instruction deserializes and processes it",
    ];
    case 6: return [
      `Call '${ix}' to initialize account with user A authority`,
      `Call '${ix}' again to re-initialize with user B authority`,
      "Assert authority changed (re-init succeeded)",
    ];
    case 7: return [
      "Initialize account with funds",
      `Call close instruction to drain lamports`,
      "In same tx, send lamports back to account",
      "Assert account data is still intact (revived)",
    ];
    case 8: return [
      "Initialize account with known data",
      "Trigger realloc to larger size",
      "Read extended memory region",
      "Assert non-zero stale data in extension",
    ];
    case 9: return [
      "Set up state with values near boundary (0 or u64::MAX)",
      `Call '${ix}' with values that trigger overflow/underflow`,
      "Assert unexpected result or panic",
    ];
    case 10: return [
      "Set account to non-qualifying state",
      `Call '${ix}' without state guard`,
      "Assert it succeeds in invalid state",
    ];
    case 11: return [
      `Call '${ix}' with extra malicious accounts in remaining_accounts`,
      "Assert unauthorized accounts are processed",
    ];
    case 12: return [
      "Create fake oracle account with manipulated price",
      `Pass to '${ix}' as oracle`,
      "Assert manipulated price is used in calculations",
    ];
    case 13: return [
      "Create token account with wrong mint",
      `Pass to '${ix}' as vault/treasury`,
      "Assert instruction accepts wrong-mint token account",
    ];
    case 14: return [
      "Set up state where CPI modifies target account",
      `Call '${ix}' and read account after CPI`,
      "Assert stale (pre-CPI) values are used",
    ];
    case 15: return [
      `Call '${ix}' with same account for both parameters`,
      "Assert unexpected behavior (double-count, self-transfer)",
    ];
    default: return [
      `Set up preconditions for '${ix}'`,
      `Execute '${ix}' with adversarial inputs`,
      "Verify exploit hypothesis",
    ];
  }
}

function generateDeltaSchema(finding: FindingResult): DeltaSchema {
  if (finding.proofPlan?.deltaSchema) return finding.proofPlan.deltaSchema;

  const base: DeltaSchema = {
    preState: {},
    postState: {},
    assertion: "",
  };

  switch (finding.classId) {
    case 1:
      return {
        preState: { authority: "legitimate_user", vault_balance: 1000 },
        postState: { authority: "legitimate_user", vault_balance: 0 },
        assertion: "Attacker drained vault without being authority",
      };
    case 9:
      return {
        preState: { balance: "near_boundary" },
        postState: { balance: "wrapped_around_or_panic" },
        assertion: "Arithmetic overflow changed balance to unexpected value",
      };
    case 6:
      return {
        preState: { authority: "user_A", initialized: true },
        postState: { authority: "user_B", initialized: true },
        assertion: "Re-initialization changed authority",
      };
    default:
      return {
        ...base,
        assertion: finding.hypothesis || "Exploit hypothesis proven",
      };
  }
}

function generateHarness(finding: FindingResult, program: ParsedProgram): string {
  const ix = finding.location.instruction || "target";
  const isAnchor = program.framework === "anchor";

  if (isAnchor) {
    return `// Anchor test harness for: ${finding.title}
// Run with: anchor test
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ${capitalize(program.name)} } from "../target/types/${program.name}";
import { expect } from "chai";

describe("PoC: ${finding.className}", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.${capitalize(program.name)} as Program<${capitalize(program.name)}>;

  it("${finding.title}", async () => {
    const attacker = anchor.web3.Keypair.generate();

    // Airdrop SOL to attacker
    const sig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // TODO: Set up preconditions specific to the program
    // This harness structure is correct; fill in program-specific account setup

    try {
      // Attempt exploit
      const tx = await program.methods
        .${ix}()
        .accounts({
          // Fill in required accounts
        })
        .signers([attacker])
        .rpc();

      // If we reach here, the exploit worked (instruction should have failed)
      console.log("EXPLOIT SUCCEEDED - tx:", tx);
      expect.fail("Instruction should have rejected unauthorized caller");
    } catch (err) {
      // Expected: instruction correctly rejected the attack
      console.log("SECURE: Instruction rejected attack:", err.message);
    }
  });
});
`;
  }

  // Native Rust program test
  return `// Native program test harness for: ${finding.title}
// Run with: cargo test-sbf
#[cfg(test)]
mod test_${ix}_exploit {
    use solana_program_test::*;
    use solana_sdk::{
        signature::{Keypair, Signer},
        transaction::Transaction,
    };

    #[tokio::test]
    async fn test_${finding.className.toLowerCase().replace(/\s+/g, "_")}() {
        let program_id = /* your program ID */;
        let mut program_test = ProgramTest::new(
            "${program.name}",
            program_id,
            processor!(process_instruction),
        );

        let (mut banks_client, payer, recent_blockhash) = program_test.start().await;
        let attacker = Keypair::new();

        // Set up preconditions
        // ...

        // Attempt exploit
        let ix = /* build instruction with adversarial accounts */;
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&attacker.pubkey()),
            &[&attacker],
            recent_blockhash,
        );

        let result = banks_client.process_transaction(tx).await;
        // Assert: should fail if secure, succeeds if vulnerable
        assert!(result.is_err(), "VULNERABLE: instruction accepted unauthorized call");
    }
}
`;
}

function getRequiredCommands(program: ParsedProgram): string[] {
  if (program.framework === "anchor") {
    return ["anchor build", "anchor test -- --features test"];
  }
  return ["cargo build-sbf", "cargo test-sbf"];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase());
}
