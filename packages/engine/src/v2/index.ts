/**
 * V2 Pipeline Entrypoint
 *
 * Stages:
 *   Phase 1: Parse (tree-sitter AST + constraint extraction)
 *   Phase 2: Candidate generation (deterministic, sink-first)
 *   Phase 3: LLM confirmation (broad-select + deep-investigate)
 *   Phase 4: PoC validation (optional, feature-flagged)
 *   Phase 5: Finding assembly + report
 *   Phase 6: Hybrid mode (compare V1 vs V2)
 */

import { loadV2Config, type V2Config } from "./config";
import { parseRepoV2 } from "./parser/index";
import { generateCandidates } from "./analyzer/candidates";
import { runLLMConfirmation } from "./analyzer/llm-confirm";
import { compareV1V2 } from "./analyzer/hybrid";
import { validatePoCs, type PoCJob } from "./poc/index";
import { buildV2Summary, buildV2FullReport, buildV2Advisory } from "./report/index";
import type {
  ParsedProgramV2,
  VulnCandidate,
  V2Finding,
  V2PipelineResult,
  V2Metrics,
  FindingStatus,
  CandidateSeverity,
  LLMConfirmation,
  PoCValidationResult,
  HybridComparison,
} from "./types";
import type { PipelineContext, PipelineResult, FindingResult } from "../types";

export { loadV2Config, type V2Config } from "./config";
export { parseRepoV2 } from "./parser/index";
export type * from "./types";

/**
 * Run the V2 pipeline.
 */
export async function runPipelineV2(
  ctx: PipelineContext,
): Promise<V2PipelineResult> {
  const config = loadV2Config();
  const t0 = Date.now();

  const metrics: V2Metrics = {
    parseDurationMs: 0,
    candidateCount: 0,
    llmSelectDurationMs: 0,
    llmDeepDiveDurationMs: 0,
    llmDeepDiveCount: 0,
    llmConfirmedCount: 0,
    llmRejectedCount: 0,
    pocValidatedCount: 0,
    pocProvenCount: 0,
    totalDurationMs: 0,
  };

  // ── Phase 1: Parse ──
  await ctx.onProgress("v2_parsing", 5);
  console.log("[v2] Phase 1: Parsing with tree-sitter...");
  const program = await parseRepoV2(ctx.repoPath);
  metrics.parseDurationMs = program.parseDurationMs;
  console.log(
    `[v2] Parsed: ${program.instructions.length} instructions, ` +
    `${program.accountStructs.length} account structs, ` +
    `${program.sinks.length} sinks, ` +
    `${program.cpiCalls.length} CPI calls, ` +
    `${program.pdaDerivations.length} PDA derivations ` +
    `(${program.parseDurationMs}ms)`,
  );

  if (program.instructions.length === 0 && program.files.length === 0) {
    throw new Error("[v2] No Rust source files or Solana instructions found.");
  }

  if (program.parseErrors.length > 0) {
    console.warn(`[v2] Parse warnings: ${program.parseErrors.length}`);
    for (const e of program.parseErrors.slice(0, 5)) {
      console.warn(`  ${e}`);
    }
  }

  // ── Phase 2: Candidate Generation ──
  await ctx.onProgress("v2_candidates", 20);
  console.log("[v2] Phase 2: Generating candidates (sink-first)...");
  const candidates = generateCandidates(program);
  metrics.candidateCount = candidates.length;

  const critCandidates = candidates.filter((c) => c.severity === "CRITICAL").length;
  const highCandidates = candidates.filter((c) => c.severity === "HIGH").length;
  console.log(
    `[v2] Generated ${candidates.length} candidates ` +
    `(${critCandidates} CRITICAL, ${highCandidates} HIGH)`,
  );

  // ── Phase 3: LLM Confirmation ──
  const confirmations = new Map<number, LLMConfirmation>();

  if (config.llmConfirm && candidates.length > 0) {
    await ctx.onProgress("v2_llm_confirm", 35);
    console.log("[v2] Phase 3: LLM confirmation loop...");
    try {
      const result = await runLLMConfirmation(candidates, program, config);
      for (const c of result.confirmations) {
        confirmations.set(c.candidateId, c);
      }
      metrics.llmSelectDurationMs = result.metrics.selectDurationMs;
      metrics.llmDeepDiveDurationMs = result.metrics.deepDiveDurationMs;
      metrics.llmDeepDiveCount = result.metrics.deepDiveCount;
      metrics.llmConfirmedCount = result.metrics.confirmedCount;
      metrics.llmRejectedCount = result.metrics.rejectedCount;
    } catch (e: any) {
      console.error(`[v2] Phase 3 failed (non-fatal): ${e.message}`);
    }
  } else {
    console.log("[v2] Phase 3: Skipped (disabled or no candidates)");
  }

  // ── Phase 4: PoC Validation (feature-flagged) ──
  const pocResults = new Map<number, PoCValidationResult>();

  if (config.pocValidate) {
    await ctx.onProgress("v2_poc_validate", 65);
    console.log("[v2] Phase 4: PoC validation (ON)...");
    const pocJobs: PoCJob[] = candidates
      .filter((c) => {
        const conf = confirmations.get(c.id);
        return (
          conf?.verdict === "confirmed" ||
          (!conf && c.confidence >= 0.85 && c.severity === "CRITICAL")
        );
      })
      .map((c) => ({
        candidateId: c.id,
        candidate: c,
        confirmation: confirmations.get(c.id) || {
          candidateId: c.id, verdict: "uncertain" as const,
          title: c.reason.slice(0, 120), impact: c.reason,
          exploitability: "unknown" as const, proofPlan: [], fix: [],
          confidence: c.confidence * 100, llmStatus: "skipped" as const,
        },
      }));

    const pocMap = await validatePoCs(pocJobs, program, config);
    for (const [id, result] of pocMap) {
      pocResults.set(id, result);
      metrics.pocValidatedCount++;
      if (result.status === "proven") metrics.pocProvenCount++;
    }
    console.log(
      `[v2] PoC: ${metrics.pocValidatedCount} validated, ${metrics.pocProvenCount} proven`,
    );
  } else {
    console.log("[v2] Phase 4: PoC validation disabled");
  }

  // ── Phase 5: Finding Assembly ──
  await ctx.onProgress("v2_reporting", 85);
  console.log("[v2] Phase 5: Assembling findings...");
  const findings = assembleFindings(candidates, confirmations, pocResults);

  const statusCounts = {
    PROVEN: findings.filter((f) => f.status === "PROVEN").length,
    LIKELY: findings.filter((f) => f.status === "LIKELY").length,
    NEEDS_HUMAN: findings.filter((f) => f.status === "NEEDS_HUMAN").length,
    REJECTED: findings.filter((f) => f.status === "REJECTED").length,
  };
  console.log(
    `[v2] Findings: ${findings.length} total ` +
    `(${statusCounts.PROVEN} PROVEN, ${statusCounts.LIKELY} LIKELY, ` +
    `${statusCounts.REJECTED} REJECTED, ${statusCounts.NEEDS_HUMAN} NEEDS_HUMAN)`,
  );

  metrics.totalDurationMs = Date.now() - t0;
  await ctx.onProgress("v2_complete", 100);
  console.log(
    `[v2] Complete: ${findings.length - statusCounts.REJECTED} actionable in ${metrics.totalDurationMs}ms`,
  );

  return { program, candidates, findings, metrics };
}

// ─── Finding Assembly ───────────────────────────────────────

function assembleFindings(
  candidates: VulnCandidate[],
  confirmations: Map<number, LLMConfirmation>,
  pocResults: Map<number, PoCValidationResult>,
): V2Finding[] {
  const findings: V2Finding[] = [];
  let findingId = 0;

  for (const candidate of candidates) {
    const llm = confirmations.get(candidate.id);
    const poc = pocResults.get(candidate.id);

    let status: FindingStatus;
    if (poc?.status === "proven") {
      status = "PROVEN";
    } else if (llm?.verdict === "confirmed") {
      status = "LIKELY";
    } else if (llm?.verdict === "rejected") {
      status = "REJECTED";
    } else if (llm?.verdict === "uncertain") {
      status = "NEEDS_HUMAN";
    } else if (!llm && candidate.confidence >= 0.80 && candidate.severity === "CRITICAL") {
      status = "LIKELY";
    } else if (!llm && candidate.confidence >= 0.70) {
      status = "NEEDS_HUMAN";
    } else {
      status = "REJECTED";
    }

    let finalSeverity: CandidateSeverity = candidate.severity;
    if (llm?.verdict === "confirmed" && llm.confidence > 80 && llm.exploitability === "easy" && finalSeverity !== "CRITICAL") {
      finalSeverity = "CRITICAL";
    } else if (llm?.verdict === "confirmed" && llm.confidence < 40 && finalSeverity === "CRITICAL") {
      finalSeverity = "HIGH";
    }

    let finalConfidence = candidate.confidence;
    if (llm?.verdict === "confirmed") {
      finalConfidence = Math.min(1.0, candidate.confidence * 0.4 + (llm.confidence / 100) * 0.6);
    } else if (llm?.verdict === "rejected") {
      finalConfidence = Math.max(0, candidate.confidence * 0.2);
    } else if (llm?.verdict === "uncertain") {
      finalConfidence = candidate.confidence * 0.6;
    }
    if (poc?.status === "proven") {
      finalConfidence = Math.max(finalConfidence, 0.95);
    }

    findings.push({
      id: findingId++,
      candidate,
      llmConfirmation: llm,
      pocResult: poc,
      status,
      finalSeverity,
      finalConfidence,
    });
  }

  const statusOrder: Record<FindingStatus, number> = {
    PROVEN: 0, LIKELY: 1, NEEDS_HUMAN: 2, REJECTED: 3,
  };
  const sevWeight: Record<CandidateSeverity, number> = {
    CRITICAL: 100, HIGH: 75, MEDIUM: 50, LOW: 25, INFO: 10,
  };

  findings.sort((a, b) => {
    const sd = statusOrder[a.status] - statusOrder[b.status];
    if (sd !== 0) return sd;
    return sevWeight[b.finalSeverity] * b.finalConfidence - sevWeight[a.finalSeverity] * a.finalConfidence;
  });

  return findings;
}

// ─── V1 Compatibility ───────────────────────────────────────

export function v2ResultToV1(v2: V2PipelineResult): PipelineResult {
  const actionable = v2.findings.filter((f) => f.status !== "REJECTED");
  const findings: FindingResult[] = actionable.map((f) => ({
    classId: vulnClassToId(f.candidate.vulnClass),
    className: f.candidate.vulnClass,
    severity: f.finalSeverity,
    title: f.llmConfirmation?.title || f.candidate.reason.slice(0, 120),
    location: {
      file: f.candidate.ref.file,
      line: f.candidate.ref.startLine,
      endLine: f.candidate.ref.endLine,
      instruction: f.candidate.instruction,
    },
    confidence: f.finalConfidence,
    hypothesis: f.llmConfirmation?.impact || f.candidate.reason,
    proofPlan: f.llmConfirmation
      ? { steps: f.llmConfirmation.proofPlan, deltaSchema: undefined }
      : undefined,
    fixPlan: f.llmConfirmation
      ? { pattern: f.candidate.vulnClass, description: f.llmConfirmation.fix.join("; ") }
      : undefined,
    blastRadius: undefined,
  }));

  const sev = (s: string) => findings.filter((f) => f.severity === s).length;
  const cc = sev("CRITICAL"), hc = sev("HIGH"), mc = sev("MEDIUM"), lc = sev("LOW"), ic = sev("INFO");

  return {
    program: {
      name: v2.program.name, programId: v2.program.programId,
      framework: v2.program.framework,
      files: [], instructions: [], accounts: [], cpiCalls: [], pdaDerivations: [], errorCodes: [],
    },
    findings,
    graphs: [],
    summary: {
      shipReady: cc === 0 && hc === 0, totalFindings: findings.length,
      criticalCount: cc, highCount: hc, mediumCount: mc, lowCount: lc, infoCount: ic,
      recommendation: cc > 0 ? `Do not ship. ${cc} critical issue(s).`
        : hc > 0 ? `Do not ship. ${hc} high severity issue(s).`
        : mc > 0 ? `Ship with caution. ${mc} medium issue(s).` : "Ship ready.",
      programName: v2.program.name, framework: v2.program.framework,
      instructionCount: v2.program.instructions.length,
      accountStructCount: v2.program.accountStructs.length,
    },
    reportMarkdown: "", reportJson: {},
  };
}

// ─── Hybrid Mode ────────────────────────────────────────────

export async function runHybridPipeline(
  ctx: PipelineContext,
  v1Runner: (ctx: PipelineContext) => Promise<PipelineResult>,
): Promise<V2PipelineResult> {
  console.log("[hybrid] Running V1 and V2 in parallel...");
  const [v1Result, v2Result] = await Promise.all([
    v1Runner(ctx).catch((e: any) => { console.error(`[hybrid] V1 failed: ${e.message}`); return null; }),
    runPipelineV2(ctx).catch((e: any) => { console.error(`[hybrid] V2 failed: ${e.message}`); return null; }),
  ]);

  if (!v2Result) throw new Error("[hybrid] V2 pipeline failed");

  if (v1Result) {
    const comparison = compareV1V2(v1Result.findings, v2Result.findings);
    v2Result.v1Findings = v1Result.findings;
    v2Result.hybridComparison = comparison;
    console.log(
      `[hybrid] V1=${comparison.v1TotalFindings} V2=${comparison.v2TotalFindings} ` +
      `overlap=${comparison.overlap} V1-FP-rejected=${comparison.v1FalsePositivesRejected} V2-novel=${comparison.v2NovelFindings}`,
    );
  }

  return v2Result;
}

function vulnClassToId(vc: string): number {
  const map: Record<string, number> = {
    missing_signer: 1, missing_owner: 2, pda_derivation: 3, arbitrary_cpi: 4,
    type_confusion: 5, reinit: 6, close_revive: 7, unchecked_realloc: 8,
    integer_overflow: 9, state_machine: 10, remaining_accounts: 11,
    oracle_validation: 12, token_authority_mismatch: 13, stale_post_cpi: 14,
    duplicate_account: 15,
  };
  return map[vc] || 0;
}
