import { parseRepo } from "./parser";
import { ALL_DETECTORS } from "../detectors";
import {
  buildAuthorityFlowGraph,
  buildTokenFlowGraph,
  buildStateMachineGraph,
  buildPDAGraph,
} from "../graphs";
import { checkConstraints } from "./constraints";
import { synthesizeAdversarialAccounts } from "./adversarial";
import { planRemediation } from "../remediation/planner";
import { constructProofs } from "../proof/constructor";
import { generateMarkdownReport, generateJsonReport } from "./report";
import type {
  PipelineContext,
  PipelineResult,
  FindingResult,
  AuditSummary,
  AuditGraph,
  Severity,
} from "../types";

/**
 * Run the full audit pipeline on a repository.
 */
export async function runPipeline(ctx: PipelineContext): Promise<PipelineResult> {
  // ── Stage 1: Ingestion & Normalization ──
  await ctx.onProgress("parsing", 5);
  const program = parseRepo(ctx.repoPath);

  if (program.instructions.length === 0 && program.files.length === 0) {
    throw new Error("No Rust source files or Solana instructions found in repository.");
  }

  // ── Stage 2: Structural Mapping & Semantic Graph Mining ──
  await ctx.onProgress("graph_building", 15);
  const graphs: AuditGraph[] = [
    buildAuthorityFlowGraph(program),
    buildTokenFlowGraph(program),
    buildStateMachineGraph(program),
    buildPDAGraph(program),
  ];

  // ── Stage 3: Candidate Generation ──
  await ctx.onProgress("detecting", 30);

  // 3a. Rule engine (Top 15 playbook)
  let findings: FindingResult[] = [];
  for (const detector of ALL_DETECTORS) {
    const detectorFindings = detector.detect(program);
    findings.push(...detectorFindings);
  }

  // 3b. Constraint checker (formal-ish reasoning)
  await ctx.onProgress("constraint_checking", 45);
  const violations = checkConstraints(program);
  for (const v of violations) {
    // Convert constraint violations to findings if not already captured
    const alreadyCaptured = findings.some(
      (f) => f.location.instruction === v.constraint.subject.split("::")[0] &&
             f.classId === mapConstraintToClass(v.constraint.type)
    );

    if (!alreadyCaptured) {
      findings.push({
        classId: mapConstraintToClass(v.constraint.type),
        className: `Constraint: ${v.constraint.type}`,
        severity: v.severity,
        title: v.message,
        location: {
          file: "constraint-analysis",
          line: 0,
          instruction: v.constraint.subject,
        },
        confidence: 0.65,
        hypothesis: `Constraint violation: expected ${v.constraint.expected}, found ${v.constraint.actual || "missing"}`,
      });
    }
  }

  // 3c. Adversarial account synthesis
  await ctx.onProgress("adversarial_synthesis", 50);
  const adversarialPerms = synthesizeAdversarialAccounts(program);
  // Adversarial synthesis adds context to existing findings, not new findings
  // But critical permutations with no matching finding create info-level notes
  for (const perm of adversarialPerms) {
    if (perm.severity === "critical") {
      const hasMatching = findings.some(
        (f) => f.location.instruction === perm.instruction && f.severity === "CRITICAL"
      );
      if (!hasMatching) {
        // Lower-confidence finding from adversarial synthesis
        findings.push({
          classId: 0,
          className: "Adversarial Account Synthesis",
          severity: "INFO",
          title: `${perm.instruction}: ${perm.description}`,
          location: { file: "adversarial-synthesis", line: 0, instruction: perm.instruction },
          confidence: 0.50,
          hypothesis: Object.values(perm.accounts).map((a) => a.rationale).join("; "),
        });
      }
    }
  }

  // ── Stage 4: Proof Construction ──
  await ctx.onProgress("proof_construction", 65);
  findings = constructProofs(findings, program, ctx.mode);

  // ── Stage 5: Remediation Planning ──
  if (ctx.mode === "FIX_PLAN" || ctx.mode === "SCAN") {
    await ctx.onProgress("remediation_planning", 80);
    findings = planRemediation(findings, program);
  }

  // ── Stage 6: Deduplication & Ranking ──
  await ctx.onProgress("finalizing", 90);
  findings = deduplicateFindings(findings);
  findings = rankFindings(findings);

  // ── Stage 7: Report Assembly ──
  await ctx.onProgress("reporting", 95);
  const summary = buildSummary(findings, program);
  const reportMarkdown = generateMarkdownReport(program, findings, summary, graphs);
  const reportJson = generateJsonReport(program, findings, summary, graphs);

  await ctx.onProgress("complete", 100);

  return {
    program,
    findings,
    graphs,
    summary,
    reportMarkdown,
    reportJson,
  };
}

function mapConstraintToClass(type: string): number {
  switch (type) {
    case "authority_chain": return 1;
    case "pda_consistency": return 3;
    case "balance_conservation": return 9;
    default: return 0;
  }
}

function deduplicateFindings(findings: FindingResult[]): FindingResult[] {
  const seen = new Map<string, FindingResult>();

  for (const f of findings) {
    const key = `${f.classId}:${f.location.file}:${f.location.line}:${f.location.instruction}`;
    const existing = seen.get(key);
    if (!existing || f.confidence > existing.confidence) {
      seen.set(key, f);
    }
  }

  return [...seen.values()];
}

function rankFindings(findings: FindingResult[]): FindingResult[] {
  const severityWeight: Record<Severity, number> = {
    CRITICAL: 100,
    HIGH: 75,
    MEDIUM: 50,
    LOW: 25,
    INFO: 10,
  };

  return findings.sort((a, b) => {
    const scoreA = severityWeight[a.severity] * a.confidence;
    const scoreB = severityWeight[b.severity] * b.confidence;
    return scoreB - scoreA;
  });
}

function buildSummary(findings: FindingResult[], program: any): AuditSummary {
  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;
  const infoCount = findings.filter((f) => f.severity === "INFO").length;

  const shipReady = criticalCount === 0 && highCount === 0;

  let recommendation: string;
  if (criticalCount > 0) {
    recommendation = `Do not ship. ${criticalCount} critical issue(s) must be resolved immediately.`;
  } else if (highCount > 0) {
    recommendation = `Do not ship. ${highCount} high severity issue(s) require remediation.`;
  } else if (mediumCount > 0) {
    recommendation = `Ship with caution. ${mediumCount} medium severity issue(s) should be addressed.`;
  } else {
    recommendation = "Ship ready. No significant issues found.";
  }

  return {
    shipReady,
    totalFindings: findings.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    infoCount,
    recommendation,
    programName: program.name,
    framework: program.framework,
    instructionCount: program.instructions.length,
    accountStructCount: program.accounts.length,
  };
}
