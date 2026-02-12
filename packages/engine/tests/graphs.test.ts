import { describe, it, expect } from "vitest";
import {
  buildAuthorityFlowGraph,
  buildTokenFlowGraph,
  buildStateMachineGraph,
  buildPDAGraph,
} from "../src/graphs";
import type { ParsedProgram } from "../src/types";

function makeProgram(overrides: Partial<ParsedProgram> = {}): ParsedProgram {
  return {
    name: "test-program",
    framework: "anchor",
    files: [],
    instructions: [],
    accounts: [],
    cpiCalls: [],
    pdaDerivations: [],
    errorCodes: [],
    ...overrides,
  };
}

describe("Authority Flow Graph", () => {
  it("creates nodes for signers and their controlled accounts", () => {
    const program = makeProgram({
      instructions: [
        {
          name: "transfer",
          file: "lib.rs",
          line: 10,
          endLine: 30,
          body: "",
          accounts: [
            { name: "authority", isSigner: true, isMut: false, constraints: [] },
            { name: "vault", isSigner: false, isMut: true, constraints: [] },
          ],
          signerChecks: ["authority"],
          ownerChecks: [],
          cpiCalls: [],
          arithmeticOps: [],
        },
      ],
    });

    const graph = buildAuthorityFlowGraph(program);
    expect(graph.name).toBe("Authority Flow");
    expect(graph.nodes.length).toBeGreaterThan(0);
    // Should have signer node
    expect(graph.nodes.some((n) => n.type === "signer")).toBe(true);
  });

  it("returns empty graph for no instructions", () => {
    const graph = buildAuthorityFlowGraph(makeProgram());
    expect(graph.nodes.length).toBe(0);
    expect(graph.edges.length).toBe(0);
  });
});

describe("Token Flow Graph", () => {
  it("creates nodes for token-related CPI calls", () => {
    const program = makeProgram({
      cpiCalls: [
        {
          file: "lib.rs",
          line: 25,
          instruction: "transfer",
          targetProgram: "token_program",
          programValidated: true,
          accountsAfterCPI: [],
        },
      ],
      instructions: [
        {
          name: "do_transfer",
          file: "lib.rs",
          line: 20,
          endLine: 40,
          body: "token::transfer(ctx, amount)?;",
          accounts: [
            { name: "from", isSigner: false, isMut: true, constraints: [] },
            { name: "to", isSigner: false, isMut: true, constraints: [] },
          ],
          signerChecks: [],
          ownerChecks: [],
          cpiCalls: ["transfer"],
          arithmeticOps: [],
        },
      ],
    });

    const graph = buildTokenFlowGraph(program);
    expect(graph.name).toBe("Token Flow");
    expect(graph.nodes.length).toBeGreaterThan(0);
  });
});

describe("State Machine Graph", () => {
  it("creates state nodes from account fields", () => {
    const program = makeProgram({
      accounts: [
        {
          name: "Escrow",
          file: "lib.rs",
          line: 5,
          fields: [
            { name: "status", type: "EscrowStatus", line: 6 },
            { name: "amount", type: "u64", line: 7 },
          ],
          hasInitCheck: true,
          hasCloseHandler: false,
        },
      ],
      instructions: [
        {
          name: "fund_escrow",
          file: "lib.rs",
          line: 20,
          endLine: 40,
          body: "escrow.status = EscrowStatus::Funded;",
          accounts: [],
          signerChecks: [],
          ownerChecks: [],
          cpiCalls: [],
          arithmeticOps: [],
        },
      ],
    });

    const graph = buildStateMachineGraph(program);
    expect(graph.name).toBe("State Machine");
    expect(graph.nodes.length).toBeGreaterThan(0);
  });
});

describe("PDA Graph", () => {
  it("creates nodes for PDA derivations", () => {
    const program = makeProgram({
      pdaDerivations: [
        {
          file: "lib.rs",
          line: 15,
          seeds: ["vault", "user_pubkey"],
          bumpHandling: "canonical",
          instruction: "init_vault",
        },
        {
          file: "lib.rs",
          line: 30,
          seeds: ["escrow", "order_id"],
          bumpHandling: "unchecked",
          instruction: "init_escrow",
        },
      ],
    });

    const graph = buildPDAGraph(program);
    expect(graph.name).toBe("PDA Derivations");
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty graph for no PDAs", () => {
    const graph = buildPDAGraph(makeProgram());
    expect(graph.nodes.length).toBe(0);
  });
});
