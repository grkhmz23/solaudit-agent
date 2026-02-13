/**
 * LLM Analyzer v2 — Production-Grade Security Analysis
 *
 * Architecture:
 *   1. Dedupe findings by (vulnClass, instruction, file, sinkType)
 *   2. Stage A: 1 LLM call picks top-K from ~50 candidates
 *   3. Stage B: K parallel deep-dive calls (concurrency-limited)
 *   4. Fail-open: any LLM failure → template fallback, pipeline never crashes
 *   5. Robust JSON parsing: retry → extract → repair → fallback
 *
 * Config via env:
 *   LLM_MAX_FINDINGS=10      — max deep-dive analyses
 *   LLM_SELECTOR_CANDIDATES=50 — candidates fed to selector
 *   LLM_MAX_TOKENS=8192      — token budget per call
 *   LLM_CONCURRENCY=4        — parallel API calls
 *   LLM_RETRIES=2            — retries on empty/5xx
 */

import type { FindingResult, ParsedProgram, AuditSummary } from "../types";
import type { CodePatch } from "../remediation/patcher";
import type { PoCResult } from "../proof/executor";

// ─── Config ─────────────────────────────────────────────────

const MOONSHOT_API_URL = "https://api.moonshot.ai/v1/chat/completions";
const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL || "kimi-k2.5";

const CFG = {
  maxFindings: int("LLM_MAX_FINDINGS", 10),
  selectorCandidates: int("LLM_SELECTOR_CANDIDATES", 50),
  maxTokens: int("LLM_MAX_TOKENS", 8192),
  concurrency: int("LLM_CONCURRENCY", 4),
  retries: int("LLM_RETRIES", 2),
  timeoutMs: int("LLM_TIMEOUT_MS", 60_000),
};

function int(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function getApiKey(): string | null {
  return process.env.MOONSHOT_API_KEY || null;
}

export function isLLMAvailable(): boolean {
  return !!getApiKey();
}

// ─── Metrics ────────────────────────────────────────────────

export interface LLMMetrics {
  totalFindings: number;
  dedupedFindings: number;
  selectorCandidates: number;
  deepDivesAttempted: number;
  deepDivesSucceeded: number;
  parseFails: number;
  avgLatencyMs: number;
  totalDurationMs: number;
}

// ─── Types ──────────────────────────────────────────────────

export interface EnrichedFinding {
  title: string;
  impact: string;
  exploitability: "easy" | "moderate" | "hard" | "unknown";
  proofPlan: string[];
  fix: string[];
  confidence: number;
  llmStatus: "success" | "failed" | "skipped";
  rawResponse?: string;
  // Compat fields for existing code
  description: string;
  attackScenario: string;
  recommendation: string;
}

export interface PRContent {
  title: string;
  body: string;
}

// ─── Core LLM Call ──────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("MOONSHOT_API_KEY not set");

  for (let attempt = 0; attempt <= CFG.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

    try {
      const res = await fetch(MOONSHOT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MOONSHOT_MODEL,
          max_tokens: CFG.maxTokens,
          temperature: 1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        const delay = 1500 * Math.pow(2, attempt);
        console.warn(`[llm] ${res.status}, retry in ${delay}ms (${attempt + 1}/${CFG.retries + 1})`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Moonshot ${res.status}: ${body}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content || content.trim().length === 0) {
        if (attempt < CFG.retries) {
          console.warn(`[llm] Empty response, retrying (${attempt + 1}/${CFG.retries + 1})`);
          await sleep(1000);
          continue;
        }
        throw new Error("Empty Moonshot response after retries");
      }

      return content;
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        console.warn(`[llm] Timeout after ${CFG.timeoutMs}ms (${attempt + 1}/${CFG.retries + 1})`);
        if (attempt < CFG.retries) continue;
        throw new Error("LLM call timed out");
      }
      if (attempt < CFG.retries) {
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      throw e;
    }
  }

  throw new Error("LLM call failed after retries");
}

// ─── Robust JSON Parsing ────────────────────────────────────

function robustParseJSON(raw: string): any {
  let cleaned = raw.trim();

  // Step 1: Strip markdown fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  // Step 2: Try strict parse
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Step 3: Extract largest {...} substring
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {}

    // Step 4: Repair truncated JSON — close open strings and braces
    let repaired = braceMatch[0];

    // Close any unterminated string
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      repaired += '"';
    }

    // Close open braces/brackets
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
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

    // Remove trailing comma before closing
    repaired = repaired.replace(/,\s*$/, "");

    for (let i = 0; i < openBrackets; i++) repaired += "]";
    for (let i = 0; i < openBraces; i++) repaired += "}";

    try {
      return JSON.parse(repaired);
    } catch {}
  }

  // Step 5: Try to extract individual fields with regex
  try {
    const title = raw.match(/"title"\s*:\s*"([^"]+)"/)?.[1] || "";
    const impact = raw.match(/"impact"\s*:\s*"([^"]+)"/)?.[1] || "";
    const exploitability = raw.match(/"exploitability"\s*:\s*"([^"]+)"/)?.[1] || "unknown";
    if (title || impact) {
      return { title, impact, exploitability };
    }
  } catch {}

  return null;
}

// ─── Dedupe ─────────────────────────────────────────────────

function dedupeKey(f: FindingResult): string {
  return `${f.classId}|${f.location.instruction || ""}|${f.location.file}|${f.className}`;
}

function dedupeFindings(findings: FindingResult[]): FindingResult[] {
  const seen = new Map<string, FindingResult>();

  for (const f of findings) {
    const key = dedupeKey(f);
    const existing = seen.get(key);
    if (!existing || f.confidence > existing.confidence) {
      seen.set(key, f);
    }
  }

  return Array.from(seen.values());
}

// ─── Concurrency Limiter ────────────────────────────────────

function pLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const fn = queue.shift()!;
      fn();
    }
  }

  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
  };
}

// ─── Fallback Templates ─────────────────────────────────────

const CLASS_IMPACT: Record<number, string> = {
  1: "Missing signer check allows unauthorized accounts to invoke privileged instructions, risking fund theft or state corruption.",
  2: "Absent account ownership validation enables spoofed accounts to pass validation, leading to unauthorized state changes.",
  3: "Non-canonical PDA bump allows address collision attacks; an attacker can derive a different PDA and hijack authority.",
  4: "Missing account close drain leaves lamports in closed accounts; attacker can reclaim or re-initialize them.",
  5: "Unvalidated CPI target allows an attacker to redirect cross-program invocations to a malicious program.",
  6: "Missing re-initialization guard lets an attacker re-init an already-initialized account, overwriting state.",
  7: "Arithmetic overflow/underflow can cause incorrect balances, enabling fund extraction or denial of service.",
  8: "Type confusion between Account and UncheckedAccount bypasses Anchor deserialization guards.",
  9: "Integer overflow in arithmetic operations can wrap values, leading to incorrect financial calculations.",
  10: "Missing freeze-authority check allows unauthorized token freezing.",
  11: "Stale data after CPI: account state read before reload may reflect pre-CPI values, causing logic errors.",
  12: "Unvalidated oracle account owner allows attacker-controlled price feeds, enabling price manipulation.",
  13: "Insufficient constraint validation on derived addresses enables account substitution attacks.",
  14: "Post-CPI stale account data may cause the program to act on outdated state.",
  15: "Duplicate mutable account references cause undefined behavior in the Solana runtime.",
};

const CLASS_FIX: Record<number, string[]> = {
  1: ["Add #[account(signer)] or Signer<'info> constraint", "Verify signer matches expected authority PDA"],
  2: ["Add owner = expected_program constraint", "Use Account<'info, T> with explicit owner check"],
  3: ["Use canonical bump with seeds::program and bump = stored_bump", "Store and verify bump on init"],
  5: ["Validate CPI target program_id against known program constant", "Use anchor CpiContext with typed program"],
  6: ["Add is_initialized flag check", "Use init_if_needed with proper guards or #[account(constraint = !acct.is_initialized)]"],
  9: ["Replace +/-/* with checked_add/checked_sub/checked_mul", "Enable overflow-checks in Cargo.toml release profile"],
  12: ["Validate oracle account owner == known oracle program ID", "Cross-check oracle pubkey against on-chain config"],
  14: ["Call account.reload() after every CPI", "Re-fetch account data before post-CPI reads"],
};

function fallbackFinding(f: FindingResult): EnrichedFinding {
  const impact = CLASS_IMPACT[f.classId] || `${f.className} vulnerability could allow unauthorized operations.`;
  const fix = CLASS_FIX[f.classId] || ["Apply the recommended fix pattern for this vulnerability class."];

  return {
    title: f.title,
    impact,
    exploitability: f.severity === "CRITICAL" ? "easy" : f.severity === "HIGH" ? "moderate" : "unknown",
    proofPlan: [
      "Deploy program to localnet",
      `Invoke ${f.location.instruction || "target"} instruction with malicious parameters`,
      "Verify unauthorized state change or fund movement",
    ],
    fix,
    confidence: Math.round(f.confidence * 100),
    llmStatus: "skipped",
    // Compat
    description: impact,
    attackScenario: `Attacker targets ${f.location.instruction || "affected"} instruction in ${f.location.file}.`,
    recommendation: fix.join("; "),
  };
}

// ─── Stage A: Selector (1 LLM call) ────────────────────────

interface SelectorResult {
  selected: number[];
  reasoning: string;
}

async function runSelector(
  candidates: FindingResult[],
  program: ParsedProgram
): Promise<SelectorResult> {
  const system = `You are a senior Solana security researcher selecting the most critical findings for deep analysis.
Return ONLY minified JSON: {"selected":[0,2,5,...],"reasoning":"one sentence"}
No markdown, no prose outside JSON. Max ${CFG.maxFindings} indices.`;

  const compactList = candidates.map((f, i) =>
    `[${i}] ${f.severity} conf:${(f.confidence * 100).toFixed(0)}% cls:${f.classId}-${f.className} loc:${f.location.file}:${f.location.line} fn:${f.location.instruction || "?"} "${f.title}"`
  ).join("\n");

  const user = `Program: "${program.name}" (${program.framework}, ${program.instructions.length} instructions)

Select the top ${CFG.maxFindings} most critical and exploitable findings to deep-dive. Prioritize:
- Real fund-loss risk over informational issues
- Unique vulnerability classes over duplicates
- High confidence over speculative

Candidates:
${compactList}`;

  try {
    const raw = await callLLM(system, user);
    const parsed = robustParseJSON(raw);

    if (parsed?.selected && Array.isArray(parsed.selected)) {
      const valid = parsed.selected
        .filter((i: any) => typeof i === "number" && i >= 0 && i < candidates.length)
        .slice(0, CFG.maxFindings);
      return { selected: valid, reasoning: parsed.reasoning || "" };
    }
  } catch (e: any) {
    console.warn(`[llm] Selector failed: ${e.message}`);
  }

  // Fallback: just take top K by severity+confidence
  const indices = candidates
    .map((f, i) => ({ i, score: (f.severity === "CRITICAL" ? 100 : f.severity === "HIGH" ? 50 : 10) + f.confidence * 40 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CFG.maxFindings)
    .map((x) => x.i);

  return { selected: indices, reasoning: "selector-fallback: top-K by severity+confidence" };
}

// ─── Stage B: Deep Dive (K parallel calls) ──────────────────

const DEEP_DIVE_SYSTEM = `You are a senior Solana security researcher. Analyze this vulnerability precisely.
Return ONLY minified JSON with these exact keys:
{"title":"≤120 chars","impact":"≤240 chars","exploitability":"easy|moderate|hard|unknown","proof_plan":["step1","step2",...],"fix":["step1","step2",...],"confidence":0-100}
Max 6 items in proof_plan and fix arrays. No markdown, no prose outside JSON.`;

async function deepDiveFinding(
  finding: FindingResult,
  program: ParsedProgram,
  patch?: CodePatch,
  pocResult?: PoCResult
): Promise<EnrichedFinding> {
  const user = `Program: "${program.name}" (${program.framework})
Finding: [${finding.severity}] #${finding.classId} ${finding.className}
Title: ${finding.title}
Location: ${finding.location.file}:${finding.location.line} @ ${finding.location.instruction || "?"}
Confidence: ${(finding.confidence * 100).toFixed(0)}%
${finding.hypothesis ? `Hypothesis: ${finding.hypothesis}` : ""}
${finding.fixPlan ? `Fix pattern: ${finding.fixPlan.pattern} — ${finding.fixPlan.description}` : ""}
${patch ? `Patch: ${patch.description}` : ""}
${pocResult ? `PoC: ${pocResult.status}` : ""}
${finding.blastRadius ? `Blast: accounts=${finding.blastRadius.affectedAccounts.join(",")} instructions=${finding.blastRadius.affectedInstructions.join(",")}` : ""}`;

  const start = Date.now();

  try {
    const raw = await callLLM(DEEP_DIVE_SYSTEM, user);
    const parsed = robustParseJSON(raw);

    if (parsed?.title || parsed?.impact) {
      const exploitability = ["easy", "moderate", "hard", "unknown"].includes(parsed.exploitability)
        ? parsed.exploitability : "unknown";

      const proofPlan = Array.isArray(parsed.proof_plan) ? parsed.proof_plan.slice(0, 6).map(String) : [];
      const fix = Array.isArray(parsed.fix) ? parsed.fix.slice(0, 6).map(String) : [];

      return {
        title: String(parsed.title || finding.title).slice(0, 120),
        impact: String(parsed.impact || "").slice(0, 240),
        exploitability,
        proofPlan: proofPlan.length > 0 ? proofPlan : ["Deploy to localnet", "Craft exploit transaction", "Verify state change"],
        fix: fix.length > 0 ? fix : (CLASS_FIX[finding.classId] || ["Apply recommended fix"]),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : Math.round(finding.confidence * 100),
        llmStatus: "success",
        // Compat
        description: String(parsed.impact || finding.hypothesis || ""),
        attackScenario: proofPlan.join(" → ") || "See proof plan",
        recommendation: fix.join("; ") || "See fix steps",
      };
    }

    // Parsed but missing required fields
    console.warn(`[llm] Parsed but incomplete for "${finding.title}"`);
    const fb = fallbackFinding(finding);
    fb.llmStatus = "failed";
    fb.rawResponse = raw.slice(0, 500);
    return fb;
  } catch (e: any) {
    console.warn(`[llm] Deep dive failed for "${finding.title}": ${e.message}`);
    const fb = fallbackFinding(finding);
    fb.llmStatus = "failed";
    return fb;
  }
}

// ─── Main Entry: Analyze All Findings ───────────────────────

export async function analyzeAllFindings(
  findings: FindingResult[],
  program: ParsedProgram,
  patches?: CodePatch[],
  pocResults?: PoCResult[]
): Promise<{ enriched: EnrichedFinding[]; metrics: LLMMetrics }> {
  const start = Date.now();
  const metrics: LLMMetrics = {
    totalFindings: findings.length,
    dedupedFindings: 0,
    selectorCandidates: 0,
    deepDivesAttempted: 0,
    deepDivesSucceeded: 0,
    parseFails: 0,
    avgLatencyMs: 0,
    totalDurationMs: 0,
  };

  // Filter actionable
  const actionable = findings.filter(
    (f) => ["CRITICAL", "HIGH"].includes(f.severity) && f.confidence >= 0.6
  );

  if (actionable.length === 0) {
    metrics.totalDurationMs = Date.now() - start;
    return { enriched: [], metrics };
  }

  // Step 1: Dedupe
  const deduped = dedupeFindings(actionable);
  metrics.dedupedFindings = deduped.length;
  console.log(`[llm] Deduped: ${actionable.length} → ${deduped.length} unique findings`);

  // Sort by severity + confidence
  deduped.sort((a, b) => {
    const sev = (s: string) => s === "CRITICAL" ? 2 : s === "HIGH" ? 1 : 0;
    return (sev(b.severity) - sev(a.severity)) || (b.confidence - a.confidence);
  });

  // Take top candidates for selector
  const candidates = deduped.slice(0, CFG.selectorCandidates);
  metrics.selectorCandidates = candidates.length;

  if (!isLLMAvailable()) {
    // No API key — all fallbacks
    const enriched = candidates.slice(0, CFG.maxFindings).map(fallbackFinding);
    metrics.totalDurationMs = Date.now() - start;
    return { enriched, metrics };
  }

  // Step 2: Stage A — Selector
  console.log(`[llm] Stage A: Selecting top ${CFG.maxFindings} from ${candidates.length} candidates...`);
  const selection = await runSelector(candidates, program);
  console.log(`[llm] Selected indices: [${selection.selected.join(",")}] — ${selection.reasoning}`);

  const selected = selection.selected.map((i) => candidates[i]).filter(Boolean);
  metrics.deepDivesAttempted = selected.length;

  // Step 3: Stage B — Deep dives (concurrent)
  console.log(`[llm] Stage B: Deep diving ${selected.length} findings (concurrency: ${CFG.concurrency})...`);
  const limit = pLimit(CFG.concurrency);
  const latencies: number[] = [];

  const enriched = await Promise.all(
    selected.map((finding) =>
      limit(async () => {
        const t0 = Date.now();
        const patch = patches?.find((p) => p.file === finding.location.file);
        const poc = pocResults?.find((p) => p.findingTitle === finding.title);
        const result = await deepDiveFinding(finding, program, patch, poc);
        latencies.push(Date.now() - t0);

        if (result.llmStatus === "success") metrics.deepDivesSucceeded++;
        else metrics.parseFails++;

        return result;
      })
    )
  );

  metrics.avgLatencyMs = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  metrics.totalDurationMs = Date.now() - start;

  console.log(`[llm] Complete: ${metrics.deepDivesSucceeded}/${metrics.deepDivesAttempted} succeeded, ${metrics.parseFails} fallbacks, avg ${metrics.avgLatencyMs}ms, total ${metrics.totalDurationMs}ms`);

  return { enriched, metrics };
}

// ─── Compat wrapper (matches old signature) ─────────────────

export async function analyzeFinding(
  finding: FindingResult,
  program: ParsedProgram,
  patch?: CodePatch,
  pocResult?: PoCResult
): Promise<EnrichedFinding> {
  if (!isLLMAvailable()) return fallbackFinding(finding);
  return deepDiveFinding(finding, program, patch, pocResult);
}

// ─── PR Content Generation ──────────────────────────────────

export async function generatePRContent(
  program: ParsedProgram,
  findings: FindingResult[],
  enriched: EnrichedFinding[],
  patches: CodePatch[],
  repoUrl: string
): Promise<PRContent> {
  if (!isLLMAvailable() || enriched.length === 0) {
    return fallbackPRContent(program, findings, patches);
  }

  const system = `You are a security researcher submitting a fix PR to an open-source Solana protocol.
Return ONLY minified JSON: {"title":"fix: ...","body":"markdown PR body"}
Title ≤80 chars. Body ≤2000 chars. Be specific and technical.`;

  const findingList = enriched
    .map((e, i) => `${i + 1}. [${e.exploitability}] ${e.title} — ${e.impact}`)
    .join("\n");

  const patchList = patches.slice(0, 20)
    .map((p) => `- ${p.file}: ${p.description}`)
    .join("\n");

  const user = `Repo: ${repoUrl}
Program: "${program.name}" (${program.framework})
Findings: ${enriched.length} analyzed
Patches: ${patches.length} files

Top findings:
${findingList}

Patches:
${patchList}`;

  try {
    const raw = await callLLM(system, user);
    const parsed = robustParseJSON(raw);
    if (parsed?.title && parsed?.body) {
      return { title: String(parsed.title).slice(0, 80), body: String(parsed.body) };
    }
  } catch (e: any) {
    console.warn(`[llm] PR content failed: ${e.message}`);
  }

  return fallbackPRContent(program, findings, patches);
}

function fallbackPRContent(
  program: ParsedProgram,
  findings: FindingResult[],
  patches: CodePatch[]
): PRContent {
  const c = findings.filter((f) => f.severity === "CRITICAL").length;
  const h = findings.filter((f) => f.severity === "HIGH").length;
  return {
    title: `fix: ${c + h} security issue${c + h !== 1 ? "s" : ""} in ${program.name}`,
    body: `## Security Fix\n\nAutomated audit found ${c} critical and ${h} high severity issues.\n\n### Files Changed\n\n${patches.slice(0, 20).map((p) => "- `" + p.file + "` — " + p.description).join("\n")}\n\n---\n*Created by solaudit-agent*`,
  };
}

// ─── Advisory Document ──────────────────────────────────────

export async function generateLLMAdvisory(
  program: ParsedProgram,
  findings: FindingResult[],
  summary: AuditSummary,
  enriched: EnrichedFinding[],
  patches: CodePatch[],
  pocResults: PoCResult[],
  repoUrl: string
): Promise<string> {
  if (!isLLMAvailable() || enriched.length === 0) return "";

  const system = `You are writing a security advisory for the Solana Foundation bounty program.
Output clean Markdown. Sections: Executive Summary, Methodology, Findings (each with severity/impact/exploitability/proof/fix), Conclusion.
Max 4000 chars. Be precise and technical.`;

  const findingsBlock = enriched.map((e, i) =>
    `### Finding ${i + 1}: ${e.title}
- **Impact**: ${e.impact}
- **Exploitability**: ${e.exploitability}
- **Confidence**: ${e.confidence}%
- **Proof Plan**: ${e.proofPlan.join("; ")}
- **Fix**: ${e.fix.join("; ")}`
  ).join("\n\n");

  const user = `Program: "${program.name}" (${repoUrl})
Framework: ${program.framework}, ${program.instructions.length} instructions
Total findings: ${summary.totalFindings} (${summary.criticalCount} critical, ${summary.highCount} high)
Patches: ${patches.length} files
Verdict: ${summary.shipReady ? "Ship Ready" : "Do Not Ship"}

${findingsBlock}

Write the complete advisory document.`;

  try {
    return await callLLM(system, user);
  } catch (e: any) {
    console.warn(`[llm] Advisory failed: ${e.message}`);
    return "";
  }
}