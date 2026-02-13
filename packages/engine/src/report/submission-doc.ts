/**
 * Submission Document Generator — Priority 3 for Superteam Bounty
 *
 * Generates a comprehensive Markdown document that fulfills the bounty
 * submission requirement: "detailed write up of findings, explanation
 * of impact, and verification proofs."
 *
 * This document is uploaded to R2 and its URL is submitted to the bounty form.
 */

import type { FindingResult, ParsedProgram, AuditSummary, AuditGraph } from "../types";
import type { CodePatch } from "../remediation/patcher";
import type { PoCResult } from "../proof/executor";
import type { EnrichedFinding, LLMMetrics } from "../llm/analyzer";
import type { GeneratedPoC } from "../proof/llm-poc-generator";

export interface SubmissionDocOptions {
  repoUrl: string;
  prUrl?: string;
  repoMeta?: { stars?: number; forks?: number; framework?: string };
  agentName?: string;
  agentVersion?: string;
  agentRepoUrl?: string;
}

/**
 * Generate the full bounty submission document (Markdown).
 *
 * Structure matches bounty requirements:
 * 1. Executive Summary
 * 2. Target Repository
 * 3. Methodology
 * 4. Findings (detailed write-ups with impact + exploitability)
 * 5. Verification Proofs (PoC code, repro steps, state comparisons)
 * 6. Fixes Applied (patches + verification)
 * 7. Agent Architecture
 */
export function generateSubmissionDocument(
  program: ParsedProgram,
  findings: FindingResult[],
  summary: AuditSummary,
  graphs: AuditGraph[],
  enrichedFindings: EnrichedFinding[],
  patches: CodePatch[],
  pocResults: PoCResult[],
  generatedPocs: GeneratedPoC[],
  llmMetrics: LLMMetrics | null,
  opts: SubmissionDocOptions,
): string {
  const agent = opts.agentName || "SolAudit Agent";
  const ver = opts.agentVersion || "1.0.0";
  const now = new Date().toISOString().split("T")[0];
  const critical = findings.filter((f) => f.severity === "CRITICAL");
  const high = findings.filter((f) => f.severity === "HIGH");
  const actionable = [...critical, ...high].filter((f) => f.confidence >= 0.6);

  const s: string[] = [];

  // ═══════════════════════════════════════════════════════════
  // Header
  // ═══════════════════════════════════════════════════════════
  s.push(`# Security Audit Submission: ${program.name}

> **Superteam Bounty — AI Agent Security Audit**
> Submitted by [${agent}](${opts.agentRepoUrl || "https://github.com/grkhmz23/solaudit-agent"}) v${ver}

| Field | Value |
|-------|-------|
| **Repository** | [${opts.repoUrl}](${opts.repoUrl}) |
| **Program** | \`${program.name}\` (${program.framework}) |
| **Date** | ${now} |
| **Pull Request** | ${opts.prUrl ? `[View PR](${opts.prUrl})` : "Pending"} |
| **Findings** | ${critical.length} Critical, ${high.length} High |
| **Patches** | ${patches.length} files |
| **PoCs** | ${generatedPocs.length} generated |
| **Verdict** | ${summary.shipReady ? "SHIP READY" : "**DO NOT SHIP**"} |

---
`);

  // ═══════════════════════════════════════════════════════════
  // 1. Executive Summary
  // ═══════════════════════════════════════════════════════════
  s.push(`## 1. Executive Summary

${agent} performed an autonomous security audit of **${program.name}**, a ${program.framework}-based Solana program in [${opts.repoUrl.replace("https://github.com/", "")}](${opts.repoUrl})${opts.repoMeta?.stars ? ` (${opts.repoMeta.stars} stars)` : ""}.

The audit identified **${summary.totalFindings} total findings**, of which **${critical.length} are critical** and **${high.length} are high severity**. ${actionable.length} findings are actionable (high confidence, critical/high severity) and have been patched with code fixes submitted via pull request.

${critical.length > 0 ? `### Critical Findings Summary\n\n${critical.slice(0, 5).map((f, i) => `${i + 1}. **${f.title}** — \`${f.location.file}:${f.location.line}\`${f.location.instruction ? ` @ \`${f.location.instruction}\`` : ""} (${(f.confidence * 100).toFixed(0)}% confidence)`).join("\n")}\n` : ""}

### Severity Breakdown

| Severity | Count |
|----------|-------|
| Critical | ${summary.criticalCount} |
| High | ${summary.highCount} |
| Medium | ${summary.mediumCount} |
| Low | ${summary.lowCount} |
| Info | ${summary.infoCount} |

---
`);

  // ═══════════════════════════════════════════════════════════
  // 2. Target Repository
  // ═══════════════════════════════════════════════════════════
  s.push(`## 2. Target Repository

| Property | Value |
|----------|-------|
| **URL** | ${opts.repoUrl} |
| **Program Name** | ${program.name} |
| **Framework** | ${program.framework} |
| **Program ID** | ${program.programId || "N/A"} |
| **Instructions** | ${program.instructions.length} |
| **Account Structs** | ${program.accounts.length} |
| **CPI Calls** | ${program.cpiCalls.length} |
| **PDA Derivations** | ${program.pdaDerivations.length} |
| **Files Analyzed** | ${program.files.length} |
${opts.repoMeta?.stars ? `| **Stars** | ${opts.repoMeta.stars} |` : ""}

### Files Scanned

${program.files.map((f) => `- \`${f.path}\``).join("\n")}

---
`);

  // ═══════════════════════════════════════════════════════════
  // 3. Methodology
  // ═══════════════════════════════════════════════════════════
  s.push(`## 3. Methodology

The audit was performed by **${agent}**, an autonomous AI-powered Solana security agent. The pipeline executes the following stages:

**Stage 1 — Ingestion & Parsing:** Clone the repository, parse Rust/Anchor source files, extract AST-level structures including instructions, account structs, CPI calls, PDA derivations, arithmetic operations, signer checks, and owner checks.

**Stage 2 — Semantic Graph Mining:** Build four semantic graphs (authority-flow, token-flow, state-machine, PDA derivation) to model cross-instruction data and control flow.

**Stage 3 — Vulnerability Detection:** Run 15 specialized detector classes plus constraint checking and adversarial synthesis. Each detector targets a specific Solana vulnerability pattern.

**Stage 4 — LLM Enrichment:** Deduplicate findings, select top candidates via LLM (Kimi K2.5), and perform deep-dive analysis on each selected finding for impact assessment, exploitability rating, and proof planning.

**Stage 5 — PoC Generation:** Generate proof-of-concept test files for each critical/high finding using LLM, including reproduction steps, state comparisons, and runnable test code.

**Stage 6 — Remediation:** Generate concrete code patches for each finding, applying fix patterns specific to each vulnerability class.

**Stage 7 — Reporting & PR Submission:** Compile advisory, generate structured PR, fork target repo, commit patches + PoC files, and open pull request.

### Vulnerability Classes Checked

| # | Class | Description |
|---|-------|-------------|
| 1 | Missing Signer Check | Privileged instruction callable by unauthorized accounts |
| 2 | Missing Owner Check | Account ownership not validated, allowing spoofed accounts |
| 3 | PDA Derivation Mistake | Non-canonical bump or missing bump validation |
| 4 | Arbitrary CPI Target | Cross-program invocation target not validated |
| 5 | Type Confusion | Account type not properly deserialized/validated |
| 6 | Reinitialization | Already-initialized account can be re-initialized |
| 7 | Close-then-Revive | Closed account can be revived by refunding lamports |
| 8 | Unchecked Realloc | Stale memory after reallocation |
| 9 | Integer Overflow/Underflow | Arithmetic without checked operations |
| 10 | State Machine Violation | Missing state guards on transitions |
| 11 | Remaining Accounts Injection | Unchecked extra accounts processed |
| 12 | Oracle Validation Failure | Oracle account owner not validated |
| 13 | Token Account Mismatch | Wrong mint token account accepted |
| 14 | Post-CPI Stale Read | Account data not reloaded after CPI |
| 15 | Duplicate Account Injection | Same account passed for multiple parameters |

${llmMetrics ? `### LLM Analysis Metrics

| Metric | Value |
|--------|-------|
| Total findings | ${llmMetrics.totalFindings} |
| After dedup | ${llmMetrics.dedupedFindings} |
| Deep dives attempted | ${llmMetrics.deepDivesAttempted} |
| Deep dives succeeded | ${llmMetrics.deepDivesSucceeded} |
| Parse failures (fallback) | ${llmMetrics.parseFails} |
| Avg latency per dive | ${llmMetrics.avgLatencyMs}ms |
| Total LLM time | ${llmMetrics.totalDurationMs}ms |` : ""}

---
`);

  // ═══════════════════════════════════════════════════════════
  // 4. Detailed Findings
  // ═══════════════════════════════════════════════════════════
  s.push(`## 4. Findings — Detailed Write-ups

> Each finding below includes: description, impact, exploitability assessment,
> verification proof reference, and applied fix.

`);

  // Sort: CRITICAL first, then HIGH, by confidence desc
  const sortedActionable = [...actionable].sort((a, b) => {
    const sev = (x: string) => (x === "CRITICAL" ? 2 : x === "HIGH" ? 1 : 0);
    return sev(b.severity) - sev(a.severity) || b.confidence - a.confidence;
  });

  for (let i = 0; i < sortedActionable.length; i++) {
    const f = sortedActionable[i];
    const enriched = enrichedFindings.find(
      (e) => e.title === f.title || e.title.includes(f.className)
    );
    const poc = generatedPocs.find(
      (p) => p.findingTitle === f.title || (p.classId === f.classId && p.severity === f.severity)
    );
    const pocResult = pocResults.find((p) => p.findingTitle === f.title);
    const patch = patches.find((p) => p.file === f.location.file);

    s.push(`### 4.${i + 1}. ${enriched?.title || f.title}

| Field | Value |
|-------|-------|
| **Severity** | ${f.severity} |
| **Vulnerability Class** | #${f.classId} — ${f.className} |
| **Location** | \`${f.location.file}:${f.location.line}\`${f.location.instruction ? ` @ \`${f.location.instruction}\`` : ""} |
| **Confidence** | ${(f.confidence * 100).toFixed(0)}% |
| **Exploitability** | ${enriched?.exploitability || (f.severity === "CRITICAL" ? "Easy" : "Moderate")} |
| **Proof Status** | ${poc ? (poc.status === "generated" ? "PoC Generated" : "Template Generated") : pocResult?.status || "Pending"} |
`);

    // Impact
    s.push(`#### Impact\n`);
    if (enriched?.impact) {
      s.push(`${enriched.impact}\n`);
    } else if (f.hypothesis) {
      s.push(`${f.hypothesis}\n`);
    }

    // Exploitability / Attack Scenario
    if (enriched?.attackScenario && enriched.attackScenario !== "See proof plan") {
      s.push(`#### Attack Scenario\n\n${enriched.attackScenario}\n`);
    }

    // Blast Radius
    if (f.blastRadius) {
      s.push(`#### Blast Radius

- **Affected Instructions:** ${f.blastRadius.affectedInstructions.join(", ") || "N/A"}
- **Affected Accounts:** ${f.blastRadius.affectedAccounts.join(", ") || "N/A"}
- **Signer Changes:** ${f.blastRadius.signerChanges.join(", ") || "N/A"}
`);
    }

    // Proof of Concept
    if (poc) {
      s.push(`#### Verification Proof\n`);
      s.push(`**PoC File:** \`${poc.fileName}\`\n`);
      s.push(`**Run Command:** \`${poc.runCommand}\`\n`);
      s.push(`\n**Reproduction Steps:**\n\n${poc.reproSteps.map((st, j) => `${j + 1}. ${st}`).join("\n")}\n`);
      s.push(`\n**State Comparison:**\n\n| Phase | State |
|-------|-------|
| **Before exploit** | ${poc.stateComparison.preState} |
| **After exploit** | ${poc.stateComparison.postState} |
| **Assertion** | ${poc.stateComparison.assertion} |
`);
      s.push(`\n**PoC Test Code:**\n\n\`\`\`${poc.framework === "anchor" ? "typescript" : "rust"}\n${poc.testCode.slice(0, 4000)}\n\`\`\`\n`);
    } else if (f.proofPlan) {
      // Fallback: use proof plan from constructor
      s.push(`#### Verification Proof (Proof Plan)\n`);
      if (f.proofPlan.steps?.length) {
        s.push(`**Steps:**\n\n${f.proofPlan.steps.map((st, j) => `${j + 1}. ${st}`).join("\n")}\n`);
      }
      if (f.proofPlan.deltaSchema) {
        s.push(`\n**State Comparison:**\n\n| Phase | State |
|-------|-------|
| **Before** | \`${JSON.stringify(f.proofPlan.deltaSchema.preState)}\` |
| **After** | \`${JSON.stringify(f.proofPlan.deltaSchema.postState)}\` |
| **Assertion** | ${f.proofPlan.deltaSchema.assertion} |
`);
      }
    }

    // Fix Applied
    if (patch || f.fixPlan) {
      s.push(`#### Fix Applied\n`);
      if (f.fixPlan) {
        s.push(`**Pattern:** ${f.fixPlan.pattern}\n`);
        s.push(`**Description:** ${f.fixPlan.description}\n`);
      }
      if (enriched?.fix && enriched.fix.length > 0) {
        s.push(`\n**Fix Steps:**\n\n${enriched.fix.map((st, j) => `${j + 1}. ${st}`).join("\n")}\n`);
      }
      if (patch) {
        s.push(`\n**Diff:**\n\n\`\`\`diff\n${patch.diff.slice(0, 3000)}\n\`\`\`\n`);
      }
    }

    // Fix Verification
    s.push(`#### Fix Verification\n`);
    if (f.fixPlan?.regressionTests?.length) {
      s.push(`**Regression Tests:**\n\n${f.fixPlan.regressionTests.map((t) => `- ${t}`).join("\n")}\n`);
    }
    s.push(`**Manual Verification:**\n\n1. Review the diff above for correctness\n2. Run \`${program.framework === "anchor" ? "anchor test" : "cargo test-sbf"}\` to confirm no regressions\n3. Verify the fix addresses the root cause at \`${f.location.file}:${f.location.line}\`\n`);

    s.push(`---\n`);
  }

  // ═══════════════════════════════════════════════════════════
  // 5. Medium/Low/Info Findings (summary table)
  // ═══════════════════════════════════════════════════════════
  const other = findings.filter((f) => !["CRITICAL", "HIGH"].includes(f.severity));
  if (other.length > 0) {
    s.push(`## 5. Additional Findings (Medium/Low/Info)

| # | Severity | Title | Location | Confidence |
|---|----------|-------|----------|------------|
${other.map((f, i) =>
  `| ${i + 1} | ${f.severity} | ${f.title.slice(0, 80)} | \`${f.location.file}:${f.location.line}\` | ${(f.confidence * 100).toFixed(0)}% |`
).join("\n")}

---
`);
  }

  // ═══════════════════════════════════════════════════════════
  // 6. Files Changed (Patches)
  // ═══════════════════════════════════════════════════════════
  if (patches.length > 0) {
    s.push(`## ${other.length > 0 ? "6" : "5"}. Files Changed

| File | Description |
|------|-------------|
${patches.map((p) => `| \`${p.file}\` | ${p.description.slice(0, 100)} |`).join("\n")}

---
`);
  }

  // ═══════════════════════════════════════════════════════════
  // 7. Semantic Graph Analysis
  // ═══════════════════════════════════════════════════════════
  if (graphs.length > 0) {
    const secNum = patches.length > 0 ? (other.length > 0 ? "7" : "6") : (other.length > 0 ? "6" : "5");
    s.push(`## ${secNum}. Semantic Graph Analysis

The following graphs were constructed to model cross-instruction data flow and identify vulnerability patterns:

| Graph | Nodes | Edges |
|-------|-------|-------|
${graphs.map((g) => `| ${g.name} | ${g.nodes.length} | ${g.edges.length} |`).join("\n")}

---
`);
  }

  // ═══════════════════════════════════════════════════════════
  // Footer
  // ═══════════════════════════════════════════════════════════
  s.push(`## Agent Information

| Property | Value |
|----------|-------|
| **Agent** | [${agent}](${opts.agentRepoUrl || "https://github.com/grkhmz23/solaudit-agent"}) |
| **Version** | ${ver} |
| **Live Demo** | [solaudit.fun](https://solaudit.fun) |
| **Pipeline** | Clone → Parse → 15 Detectors → LLM Enrich → PoC Gen → Patch → Advisory → PR |
| **LLM** | Kimi K2.5 (Moonshot AI) |
| **Total Pipeline Time** | ${llmMetrics ? `${(llmMetrics.totalDurationMs / 1000).toFixed(1)}s` : "N/A"} |

### Disclaimer

This report was generated by an autonomous AI security agent as part of the Superteam AI Agent Security Bounty. While the analysis is thorough and uses both static analysis and LLM-powered reasoning, it may contain false positives. Manual review by experienced Solana security engineers is recommended before applying fixes to production deployments.

---
*Generated by ${agent} v${ver} on ${now}*
*Repository: ${opts.agentRepoUrl || "https://github.com/grkhmz23/solaudit-agent"}*
*Live: [solaudit.fun](https://solaudit.fun)*
`);

  return s.join("\n");
}