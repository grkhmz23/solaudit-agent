import { describe, it, expect, beforeAll } from "vitest";
import { parseRepoV2 } from "../src/v2/parser/index";
import { parseAccountConstraints } from "../src/v2/parser/ast-extract";
import type { ParsedProgramV2 } from "../src/v2/types";
import { resolve } from "path";

const FIXTURE_DIR = resolve(__dirname, "fixtures/sample-anchor/programs/sample");

describe("V2 Parser: tree-sitter Rust", () => {
  let program: ParsedProgramV2;

  beforeAll(async () => {
    program = await parseRepoV2(FIXTURE_DIR);
  });

  describe("Program metadata", () => {
    it("detects Anchor framework", () => {
      expect(program.framework).toBe("anchor");
    });

    it("extracts program name from Cargo.toml", () => {
      expect(program.name).toBe("sample-vault");
    });

    it("extracts program ID from declare_id!", () => {
      expect(program.programId).toBe("SAMPLExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    });

    it("finds the .rs file", () => {
      expect(program.files.length).toBeGreaterThanOrEqual(1);
      expect(program.files[0].path).toContain("lib.rs");
    });

    it("completes without errors", () => {
      expect(program.parseErrors).toEqual([]);
    });
  });

  describe("Instruction extraction", () => {
    it("finds all 5 instructions", () => {
      const names = program.instructions.map((i) => i.name);
      expect(names).toContain("initialize");
      expect(names).toContain("deposit");
      expect(names).toContain("withdraw");
      expect(names).toContain("update_price");
      expect(names).toContain("reinit_vault");
    });

    it("extracts Context<T> type for each instruction", () => {
      const init = program.instructions.find((i) => i.name === "initialize");
      expect(init?.accountsTypeName).toBe("Initialize");

      const deposit = program.instructions.find((i) => i.name === "deposit");
      expect(deposit?.accountsTypeName).toBe("Deposit");

      const withdraw = program.instructions.find((i) => i.name === "withdraw");
      expect(withdraw?.accountsTypeName).toBe("Withdraw");
    });

    it("extracts function parameters (excluding ctx)", () => {
      const init = program.instructions.find((i) => i.name === "initialize");
      expect(init?.params).toEqual([{ name: "bump", type: "u8" }]);

      const deposit = program.instructions.find((i) => i.name === "deposit");
      expect(deposit?.params).toEqual([{ name: "amount", type: "u64" }]);
    });

    it("includes body excerpt", () => {
      const deposit = program.instructions.find((i) => i.name === "deposit");
      expect(deposit?.bodyExcerpt).toContain("checked_add");
      expect(deposit?.bodyExcerpt).toContain("token::transfer");
    });
  });

  describe("Account struct extraction", () => {
    it("finds all #[derive(Accounts)] structs", () => {
      const accountStructs = program.accountStructs.filter((s) => s.isAccountsDerive);
      const names = accountStructs.map((s) => s.name);
      expect(names).toContain("Initialize");
      expect(names).toContain("Deposit");
      expect(names).toContain("Withdraw");
      expect(names).toContain("UpdatePrice");
      expect(names).toContain("ReinitVault");
    });

    it("finds #[account] state structs", () => {
      const stateStructs = program.accountStructs.filter((s) => !s.isAccountsDerive);
      const names = stateStructs.map((s) => s.name);
      expect(names).toContain("Vault");
      expect(names).toContain("PriceState");
    });

    it("detects hasInit correctly", () => {
      const init = program.accountStructs.find((s) => s.name === "Initialize");
      expect(init?.hasInit).toBe(true);

      const withdraw = program.accountStructs.find((s) => s.name === "Withdraw");
      expect(withdraw?.hasInit).toBe(false);
    });
  });

  describe("Account field constraint parsing", () => {
    it("parses Initialize vault field constraints", () => {
      const init = program.accountStructs.find((s) => s.name === "Initialize");
      const vault = init?.fields.find((f) => f.name === "vault");
      expect(vault).toBeDefined();

      const kinds = vault!.constraints.map((c) => c.kind);
      expect(kinds).toContain("init");
      expect(kinds).toContain("payer");
      expect(kinds).toContain("space");
      expect(kinds).toContain("seeds");
      expect(kinds).toContain("bump");
    });

    it("parses seeds expressions", () => {
      const init = program.accountStructs.find((s) => s.name === "Initialize");
      const vault = init?.fields.find((f) => f.name === "vault");
      const seeds = vault?.constraints.find((c) => c.kind === "seeds");
      expect(seeds?.seedExprs).toBeDefined();
      expect(seeds!.seedExprs!.length).toBeGreaterThanOrEqual(1);
    });

    it("parses Deposit has_one constraint", () => {
      const deposit = program.accountStructs.find((s) => s.name === "Deposit");
      const vault = deposit?.fields.find((f) => f.name === "vault");
      const hasOne = vault?.constraints.find((c) => c.kind === "has_one");
      expect(hasOne).toBeDefined();
      expect(hasOne?.expression).toBe("authority");
    });

    it("detects Signer type correctly", () => {
      const deposit = program.accountStructs.find((s) => s.name === "Deposit");
      const user = deposit?.fields.find((f) => f.name === "user");
      expect(user?.anchorType).toBe("Signer");
      expect(user?.isSigner).toBe(true);
    });

    it("detects UncheckedAccount type", () => {
      const withdraw = program.accountStructs.find((s) => s.name === "Withdraw");
      const auth = withdraw?.fields.find((f) => f.name === "authority");
      expect(auth?.anchorType).toBe("UncheckedAccount");
      expect(auth?.isSigner).toBe(false); // No signer constraint!
    });

    it("detects Program type", () => {
      const init = program.accountStructs.find((s) => s.name === "Initialize");
      const sys = init?.fields.find((f) => f.name === "system_program");
      expect(sys?.anchorType).toBe("Program");
    });
  });

  describe("Sink extraction", () => {
    it("finds token transfer sinks", () => {
      const tokenTransfers = program.sinks.filter((s) => s.type === "token_transfer");
      expect(tokenTransfers.length).toBeGreaterThanOrEqual(2); // deposit + withdraw
    });

    it("associates sinks with correct instructions", () => {
      const depositSinks = program.sinks.filter((s) => s.instruction === "deposit");
      expect(depositSinks.length).toBeGreaterThanOrEqual(1);

      const withdrawSinks = program.sinks.filter((s) => s.instruction === "withdraw");
      expect(withdrawSinks.length).toBeGreaterThanOrEqual(1);
    });

    it("finds state_write sinks", () => {
      const writes = program.sinks.filter((s) => s.type === "state_write");
      expect(writes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("CPI call extraction", () => {
    it("finds CPI calls", () => {
      expect(program.cpiCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("detects CpiContext::new_with_signer in withdraw", () => {
      const withdrawCPI = program.cpiCalls.find(
        (c) => c.instruction === "withdraw" && c.callType.includes("signer"),
      );
      expect(withdrawCPI).toBeDefined();
    });
  });

  describe("PDA derivation extraction", () => {
    it("finds PDA derivations from constraints", () => {
      const constraintPDAs = program.pdaDerivations.filter((p) => p.source === "constraint");
      expect(constraintPDAs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Macro invocation extraction", () => {
    it("finds declare_id! macro", () => {
      const declareId = program.macroInvocations.find((m) => m.name === "declare_id");
      expect(declareId).toBeDefined();
      expect(declareId?.args).toContain("SAMPLE");
    });
  });

  describe("Constants extraction", () => {
    it("finds MAX_DEPOSIT constant", () => {
      const maxDeposit = program.constants.find((c) => c.name === "MAX_DEPOSIT");
      expect(maxDeposit).toBeDefined();
      expect(maxDeposit?.type).toBe("u64");
    });
  });
});

describe("parseAccountConstraints (unit)", () => {
  it("parses simple flags", () => {
    const result = parseAccountConstraints("mut");
    expect(result).toEqual([{ kind: "mut" }]);
  });

  it("parses compound constraints", () => {
    const result = parseAccountConstraints("init, payer = authority, space = 8 + 32");
    expect(result.map((c) => c.kind)).toEqual(["init", "payer", "space"]);
    expect(result.find((c) => c.kind === "payer")?.expression).toBe("authority");
    expect(result.find((c) => c.kind === "space")?.expression).toBe("8 + 32");
  });

  it("parses seeds with nested brackets", () => {
    const result = parseAccountConstraints('seeds = [b"vault", user.key().as_ref()], bump');
    const seeds = result.find((c) => c.kind === "seeds");
    expect(seeds?.seedExprs?.length).toBe(2);
    expect(result.some((c) => c.kind === "bump")).toBe(true);
  });

  it("parses has_one", () => {
    const result = parseAccountConstraints("mut, has_one = authority");
    expect(result.find((c) => c.kind === "has_one")?.expression).toBe("authority");
  });

  it("parses constraint expressions", () => {
    const result = parseAccountConstraints("constraint = authority.key() == state.admin");
    expect(result.find((c) => c.kind === "constraint")?.expression).toBe(
      "authority.key() == state.admin",
    );
  });

  it("parses token constraints", () => {
    const result = parseAccountConstraints("token::authority = authority, token::mint = mint");
    expect(result.find((c) => c.kind === "token_authority")?.expression).toBe("authority");
    expect(result.find((c) => c.kind === "token_mint")?.expression).toBe("mint");
  });
});
