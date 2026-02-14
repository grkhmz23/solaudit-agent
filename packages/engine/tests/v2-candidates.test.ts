import { describe, it, expect, beforeAll } from "vitest";
import { parseRepoV2 } from "../src/v2/parser/index";
import { generateCandidates } from "../src/v2/analyzer/candidates";
import type { ParsedProgramV2, VulnCandidate } from "../src/v2/types";
import { resolve } from "path";

const FIXTURE_DIR = resolve(
  __dirname,
  "fixtures/anchor-basic/programs/basic",
);

describe("V2 Candidate Generator", () => {
  let program: ParsedProgramV2;
  let candidates: VulnCandidate[];

  beforeAll(async () => {
    program = await parseRepoV2(FIXTURE_DIR);
    candidates = generateCandidates(program);
  });

  it("parses the fixture successfully", () => {
    expect(program.framework).toBe("anchor");
    expect(program.instructions.length).toBeGreaterThanOrEqual(3);
  });

  it("generates candidates", () => {
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("detects missing signer in Withdraw (authority is AccountInfo, not Signer)", () => {
    const withdrawSigner = candidates.find(
      (c) =>
        c.instruction === "withdraw" &&
        (c.vulnClass === "missing_signer" || c.vulnClass === "missing_owner"),
    );
    expect(withdrawSigner).toBeDefined();
    expect(["CRITICAL", "HIGH"]).toContain(withdrawSigner!.severity);
  });

  it("detects integer overflow in compute_fee", () => {
    const overflow = candidates.find(
      (c) =>
        c.instruction === "compute_fee" && c.vulnClass === "integer_overflow",
    );
    expect(overflow).toBeDefined();
  });

  it("does NOT flag deposit as missing signer (it has Signer<'info>)", () => {
    const depositMissingSigner = candidates.find(
      (c) =>
        c.instruction === "deposit" &&
        c.vulnClass === "missing_signer" &&
        c.severity === "CRITICAL",
    );
    // deposit has depositor: Signer<'info>, should NOT be CRITICAL missing_signer
    expect(depositMissingSigner).toBeUndefined();
  });

  it("each candidate has required fields", () => {
    for (const c of candidates) {
      expect(c.id).toBeTypeOf("number");
      expect(c.vulnClass).toBeTypeOf("string");
      expect(c.severity).toBeTypeOf("string");
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      expect(c.instruction).toBeTypeOf("string");
      expect(c.ref.file).toBeTypeOf("string");
      expect(c.ref.startLine).toBeGreaterThan(0);
      expect(c.fingerprint).toBeTypeOf("string");
      expect(c.reason.length).toBeGreaterThan(10);
    }
  });

  it("candidates are sorted by severity × confidence", () => {
    const weights: Record<string, number> = {
      CRITICAL: 100,
      HIGH: 75,
      MEDIUM: 50,
      LOW: 25,
      INFO: 10,
    };
    for (let i = 1; i < candidates.length; i++) {
      const prev = weights[candidates[i - 1].severity] * candidates[i - 1].confidence;
      const curr = weights[candidates[i].severity] * candidates[i].confidence;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it("candidates are deduplicated (no duplicate fingerprints)", () => {
    const fps = candidates.map((c) => c.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });
});
