import { describe, it, expect } from "vitest";
import { ALL_DETECTORS } from "../src/detectors";
import type { ParsedProgram, ParsedInstruction, ParsedAccountStruct, PDADerivation, CPICall, ArithmeticOp } from "../src/types";

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

function makeInstruction(overrides: Partial<ParsedInstruction> = {}): ParsedInstruction {
  return {
    name: "test_ix",
    file: "programs/test/src/lib.rs",
    line: 10,
    endLine: 30,
    body: "",
    accounts: [],
    signerChecks: [],
    ownerChecks: [],
    cpiCalls: [],
    arithmeticOps: [],
    ...overrides,
  };
}

function makeAccountStruct(overrides: Partial<ParsedAccountStruct> = {}): ParsedAccountStruct {
  return {
    name: "TestAccount",
    file: "programs/test/src/lib.rs",
    line: 5,
    fields: [],
    hasInitCheck: false,
    hasCloseHandler: false,
    ...overrides,
  };
}

describe("Detector registry", () => {
  it("should have 15 detectors", () => {
    expect(ALL_DETECTORS.length).toBe(15);
  });

  it("each detector has unique id", () => {
    const ids = ALL_DETECTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(15);
  });

  it("each detector has a name", () => {
    for (const d of ALL_DETECTORS) {
      expect(d.name).toBeTruthy();
    }
  });
});

describe("Detector 1: Missing Signer Check", () => {
  const detector = ALL_DETECTORS.find((d) => d.id === 1)!;

  it("flags mutable account without signer check", () => {
    const program = makeProgram({
      instructions: [
        makeInstruction({
          name: "transfer",
          accounts: [
            { name: "authority", isSigner: false, isMut: true, constraints: [] },
            { name: "vault", isSigner: false, isMut: true, constraints: [] },
          ],
          signerChecks: [],
        }),
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].classId).toBe(1);
    expect(findings[0].severity).toBe("CRITICAL");
  });

  it("does not flag when signer check exists", () => {
    const program = makeProgram({
      instructions: [
        makeInstruction({
          name: "transfer",
          accounts: [
            { name: "authority", isSigner: true, isMut: true, constraints: ["signer"] },
          ],
          signerChecks: ["authority"],
        }),
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBe(0);
  });
});

describe("Detector 2: Missing Owner Check", () => {
  const detector = ALL_DETECTORS.find((d) => d.id === 2)!;

  it("flags deserialized account without owner validation", () => {
    const program = makeProgram({
      framework: "native",
      instructions: [
        makeInstruction({
          name: "process",
          accounts: [
            { name: "data_account", isSigner: false, isMut: true, constraints: [] },
          ],
          ownerChecks: [],
          body: "let data = Account::unpack(&account.data.borrow())?;",
        }),
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].classId).toBe(2);
  });
});

describe("Detector 3: PDA Derivation Mistakes", () => {
  const detector = ALL_DETECTORS.find((d) => d.id === 3)!;

  it("flags PDA with missing bump handling", () => {
    const program = makeProgram({
      pdaDerivations: [
        {
          file: "lib.rs",
          line: 20,
          seeds: ["prefix"],
          bumpHandling: "missing",
          instruction: "init_vault",
        },
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe("HIGH");
  });

  it("does not flag canonical bump", () => {
    const program = makeProgram({
      pdaDerivations: [
        {
          file: "lib.rs",
          line: 20,
          seeds: ["prefix", "user_key"],
          bumpHandling: "canonical",
          instruction: "init_vault",
        },
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBe(0);
  });
});

describe("Detector 6: Reinitialization", () => {
  const detector = ALL_DETECTORS.find((d) => d.id === 6)!;

  it("flags account struct without init check", () => {
    const program = makeProgram({
      accounts: [
        makeAccountStruct({
          name: "VaultState",
          hasInitCheck: false,
          fields: [{ name: "is_initialized", type: "bool", line: 6 }],
        }),
      ],
      instructions: [
        makeInstruction({
          name: "initialize",
          body: "ctx.accounts.vault.is_initialized = true;",
        }),
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].classId).toBe(6);
  });
});

describe("Detector 9: Integer Overflow", () => {
  const detector = ALL_DETECTORS.find((d) => d.id === 9)!;

  it("flags unchecked arithmetic", () => {
    const program = makeProgram({
      instructions: [
        makeInstruction({
          name: "deposit",
          arithmeticOps: [
            { file: "lib.rs", line: 42, op: "+", checked: false },
          ],
        }),
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].classId).toBe(9);
    expect(findings[0].severity).toBe("HIGH");
  });

  it("does not flag checked arithmetic", () => {
    const program = makeProgram({
      instructions: [
        makeInstruction({
          name: "deposit",
          arithmeticOps: [
            { file: "lib.rs", line: 42, op: "+", checked: true },
          ],
        }),
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBe(0);
  });
});

describe("Detector 14: Post-CPI Stale Reads", () => {
  const detector = ALL_DETECTORS.find((d) => d.id === 14)!;

  it("flags CPI calls with accounts used after without reload", () => {
    const program = makeProgram({
      cpiCalls: [
        {
          file: "lib.rs",
          line: 50,
          instruction: "transfer",
          targetProgram: "token_program",
          programValidated: true,
          accountsAfterCPI: ["vault_balance"],
        },
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].classId).toBe(14);
  });

  it("does not flag when no accounts read after CPI", () => {
    const program = makeProgram({
      cpiCalls: [
        {
          file: "lib.rs",
          line: 50,
          instruction: "transfer",
          targetProgram: "token_program",
          programValidated: true,
          accountsAfterCPI: [],
        },
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBe(0);
  });
});

describe("Detector 15: Duplicate Account Injection", () => {
  const detector = ALL_DETECTORS.find((d) => d.id === 15)!;

  it("flags instructions with aliasable accounts", () => {
    const program = makeProgram({
      instructions: [
        makeInstruction({
          name: "swap",
          accounts: [
            { name: "source", isSigner: false, isMut: true, constraints: [] },
            { name: "destination", isSigner: false, isMut: true, constraints: [] },
          ],
          body: "// no key inequality check",
        }),
      ],
    });

    const findings = detector.detect(program);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].classId).toBe(15);
  });
});
