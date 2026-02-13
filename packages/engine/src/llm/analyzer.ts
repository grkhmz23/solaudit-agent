/**
 * LLM Integration for Security Analysis
 *
 * Uses Moonshot/Kimi K2 (OpenAI-compatible API) to generate:
 * - Professional finding descriptions and impact analysis
 * - Exploit narratives explaining WHY a bug is dangerous
 * - PR titles and bodies that read like expert human review
 * - Full security advisory documents
 *
 * Falls back to template text when MOONSHOT_API_KEY is missing.
 */

import type { FindingResult, ParsedProgram, AuditSummary } from "../types";
import type { CodePatch } from "../remediation/patcher";
import type { PoCResult } from "../proof/executor";

// ─── Config ─────────────────────────────────────────────────

const MOONSHOT_API_URL = "https://api.moonshot.ai/v1/chat/completions";
const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL || "kimi-k2.5";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1500;

function getApiKey(): string | null {
  return process.env.MOONSHOT_API_KEY || null;
}

// ─── Core LLM call ──────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("MOONSHOT_API_KEY not set");

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(MOONSHOT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MOONSHOT_MODEL,
          max_tokens: 4096,
          temperature: 0.3,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[llm] Moonshot ${res.status}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Moonshot API ${res.status}: ${body}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty Moonshot response");
      return content;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_RETRIES - 1) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }

  throw lastError ?? new Error("Moonshot call failed after retries");
}

// ─── Check availability ─────────────────────────────────────

export function isLLMAvailable(): boolean {
  return !!getApiKey();
}

// ─── Finding Analysis ───────────────────────────────────────

export interface EnrichedFinding {
  title: string;
  description: string;
  impact: string;
  exploitability: string;
  attackScenario: string;
  recommendation: string;
}

export async function analyzeFinding(
  finding: FindingResult,
  program: ParsedProgram,
  patch?: CodePatch,
  pocResult?: PoCResult
): Promise<EnrichedFinding> {
  if (!isLLMAvailable()) return fallbackFinding(finding);

  const system = `You are a senior Solana security researcher writing for a vulnerability disclosure report.
You write precisely, technically, and convincingly. Your audience is the protocol team and the Solana Foundation bounty reviewers.
Never use filler words. Every sentence must add value. Be specific about Solana/Anchor concepts.
Output JSON with these exact keys: title, description, impact, exploitability, attackScenario, recommendation.
Do not wrap in markdown code fences.`;

  const user = `Analyze this vulnerability found in Solana program "${program.name}" (${program.framework} framework):

FINDING:
- Class: #${finding.classId} — ${finding.className}
- Location: ${finding.location.file}:${finding.location.line}${finding.location.instruction ? ` in instruction "${finding.location.instruction}"` : ""}
- Original title: ${finding.title}
- Hypothesis: ${finding.hypothesis || "N/A"}
- Severity: ${finding.severity}
- Confidence: ${(finding.confidence * 100).toFixed(0)}%

${finding.fixPlan ? `FIX PLAN:\n- Pattern: ${finding.fixPlan.pattern}\n- Description: ${finding.fixPlan.description}\n- Code: ${finding.fixPlan.code || "N/A"}` : ""}

${patch ? `PATCH DIFF:\n${patch.diff}` : ""}

${pocResult ? `POC RESULT: ${pocResult.status}\nOutput: ${pocResult.output?.slice(0, 500) || "N/A"}` : ""}

${finding.blastRadius ? `BLAST RADIUS:\n- Affected instructions: ${finding.blastRadius.affectedInstructions.join(", ")}\n- Affected accounts: ${finding.blastRadius.affectedAccounts.join(", ")}` : ""}

Write a professional vulnerability analysis. Be specific about:
1. What exactly is wrong (reference Solana/Anchor concepts)
2. How an attacker would exploit this in practice
3. What funds/state are at risk
4. Step-by-step attack scenario
5. The recommended fix and why it works`;

  try {
    const raw = await callLLM(system, user);
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      title: parsed.title || finding.title,
      description: parsed.description || finding.hypothesis || "",
      impact: parsed.impact || "",
      exploitability: parsed.exploitability || "",
      attackScenario: parsed.attackScenario || "",
      recommendation: parsed.recommendation || "",
    };
  } catch (e) {
    console.warn(`[llm] Failed to analyze finding "${finding.title}":`, e);
    return fallbackFinding(finding);
  }
}

function fallbackFinding(f: FindingResult): EnrichedFinding {
  return {
    title: f.title,
    description: f.hypothesis || `${f.className} vulnerability detected at ${f.location.file}:${f.location.line}`,
    impact: `Severity: ${f.severity}. This ${f.className.toLowerCase()} issue could allow unauthorized operations.`,
    exploitability: `Confidence: ${(f.confidence * 100).toFixed(0)}%. Requires crafting a transaction targeting the ${f.location.instruction || "affected"} instruction.`,
    attackScenario: "An attacker could craft a malicious transaction exploiting this vulnerability.",
    recommendation: f.fixPlan?.description || "Apply the suggested fix pattern.",
  };
}

// ─── Batch Analysis ─────────────────────────────────────────

export async function analyzeAllFindings(
  findings: FindingResult[],
  program: ParsedProgram,
  patches?: CodePatch[],
  pocResults?: PoCResult[]
): Promise<EnrichedFinding[]> {
  const actionable = findings.filter(
    (f) => ["CRITICAL", "HIGH"].includes(f.severity) && f.confidence >= 0.6
  );

  const results: EnrichedFinding[] = [];

  for (const finding of actionable) {
    const patch = patches?.find((p) => p.file === finding.location.file);
    const poc = pocResults?.find((p) => p.findingTitle === finding.title);

    const enriched = await analyzeFinding(finding, program, patch, poc);
    results.push(enriched);

    // Rate limit: 500ms between calls
    if (actionable.indexOf(finding) < actionable.length - 1) {
      await sleep(500);
    }
  }

  return results;
}

// ─── PR Content Generation ──────────────────────────────────

export interface PRContent {
  title: string;
  body: string;
}

export async function generatePRContent(
  program: ParsedProgram,
  findings: FindingResult[],
  enriched: EnrichedFinding[],
  patches: CodePatch[],
  repoUrl: string
): Promise<PRContent> {
  if (!isLLMAvailable()) {
    return fallbackPRContent(program, findings, patches);
  }

  const system = `You are a security researcher submitting a fix PR to an open-source Solana protocol.
Write a clear, professional PR description. The audience is the protocol maintainers.
Be specific and technical. Reference exact file paths, line numbers, and Solana concepts.
Output JSON with keys: title, body. The body should be Markdown.
Do not wrap in markdown code fences.`;

  const findingsSummary = enriched
    .map(
      (e, i) =>
        `${i + 1}. [${findings[i]?.severity || "HIGH"}] ${e.title}\n   Impact: ${e.impact}\n   Attack: ${e.attackScenario}`
    )
    .join("\n\n");

  const patchSummary = patches
    .map((p) => `- ${p.file}: ${p.description}`)
    .join("\n");

  const user = `Generate a pull request for security fixes to "${program.name}" (${repoUrl}).

FINDINGS:
${findingsSummary}

PATCHES APPLIED:
${patchSummary}

Total: ${enriched.length} finding(s), ${patches.length} file(s) patched.

Write a PR that:
1. Has a clear title like "fix: [severity] description"
2. Summarizes all findings with severity tags
3. Explains each fix briefly
4. Includes verification steps
5. Credits solaudit-agent as the author`;

  try {
    const raw = await callLLM(system, user);
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      title: parsed.title || `fix: ${enriched.length} security issues in ${program.name}`,
      body: parsed.body || "",
    };
  } catch (e) {
    console.warn("[llm] Failed to generate PR content:", e);
    return fallbackPRContent(program, findings, patches);
  }
}

function fallbackPRContent(
  program: ParsedProgram,
  findings: FindingResult[],
  patches: CodePatch[]
): PRContent {
  const c = findings.filter((f) => f.severity === "CRITICAL").length;
  const h = findings.filter((f) => f.severity === "HIGH").length;
  return {
    title: `fix: ${c + h} security issue${c + h !== 1 ? "s" : ""} found by solaudit-agent`,
    body: `## Security Fix\n\nAutomated audit found ${c} critical and ${h} high severity issues.\n\n### Files Changed\n\n${patches.map((p) => `- \`${p.file}\` — ${p.description}`).join("\n")}\n\n---\n*Created by solaudit-agent*`,
  };
}

// ─── Full Advisory Document ─────────────────────────────────

export async function generateLLMAdvisory(
  program: ParsedProgram,
  findings: FindingResult[],
  summary: AuditSummary,
  enriched: EnrichedFinding[],
  patches: CodePatch[],
  pocResults: PoCResult[],
  repoUrl: string
): Promise<string> {
  if (!isLLMAvailable()) return ""; // Caller falls back to template advisory

  const system = `You are writing a professional security advisory for the Solana Foundation bounty program.
The document must be thorough, precise, and technically impressive. Use Markdown formatting.
Include: executive summary, methodology, detailed findings with impact/exploitability/PoC/fix, and conclusion.
This is a real vulnerability disclosure — write it like a top-tier audit firm would.`;

  const findingsBlock = enriched
    .map((e, i) => {
      const f = findings.filter((f) => ["CRITICAL", "HIGH"].includes(f.severity))[i];
      const poc = pocResults.find((p) => p.findingTitle === f?.title);
      const patch = patches.find((p) => p.file === f?.location.file);

      return `FINDING ${i + 1}:
Title: ${e.title}
Severity: ${f?.severity || "HIGH"}
Location: ${f?.location.file}:${f?.location.line}
Description: ${e.description}
Impact: ${e.impact}
Exploitability: ${e.exploitability}
Attack Scenario: ${e.attackScenario}
PoC Status: ${poc?.status || "pending"}
PoC Output: ${poc?.output?.slice(0, 300) || "N/A"}
Fix: ${e.recommendation}
Diff: ${patch?.diff?.slice(0, 500) || "N/A"}`;
    })
    .join("\n\n---\n\n");

  const user = `Write a full security advisory for "${program.name}" (${repoUrl}).

Program: ${program.framework} framework, ${program.instructions.length} instructions, ${program.accounts.length} account structs.
Total findings: ${summary.totalFindings} (${summary.criticalCount} critical, ${summary.highCount} high, ${summary.mediumCount} medium)
Verdict: ${summary.shipReady ? "Ship Ready" : "Do Not Ship"}

ACTIONABLE FINDINGS:
${findingsBlock}

Write the complete advisory document in Markdown. Make it submission-ready for the Solana Foundation bounty.`;

  try {
    return await callLLM(system, user);
  } catch (e) {
    console.warn("[llm] Failed to generate advisory:", e);
    return "";
  }
}
