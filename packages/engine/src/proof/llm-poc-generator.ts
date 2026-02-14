/**
 * LLM-Powered PoC Generator — Priority 1 for Superteam Bounty
 *
 * Uses Kimi K2.5 to generate realistic, program-specific proof-of-concept
 * test harnesses for each critical/high finding.
 *
 * Output: { findingTitle, framework, testCode, reproSteps, stateComparison }
 * These get included in the PR commit as test files and referenced in the advisory.
 *
 * The generator does NOT execute tests (no anchor CLI on Replit). It produces
 * well-formed, runnable test files that reviewers can execute locally.
 */

import type { FindingResult, ParsedProgram } from "../types";
import type { CodePatch } from "../remediation/patcher";
import type { EnrichedFinding } from "../llm/analyzer";

// ─── Config ─────────────────────────────────────────────────

// Provider selection: POC_PROVIDER=auto|kimi_code|moonshot
// "auto" (default): prefers Kimi Code if KIMI_CODE_API_KEY is set, else Moonshot.

type PocProvider = "kimi_code" | "moonshot";

function resolvePocProvider(): PocProvider {
  const explicit = process.env.POC_PROVIDER?.toLowerCase();
  if (explicit === "kimi_code" || explicit === "moonshot") return explicit;
  // auto: prefer Kimi Code (separate rate-limit pool from analyzer's Moonshot)
  return process.env.KIMI_CODE_API_KEY ? "kimi_code" : "moonshot";
}

function getPocApiUrl(): string {
  return resolvePocProvider() === "kimi_code"
    ? "https://api.kimi.com/coding/v1/chat/completions"
    : "https://api.moonshot.ai/v1/chat/completions";
}

function getPocApiKey(): string | null {
  const provider = resolvePocProvider();
  if (provider === "kimi_code") return process.env.KIMI_CODE_API_KEY || null;
  return process.env.MOONSHOT_API_KEY || null;
}

function getPocModel(): string {
  return process.env.LLM_POC_MODEL || process.env.MOONSHOT_MODEL || "kimi-k2.5";
}

const POC_CFG = {
  maxTokens: safeInt("LLM_POC_MAX_TOKENS", 4096),
  timeoutMs: safeInt("LLM_POC_TIMEOUT_MS", 120_000),
  retries: safeInt("LLM_POC_RETRIES", 2),
  concurrency: safeInt("LLM_POC_CONCURRENCY", 1), // sequential: avoids rate-limit storms
  maxPocs: safeInt("LLM_POC_MAX", 10),
  interRequestDelayMs: safeInt("LLM_POC_DELAY_MS", 2000), // cooldown between calls
};

function safeInt(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// ─── Types ──────────────────────────────────────────────────

export interface GeneratedPoC {
  findingTitle: string;
  classId: number;
  severity: string;
  framework: "anchor" | "native";
  testCode: string;
  fileName: string;
  reproSteps: string[];
  stateComparison: {
    preState: string;
    postState: string;
    assertion: string;
  };
  runCommand: string;
  status: "generated" | "fallback" | "error";
}

// ─── LLM Call (shared pattern with analyzer.ts) ─────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = getPocApiKey();
  const provider = resolvePocProvider();
  const apiName = provider === "kimi_code" ? "Kimi Code" : "Moonshot";
  if (!apiKey) throw new Error(`${apiName} API key not set (POC_PROVIDER=${provider})`);

  const apiUrl = getPocApiUrl();
  const model = getPocModel();
  let maxTokens = POC_CFG.maxTokens;

  for (let attempt = 0; attempt <= POC_CFG.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POC_CFG.timeoutMs);

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // ── Retryable: 429 (rate-limit) and 5xx (server error) ──
      if (res.status === 429 || res.status >= 500) {
        const delay = 3000 * Math.pow(2, attempt);
        console.warn(`[poc-gen] ${apiName} ${res.status}, retry ${attempt + 1}/${POC_CFG.retries + 1} in ${delay}ms`);
        if (attempt < POC_CFG.retries) {
          await sleep(delay);
          continue;
        }
        const body = await res.text().catch(() => "");
        throw new Error(`${apiName} ${res.status}: ${body.slice(0, 300)}`);
      }

      // ── 400: only retry if transient; fail fast otherwise ──
      if (res.status === 400) {
        const body = await res.text().catch(() => "");
        const lower = body.toLowerCase();

        // Transient signals (some providers send 400 for rate-limits)
        const transient = ["rate limit", "overloaded", "try again", "temporarily", "throttl"];
        if (transient.some((t) => lower.includes(t)) && attempt < POC_CFG.retries) {
          const delay = 3000 * Math.pow(2, attempt);
          console.warn(`[poc-gen] ${apiName} 400 (transient), retry ${attempt + 1}/${POC_CFG.retries + 1} in ${delay}ms`);
          await sleep(delay);
          continue;
        }

        // Token-limit error: downshift max_tokens and retry once
        if ((lower.includes("max_tokens") || lower.includes("context length") || lower.includes("too many tokens"))
            && attempt < POC_CFG.retries && maxTokens > 2048) {
          maxTokens = Math.floor(maxTokens / 2);
          console.warn(`[poc-gen] ${apiName} 400 (token limit), downshifting max_tokens to ${maxTokens}`);
          await sleep(1000);
          continue;
        }

        // Deterministic error: fail fast (invalid model, bad params, etc.)
        throw new Error(`${apiName} 400 (deterministic): ${body.slice(0, 300)}`);
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${apiName} ${res.status}: ${body}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        if (attempt < POC_CFG.retries) {
          await sleep(1000);
          continue;
        }
        throw new Error("Empty response after retries");
      }
      return content;
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        console.warn(`[poc-gen] Timeout (${attempt + 1}/${POC_CFG.retries + 1})`);
        if (attempt < POC_CFG.retries) continue;
        throw new Error("PoC LLM call timed out");
      }
      if (attempt < POC_CFG.retries) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      throw e;
    }
  }
  throw new Error("PoC LLM call failed after retries");
}

// ─── JSON Parsing ───────────────────────────────────────────

function robustParseJSON(raw: string): any {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  try { return JSON.parse(cleaned); } catch {}

  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}

    let repaired = braceMatch[0];
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) repaired += '"';

    let openBraces = 0, openBrackets = 0, inString = false;
    for (let i = 0; i < repaired.length; i++) {
      const c = repaired[i];
      if (c === '"' && (i === 0 || repaired[i - 1] !== "\\")) inString = !inString;
      if (!inString) {
        if (c === "{") openBraces++;
        else if (c === "}") openBraces--;
        else if (c === "[") openBrackets++;
        else if (c === "]") openBrackets--;
      }
    }
    repaired = repaired.replace(/,\s*$/, "");
    for (let i = 0; i < openBrackets; i++) repaired += "]";
    for (let i = 0; i < openBraces; i++) repaired += "}";
    try { return JSON.parse(repaired); } catch {}
  }

  return null;
}

// ─── Concurrency Limiter ────────────────────────────────────

function pLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;
  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      queue.shift()!();
    }
  }
  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => { active--; next(); });
      });
      next();
    });
  };
}

// ─── Core: Generate PoC for a single finding ────────────────

const ANCHOR_POC_SYSTEM = `You are an expert Solana security researcher writing proof-of-concept exploit tests.
You MUST output ONLY minified JSON with these exact keys:
{
  "test_code": "<complete TypeScript Anchor test file>",
  "repro_steps": ["step1", "step2", ...],
  "pre_state": "<description of program state before exploit>",
  "post_state": "<description of program state after exploit>",
  "assertion": "<what the test proves>"
}

Rules for the test code:
- Write a COMPLETE, RUNNABLE Anchor test file (.ts)
- Import from @coral-xyz/anchor and @solana/web3.js
- Use describe/it blocks with Mocha
- The describe block MUST start with "PoC#" followed by the class ID, e.g. describe("PoC#42: missing_signer", ...)
- Create realistic account setup (PDAs, token accounts, keypairs)
- Show the EXACT exploit path: what the attacker does, which accounts are passed
- The test should SUCCEED if the vulnerability exists (proving it's exploitable)
- Include comments explaining each step of the exploit
- Handle airdrop for test wallets
- Use realistic instruction names from the target program
- NO placeholders, NO TODOs — every line must be real code
- If you don't know the exact account layout, use the instruction/account info provided to make a best-effort realistic test`;

const NATIVE_POC_SYSTEM = `You are an expert Solana security researcher writing proof-of-concept exploit tests.
You MUST output ONLY minified JSON with these exact keys:
{
  "test_code": "<complete Rust test using solana-program-test>",
  "repro_steps": ["step1", "step2", ...],
  "pre_state": "<description of program state before exploit>",
  "post_state": "<description of program state after exploit>",
  "assertion": "<what the test proves>"
}

Rules for the test code:
- Write a COMPLETE Rust test module using solana_program_test
- Include all necessary imports
- Create realistic account setup
- Show the EXACT exploit path
- The test should demonstrate the vulnerability exists
- Include comments explaining each step
- NO placeholders, NO TODOs
- Use the program name and instruction info provided`;

async function generateSinglePoC(
  finding: FindingResult,
  program: ParsedProgram,
  enriched?: EnrichedFinding,
  patch?: CodePatch,
): Promise<GeneratedPoC> {
  const isAnchor = program.framework === "anchor";
  const system = isAnchor ? ANCHOR_POC_SYSTEM : NATIVE_POC_SYSTEM;

  const capitalize = (s: string) =>
    s.charAt(0).toUpperCase() + s.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase());

  // Build context about the specific finding
  const accountInfo = program.instructions
    .filter((ix) => ix.name === finding.location.instruction || ix.file === finding.location.file)
    .map((ix) => {
      const accts = ix.accounts
        .map((a) => `  - ${a.name}: ${a.type || "AccountInfo"} (signer=${a.isSigner}, mut=${a.isMut})${a.constraints.length ? ` constraints=[${a.constraints.join(",")}]` : ""}`)
        .join("\n");
      return `Instruction "${ix.name}" (${ix.file}:${ix.line}):\n  Accounts:\n${accts}\n  Signer checks: [${ix.signerChecks.join(", ")}]\n  Owner checks: [${ix.ownerChecks.join(", ")}]`;
    })
    .join("\n\n");

  // Get relevant source code snippet
  const sourceFile = program.files.find((f) => f.path === finding.location.file);
  const codeSnippet = sourceFile
    ? sourceFile.lines
        .slice(Math.max(0, finding.location.line - 10), (finding.location.endLine || finding.location.line) + 10)
        .join("\n")
    : "(source not available)";

  const user = `Target program: "${program.name}" (${isAnchor ? "Anchor" : "Native"} framework)
${program.programId ? `Program ID: ${program.programId}` : ""}
TypeScript type import: ${isAnchor ? `import { ${capitalize(program.name)} } from "../target/types/${program.name}"` : "N/A"}

Vulnerability: [${finding.severity}] #${finding.classId} ${finding.className}
Title: ${finding.title}
Location: ${finding.location.file}:${finding.location.line}${finding.location.instruction ? ` @ ${finding.location.instruction}` : ""}
Confidence: ${(finding.confidence * 100).toFixed(0)}%
Hypothesis: ${finding.hypothesis || "N/A"}

${enriched ? `LLM Analysis:
- Impact: ${enriched.impact}
- Exploitability: ${enriched.exploitability}
- Proof Plan: ${enriched.proofPlan.join(" → ")}` : ""}

${patch ? `Patch applied: ${patch.description}\nDiff:\n${patch.diff.slice(0, 1000)}` : ""}

${finding.proofPlan?.steps ? `Proof steps:\n${finding.proofPlan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}

${finding.proofPlan?.deltaSchema ? `Expected state delta:
- Pre: ${JSON.stringify(finding.proofPlan.deltaSchema.preState)}
- Post: ${JSON.stringify(finding.proofPlan.deltaSchema.postState)}
- Assert: ${finding.proofPlan.deltaSchema.assertion}` : ""}

${accountInfo ? `Program structure:\n${accountInfo}` : ""}

Source code around the vulnerability:
\`\`\`rust
${codeSnippet.slice(0, 2000)}
\`\`\`

Write a complete, runnable PoC test that demonstrates this vulnerability is exploitable.`;

  const safeName = (finding.location.instruction || finding.className || "test")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 40);

  const fileName = isAnchor
    ? `tests/poc_${finding.classId}_${safeName}.ts`
    : `tests/poc_${finding.classId}_${safeName}.rs`;

  try {
    const raw = await callLLM(system, user);
    const parsed = robustParseJSON(raw);

    if (parsed?.test_code && typeof parsed.test_code === "string" && parsed.test_code.length > 50) {
      const reproSteps = Array.isArray(parsed.repro_steps)
        ? parsed.repro_steps.map(String).slice(0, 8)
        : finding.proofPlan?.steps || ["Deploy program", "Run exploit test", "Verify state change"];

      return {
        findingTitle: finding.title,
        classId: finding.classId,
        severity: finding.severity,
        framework: isAnchor ? "anchor" : "native",
        testCode: parsed.test_code,
        fileName,
        reproSteps,
        stateComparison: {
          preState: String(parsed.pre_state || finding.proofPlan?.deltaSchema?.preState || "Initial valid state"),
          postState: String(parsed.post_state || finding.proofPlan?.deltaSchema?.postState || "Corrupted/exploited state"),
          assertion: String(parsed.assertion || finding.proofPlan?.deltaSchema?.assertion || "Vulnerability exploitable"),
        },
        runCommand: isAnchor
          ? `cd <repo> && anchor test -- --grep "PoC#${finding.classId}"`
          : `cd <repo> && cargo test-sbf poc_${finding.classId}_${safeName}`,
        status: "generated",
      };
    }

    // LLM returned something but test_code was inadequate
    console.warn(`[poc-gen] LLM response inadequate for "${finding.title}", using fallback`);
  } catch (e: any) {
    console.warn(`[poc-gen] LLM failed for "${finding.title}": ${e.message}`);
  }

  // Fallback: use the existing template harness from constructor.ts
  return buildFallbackPoC(finding, program, isAnchor, fileName, safeName);
}

// ─── Fallback PoC (enhanced template) ───────────────────────

function buildFallbackPoC(
  finding: FindingResult,
  program: ParsedProgram,
  isAnchor: boolean,
  fileName: string,
  safeName: string,
): GeneratedPoC {
  const capitalize = (s: string) =>
    s.charAt(0).toUpperCase() + s.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase());

  const ix = finding.location.instruction || "target_instruction";
  const steps = finding.proofPlan?.steps || [
    "Deploy program to localnet",
    `Invoke ${ix} with adversarial parameters`,
    "Verify unauthorized state change",
  ];

  let testCode: string;

  if (isAnchor) {
    testCode = `import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ${capitalize(program.name)} } from "../target/types/${program.name}";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

/**
 * PoC: ${finding.title}
 * Severity: ${finding.severity}
 * Class: #${finding.classId} — ${finding.className}
 * Location: ${finding.location.file}:${finding.location.line}
 *
 * Hypothesis: ${finding.hypothesis || "N/A"}
 *
 * This test demonstrates the vulnerability by attempting the exploit path.
 * If the program is vulnerable, the exploit transaction succeeds.
 * If the program is secure, the transaction is rejected.
 */
describe("PoC#${finding.classId}: ${finding.className} — ${finding.title.slice(0, 60)}", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.${capitalize(program.name)} as Program<${capitalize(program.name)}>;

  const attacker = Keypair.generate();
  const legitimateAuthority = Keypair.generate();

  before(async () => {
    // Fund attacker wallet
    const sig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // Fund legitimate authority
    const sig2 = await provider.connection.requestAirdrop(
      legitimateAuthority.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig2);
  });

  it("demonstrates ${finding.className} vulnerability at ${finding.location.file}:${finding.location.line}", async () => {
    /**
     * Exploit steps:
${steps.map((s, i) => `     * ${i + 1}. ${s}`).join("\n")}
     */

    // Step 1: Set up preconditions
    // The specific account setup depends on the program's instruction layout.
    // Accounts needed for '${ix}':
${program.instructions
  .filter((i) => i.name === ix)
  .flatMap((i) => i.accounts)
  .map((a) => `    // - ${a.name}: ${a.type || "AccountInfo"} (signer=${a.isSigner}, mut=${a.isMut})`)
  .join("\n") || "    // (account layout from instruction definition)"}

    // Step 2: Attempt exploit
    try {
      const tx = await program.methods
        .${ix}()
        .accounts({
          // Fill with accounts matching the instruction layout above.
          // Pass attacker's keypair where the authority/signer is expected.
        })
        .signers([attacker])
        .rpc();

      // If we reach here, the vulnerability is confirmed:
      // the instruction accepted an unauthorized caller.
      console.log("EXPLOIT SUCCEEDED — tx:", tx);
      console.log("Vulnerability CONFIRMED: ${finding.className}");
    } catch (err: any) {
      // The program correctly rejected the attack.
      console.log("SECURE: Program rejected the exploit:", err.message);
      // Uncomment the next line if you expect the exploit to succeed:
      // expect.fail("Expected exploit to succeed, but program rejected it");
    }
  });
});
`;
  } else {
    testCode = `//! PoC: ${finding.title}
//! Severity: ${finding.severity}
//! Class: #${finding.classId} — ${finding.className}
//! Location: ${finding.location.file}:${finding.location.line}
//! Hypothesis: ${finding.hypothesis || "N/A"}

#[cfg(test)]
mod poc_${finding.classId}_${safeName} {
    use solana_program_test::*;
    use solana_sdk::{
        signature::{Keypair, Signer},
        transaction::Transaction,
        system_instruction,
    };

    #[tokio::test]
    async fn test_${safeName}_exploit() {
        // Set up the test environment
        let program_id = solana_sdk::pubkey!("${program.programId || "11111111111111111111111111111111"}");
        let mut program_test = ProgramTest::new(
            "${program.name}",
            program_id,
            None,
        );

        let (mut banks_client, payer, recent_blockhash) = program_test.start().await;
        let attacker = Keypair::new();

        // Fund attacker
        let fund_ix = system_instruction::transfer(
            &payer.pubkey(),
            &attacker.pubkey(),
            5_000_000_000, // 5 SOL
        );
        let fund_tx = Transaction::new_signed_with_payer(
            &[fund_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        );
        banks_client.process_transaction(fund_tx).await.unwrap();

        // Exploit steps:
${steps.map((s, i) => `        // ${i + 1}. ${s}`).join("\n")}

        // Build exploit instruction
        // (Fill in the actual instruction data and accounts for '${ix}')
        // let exploit_ix = Instruction { program_id, accounts: vec![...], data: vec![...] };
        // let exploit_tx = Transaction::new_signed_with_payer(
        //     &[exploit_ix],
        //     Some(&attacker.pubkey()),
        //     &[&attacker],
        //     recent_blockhash,
        // );
        // let result = banks_client.process_transaction(exploit_tx).await;
        // assert!(result.is_ok(), "VULNERABLE: exploit transaction succeeded");

        println!("PoC harness for: ${finding.title}");
        println!("Manual verification required — fill in instruction-specific accounts");
    }
}
`;
  }

  return {
    findingTitle: finding.title,
    classId: finding.classId,
    severity: finding.severity,
    framework: isAnchor ? "anchor" : "native",
    testCode,
    fileName,
    reproSteps: steps,
    stateComparison: {
      preState: String(finding.proofPlan?.deltaSchema?.preState || "Valid program state with legitimate authority"),
      postState: String(finding.proofPlan?.deltaSchema?.postState || "Corrupted state / unauthorized access"),
      assertion: String(finding.proofPlan?.deltaSchema?.assertion || "Vulnerability allows unauthorized operation"),
    },
    runCommand: isAnchor
      ? `cd <repo> && anchor test -- --grep "PoC"`
      : `cd <repo> && cargo test-sbf poc_${finding.classId}_${safeName}`,
    status: "fallback",
  };
}

// ─── Main Entry: Generate PoCs for all critical/high findings ─

export async function generatePoCs(
  findings: FindingResult[],
  program: ParsedProgram,
  enrichedFindings?: EnrichedFinding[],
  patches?: CodePatch[],
): Promise<GeneratedPoC[]> {
  const apiKey = getPocApiKey();
  const actionable = findings.filter(
    (f) => ["CRITICAL", "HIGH"].includes(f.severity) && f.confidence >= 0.6
  );

  if (actionable.length === 0) return [];

  // Sort by severity then confidence
  actionable.sort((a, b) => {
    const sev = (s: string) => (s === "CRITICAL" ? 2 : s === "HIGH" ? 1 : 0);
    return sev(b.severity) - sev(a.severity) || b.confidence - a.confidence;
  });

  const toProcess = actionable.slice(0, POC_CFG.maxPocs);

  console.log(`[poc-gen] Generating PoCs for ${toProcess.length} findings (LLM: ${!!apiKey})`);

  if (!apiKey) {
    // No LLM — all fallbacks
    return toProcess.map((f) => {
      const isAnchor = program.framework === "anchor";
      const safeName = (f.location.instruction || f.className || "test")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .slice(0, 40);
      const fileName = isAnchor
        ? `tests/poc_${f.classId}_${safeName}.ts`
        : `tests/poc_${f.classId}_${safeName}.rs`;
      return buildFallbackPoC(f, program, isAnchor, fileName, safeName);
    });
  }

  // LLM-powered generation — sequential with cooldown to avoid rate-limits
  const provider = resolvePocProvider();
  const providerLabel = provider === "kimi_code" ? "Kimi Code" : "Moonshot";
  console.log(`[poc-gen] Generating via ${providerLabel} API (model: ${getPocModel()}, concurrency: ${POC_CFG.concurrency}, delay: ${POC_CFG.interRequestDelayMs}ms)`);
  const limit = pLimit(POC_CFG.concurrency);

  const results = await Promise.all(
    toProcess.map((finding, idx) =>
      limit(async () => {
        // Inter-request cooldown to avoid rate-limit storms
        if (idx > 0) await sleep(POC_CFG.interRequestDelayMs);
        const enriched = enrichedFindings?.find(
          (e) => e.title === finding.title || e.title.includes(finding.className)
        );
        const patch = patches?.find((p) => p.file === finding.location.file);
        return generateSinglePoC(finding, program, enriched, patch);
      })
    )
  );

  const generated = results.filter((r) => r.status === "generated").length;
  const fallback = results.filter((r) => r.status === "fallback").length;
  console.log(`[poc-gen] Complete: ${generated} LLM-generated, ${fallback} fallback, ${results.length} total`);

  return results;
}