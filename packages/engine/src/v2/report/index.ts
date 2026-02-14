/**
 * Phase 5 — V2 Report Assembly.
 *
 * Produces:
 * - DB-safe summary (≤100KB, no file bodies, no full PoC logs)
 * - Full report JSON for R2 artifact upload
 * - Markdown advisory from V2 findings
 *
 * Storage safety:
 * - summary field: only metadata, counts, truncated excerpts
 * - Full JSON/logs: uploaded as R2 artifacts, referenced by objectKey
 */

import type {
  V2PipelineResult,
  V2Finding,
  V2Metrics,
  ParsedProgramV2,
  HybridComparison,
} from "../types";

// ─── DB-Safe Summary (<= 100KB) ────────────────────────────

export interface V2Summary {
  engine: "v2";
  programName: string;
  programId?: string;
  framework: string;
  fileCount: number;
  instructionCount: number;
  accountStructCount: number;
  sinkCount: number;

  candidateCount: number;
  findingCount: number;
  actionableCount: number;

  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
  byClass: Record<string, number>;

  /** Top 20 actionable findings (truncated). */
  topFindings: {
    id: number;
    status: string;
    severity: string;
    confidence: number;
    vulnClass: string;
    instruction: string;
    file: string;
    line: number;
    title: string;
    impact: string;
  }[];

  metrics: V2Metrics;
  hybridComparison?: HybridComparison;
  shipReady: boolean;
  recommendation: string;
}

/**
 * Build a DB-safe summary from V2 pipeline results.
 * Guaranteed to serialize to <100KB JSON.
 */
export function buildV2Summary(result: V2PipelineResult): V2Summary {
  const actionable = result.findings.filter((f) => f.status !== "REJECTED");

  const byStatus: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byClass: Record<string, number> = {};

  for (const f of result.findings) {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    bySeverity[f.finalSeverity] = (bySeverity[f.finalSeverity] || 0) + 1;
    byClass[f.candidate.vulnClass] = (byClass[f.candidate.vulnClass] || 0) + 1;
  }

  const critCount = bySeverity["CRITICAL"] || 0;
  const highCount = bySeverity["HIGH"] || 0;
  const medCount = bySeverity["MEDIUM"] || 0;

  const topFindings = actionable.slice(0, 20).map((f) => ({
    id: f.id,
    status: f.status,
    severity: f.finalSeverity,
    confidence: Math.round(f.finalConfidence * 100) / 100,
    vulnClass: f.candidate.vulnClass,
    instruction: f.candidate.instruction,
    file: f.candidate.ref.file,
    line: f.candidate.ref.startLine,
    title: (
      f.llmConfirmation?.title ||
      f.candidate.reason.slice(0, 120)
    ).slice(0, 200),
    impact: (
      f.llmConfirmation?.impact ||
      f.candidate.reason
    ).slice(0, 300),
  }));

  return {
    engine: "v2",
    programName: result.program.name,
    programId: result.program.programId,
    framework: result.program.framework,
    fileCount: result.program.files.length,
    instructionCount: result.program.instructions.length,
    accountStructCount: result.program.accountStructs.length,
    sinkCount: result.program.sinks.length,
    candidateCount: result.candidates.length,
    findingCount: result.findings.length,
    actionableCount: actionable.length,
    byStatus,
    bySeverity,
    byClass,
    topFindings,
    metrics: result.metrics,
    hybridComparison: result.hybridComparison,
    shipReady: critCount === 0 && highCount === 0,
    recommendation:
      critCount > 0
        ? `Do not ship. ${critCount} critical issue(s) found.`
        : highCount > 0
          ? `Do not ship. ${highCount} high severity issue(s) found.`
          : medCount > 0
            ? `Ship with caution. ${medCount} medium issue(s).`
            : "Ship ready. No critical or high severity issues.",
  };
}

// ─── Full Report JSON (for R2 upload) ──────────────────────

/**
 * Build the full report JSON for R2 artifact storage.
 * This can be large — NOT stored in DB.
 */
export function buildV2FullReport(result: V2PipelineResult): object {
  return {
    engine: "v2",
    timestamp: new Date().toISOString(),
    program: {
      name: result.program.name,
      programId: result.program.programId,
      framework: result.program.framework,
      files: result.program.files,
      instructionCount: result.program.instructions.length,
      accountStructCount: result.program.accountStructs.length,
      sinkCount: result.program.sinks.length,
      cpiCallCount: result.program.cpiCalls.length,
      pdaDerivationCount: result.program.pdaDerivations.length,
      parseErrors: result.program.parseErrors,
    },
    candidates: result.candidates.map((c) => ({
      id: c.id,
      vulnClass: c.vulnClass,
      severity: c.severity,
      confidence: c.confidence,
      instruction: c.instruction,
      ref: c.ref,
      involvedAccounts: c.involvedAccounts,
      reason: c.reason,
      sinkId: c.sinkId,
      fingerprint: c.fingerprint,
      excerpt: c.excerpt,
    })),
    findings: result.findings.map((f) => ({
      id: f.id,
      status: f.status,
      finalSeverity: f.finalSeverity,
      finalConfidence: f.finalConfidence,
      candidate: {
        id: f.candidate.id,
        vulnClass: f.candidate.vulnClass,
        instruction: f.candidate.instruction,
        ref: f.candidate.ref,
        reason: f.candidate.reason,
      },
      llmConfirmation: f.llmConfirmation
        ? {
            verdict: f.llmConfirmation.verdict,
            title: f.llmConfirmation.title,
            impact: f.llmConfirmation.impact,
            exploitability: f.llmConfirmation.exploitability,
            proofPlan: f.llmConfirmation.proofPlan,
            fix: f.llmConfirmation.fix,
            confidence: f.llmConfirmation.confidence,
            llmStatus: f.llmConfirmation.llmStatus,
          }
        : undefined,
      pocResult: f.pocResult
        ? {
            status: f.pocResult.status,
            testFile: f.pocResult.testFile,
            compileAttempts: f.pocResult.compileAttempts,
            executionTimeMs: f.pocResult.executionTimeMs,
            logsArtifactKey: f.pocResult.logsArtifactKey,
          }
        : undefined,
    })),
    metrics: result.metrics,
    hybridComparison: result.hybridComparison,
  };
}

// ─── Markdown Advisory ─────────────────────────────────────

/**
 * Generate a markdown advisory from V2 findings.
 */
export function buildV2Advisory(result: V2PipelineResult): string {
  const actionable = result.findings.filter((f) => f.status !== "REJECTED");
  const proven = actionable.filter((f) => f.status === "PROVEN");
  const likely = actionable.filter((f) => f.status === "LIKELY");
  const needsHuman = actionable.filter((f) => f.status === "NEEDS_HUMAN");

  const lines: string[] = [];
  lines.push(`# Security Audit Report — ${result.program.name}`);
  lines.push("");
  lines.push(`**Engine:** SolAudit V2 (tree-sitter + LLM confirmation)`);
  lines.push(`**Framework:** ${result.program.framework}`);
  if (result.program.programId) {
    lines.push(`**Program ID:** \`${result.program.programId}\``);
  }
  lines.push(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Files analyzed | ${result.program.files.length} |`);
  lines.push(`| Instructions | ${result.program.instructions.length} |`);
  lines.push(`| Candidates generated | ${result.candidates.length} |`);
  lines.push(`| Findings (actionable) | ${actionable.length} |`);
  lines.push(`| PROVEN | ${proven.length} |`);
  lines.push(`| LIKELY | ${likely.length} |`);
  lines.push(`| NEEDS_HUMAN | ${needsHuman.length} |`);
  lines.push(`| Total pipeline time | ${(result.metrics.totalDurationMs / 1000).toFixed(1)}s |`);
  lines.push("");

  if (actionable.length === 0) {
    lines.push(
      "> No actionable vulnerabilities found. The program appears secure based on automated analysis.",
    );
    return lines.join("\n");
  }

  // Findings
  const statusOrder = ["PROVEN", "LIKELY", "NEEDS_HUMAN"] as const;
  const statusEmoji: Record<string, string> = {
    PROVEN: "🔴",
    LIKELY: "🟠",
    NEEDS_HUMAN: "🟡",
  };

  for (const status of statusOrder) {
    const group = actionable.filter((f) => f.status === status);
    if (group.length === 0) continue;

    lines.push(`## ${statusEmoji[status]} ${status} Findings (${group.length})`);
    lines.push("");

    for (const f of group) {
      const title =
        f.llmConfirmation?.title ||
        `${f.candidate.vulnClass} in ${f.candidate.instruction}`;

      lines.push(
        `### ${f.finalSeverity}: ${title}`,
      );
      lines.push("");
      lines.push(`- **Class:** ${f.candidate.vulnClass}`);
      lines.push(`- **Instruction:** \`${f.candidate.instruction}\``);
      lines.push(
        `- **Location:** ${f.candidate.ref.file}:${f.candidate.ref.startLine}`,
      );
      lines.push(
        `- **Confidence:** ${Math.round(f.finalConfidence * 100)}%`,
      );

      if (f.llmConfirmation) {
        lines.push(`- **Exploitability:** ${f.llmConfirmation.exploitability}`);
        lines.push("");
        lines.push(`**Impact:** ${f.llmConfirmation.impact}`);

        if (f.llmConfirmation.proofPlan.length > 0) {
          lines.push("");
          lines.push("**Proof Plan:**");
          for (const step of f.llmConfirmation.proofPlan) {
            lines.push(`1. ${step}`);
          }
        }

        if (f.llmConfirmation.fix.length > 0) {
          lines.push("");
          lines.push("**Recommended Fix:**");
          for (const step of f.llmConfirmation.fix) {
            lines.push(`1. ${step}`);
          }
        }
      } else {
        lines.push("");
        lines.push(`**Reason:** ${f.candidate.reason}`);
      }

      if (f.pocResult) {
        lines.push("");
        lines.push(
          `**PoC Status:** ${f.pocResult.status}` +
            (f.pocResult.testFile ? ` (${f.pocResult.testFile})` : ""),
        );
      }

      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // Metrics
  lines.push("## Pipeline Metrics");
  lines.push("");
  lines.push("| Phase | Duration |");
  lines.push("|-------|----------|");
  lines.push(`| Parse (tree-sitter) | ${result.metrics.parseDurationMs}ms |`);
  lines.push(
    `| LLM Select | ${result.metrics.llmSelectDurationMs}ms |`,
  );
  lines.push(
    `| LLM Deep Dive (${result.metrics.llmDeepDiveCount} findings) | ${result.metrics.llmDeepDiveDurationMs}ms |`,
  );
  lines.push(
    `| LLM Confirmed / Rejected | ${result.metrics.llmConfirmedCount} / ${result.metrics.llmRejectedCount} |`,
  );
  lines.push(`| Total | ${result.metrics.totalDurationMs}ms |`);

  if (result.hybridComparison) {
    const hc = result.hybridComparison;
    lines.push("");
    lines.push("## Hybrid Comparison (V1 vs V2)");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| V1 findings | ${hc.v1TotalFindings} |`);
    lines.push(`| V2 findings | ${hc.v2TotalFindings} |`);
    lines.push(`| Overlap | ${hc.overlap} |`);
    lines.push(`| V1-only | ${hc.v1OnlyCount} |`);
    lines.push(`| V2-only | ${hc.v2OnlyCount} |`);
    lines.push(
      `| V1 false positives rejected | ${hc.v1FalsePositivesRejected} |`,
    );
    lines.push(`| V2 novel findings | ${hc.v2NovelFindings} |`);
  }

  return lines.join("\n");
}
