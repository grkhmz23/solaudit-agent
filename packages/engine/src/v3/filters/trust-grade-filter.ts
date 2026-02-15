/**
 * V3 Trust Grade Filter
 *
 * Applies Trust Grade enforcement to V2 findings.
 * Findings without sufficient evidence get downgraded,
 * preventing unproven CRITICALs from polluting reports.
 *
 * Grade A: Proven — PoC exploit exists (requires witness transaction)
 * Grade B: Verified — evidence chain complete (sink + missing guard + bypass path)
 * Grade C: Suspicious — partial evidence (sink found, guard analysis incomplete)
 * Grade D: Info — structural observation only (no evidence chain)
 *
 * Policy:
 *   CRITICAL requires Grade A or B
 *   HIGH requires Grade A, B, or C
 *   MEDIUM+ allows any grade
 *   Grade D findings get capped at LOW
 */

import type { V2Finding, VulnCandidate, CandidateSeverity, ParsedProgramV2 } from "../../v2/types";
import type { ActualFinding } from "../evaluation/scorer";

// ─── Trust Grades ──────────────────────────────────────────

export type TrustGrade = "A" | "B" | "C" | "D";

export interface GradedFinding {
  /** Original V2 finding. */
  finding: V2Finding;
  /** Assigned trust grade. */
  grade: TrustGrade;
  /** Why this grade was assigned. */
  gradeReason: string;
  /** Original severity before enforcement. */
  originalSeverity: CandidateSeverity;
  /** Enforced severity after grade policy. */
  enforcedSeverity: CandidateSeverity;
  /** Whether severity was downgraded. */
  wasDowngraded: boolean;
}

// ─── Grade Assignment ──────────────────────────────────────

/**
 * Compute the trust grade for a V2 finding.
 *
 * Grade A: Has PoC validation result with status "proven"
 * Grade B: Has LLM confirmation with high confidence AND
 *          the candidate has a complete reasoning chain
 *          (identified sink + guard absence + specific bypass)
 * Grade C: Has LLM confirmation OR the candidate has
 *          concrete structural evidence (specific accounts, constraints)
 * Grade D: Everything else — structural observation without evidence
 */
export function assignGrade(
  finding: V2Finding,
  program: ParsedProgramV2,
): { grade: TrustGrade; reason: string } {
  // Grade A: proven via PoC
  if (finding.pocResult?.status === "proven") {
    return { grade: "A", reason: "PoC exploit validated successfully" };
  }

  // Grade B: LLM confirmed with high confidence + structural evidence
  if (
    finding.llmConfirmation?.verdict === "confirmed" &&
    finding.llmConfirmation.confidence >= 80
  ) {
    const hasConcreteEvidence = checkStructuralEvidence(finding.candidate, program);
    if (hasConcreteEvidence) {
      return {
        grade: "B",
        reason: `LLM confirmed (${finding.llmConfirmation.confidence}%) with structural evidence: ${hasConcreteEvidence}`,
      };
    }
    return {
      grade: "C",
      reason: `LLM confirmed (${finding.llmConfirmation.confidence}%) but structural evidence incomplete`,
    };
  }

  // Grade C: partial evidence — the candidate has concrete structural info
  const structuralEvidence = checkStructuralEvidence(finding.candidate, program);
  if (structuralEvidence) {
    return {
      grade: "C",
      reason: `Structural evidence found: ${structuralEvidence}`,
    };
  }

  // Grade C: LLM said uncertain with some reasoning
  if (
    finding.llmConfirmation?.verdict === "uncertain" &&
    finding.llmConfirmation.confidence >= 50
  ) {
    return {
      grade: "C",
      reason: `LLM uncertain (${finding.llmConfirmation.confidence}%) — needs manual review`,
    };
  }

  // Grade D: no meaningful evidence
  return {
    grade: "D",
    reason: "No evidence chain — structural observation only",
  };
}

/**
 * Check if a candidate has concrete structural evidence.
 * Returns a description of the evidence found, or null if insufficient.
 */
function checkStructuralEvidence(
  candidate: VulnCandidate,
  program: ParsedProgramV2,
): string | null {
  const evidence: string[] = [];

  // Evidence 1: Candidate references specific accounts
  if (candidate.involvedAccounts.length > 0) {
    evidence.push(
      `accounts [${candidate.involvedAccounts.map((a) => a.name).join(", ")}]`,
    );
  }

  // Evidence 2: Candidate is linked to a specific sink
  if (candidate.sinkId !== undefined) {
    const sink = program.sinks.find((s) => s.id === candidate.sinkId);
    if (sink) {
      evidence.push(`linked to ${sink.type} sink at line ${sink.ref.startLine}`);
    }
  }

  // Evidence 3: The instruction has an Anchor accounts struct
  const ix = program.instructions.find((i) => i.name === candidate.instruction);
  if (ix?.accountsTypeName) {
    const struct = program.accountStructs.find(
      (s) => s.name === ix.accountsTypeName,
    );
    if (struct) {
      evidence.push(`accounts struct '${struct.name}' analyzed`);
    }
  }

  // Evidence 4: The candidate references a narrow code region
  if (candidate.ref.endLine - candidate.ref.startLine <= 20) {
    evidence.push(`narrow code region (lines ${candidate.ref.startLine}-${candidate.ref.endLine})`);
  }

  // Evidence 5: V3 detector origin (id >= 10000 means V3 detector produced it)
  if (candidate.id >= 10_000) {
    evidence.push("V3 detector analysis");
  }

  // 1 evidence point is sufficient for Grade C
  if (evidence.length >= 1) {
    return evidence.join("; ");
  }

  return null;
}

// ─── Severity Enforcement ──────────────────────────────────

const SEVERITY_ORDER: Record<CandidateSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

/**
 * Enforce grade-based severity caps.
 *
 * Grade A: no cap
 * Grade B: capped at CRITICAL
 * Grade C: capped at HIGH
 * Grade D: capped at MEDIUM (still participates in scoring, but low priority)
 */
export function enforceSeverity(
  severity: CandidateSeverity,
  grade: TrustGrade,
): CandidateSeverity {
  const caps: Record<TrustGrade, CandidateSeverity> = {
    A: "CRITICAL",
    B: "CRITICAL",
    C: "HIGH",
    D: "MEDIUM",
  };

  const cap = caps[grade];
  if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[cap]) {
    return cap;
  }
  return severity;
}

// ─── Main Filter ───────────────────────────────────────────

/**
 * Apply trust grade enforcement to all V2 findings.
 * Returns graded findings with enforced severities.
 */
export function applyTrustGradeFilter(
  findings: V2Finding[],
  program: ParsedProgramV2,
): GradedFinding[] {
  return findings
    .filter((f) => f.status !== "REJECTED")
    .map((f) => {
      const { grade, reason } = assignGrade(f, program);
      const originalSeverity = f.finalSeverity;
      const enforcedSeverity = enforceSeverity(originalSeverity, grade);

      return {
        finding: f,
        grade,
        gradeReason: reason,
        originalSeverity,
        enforcedSeverity,
        wasDowngraded: SEVERITY_ORDER[enforcedSeverity] < SEVERITY_ORDER[originalSeverity],
      };
    });
}

/**
 * Convert graded findings to ActualFinding format for scoring.
 * Only includes findings with enforced severity >= MEDIUM.
 */
export function gradedToActual(graded: GradedFinding[]): ActualFinding[] {
  return graded
    .filter((g) => SEVERITY_ORDER[g.enforcedSeverity] >= SEVERITY_ORDER["MEDIUM"])
    .map((g) => ({
      vulnClass: g.finding.candidate.vulnClass,
      severity: g.enforcedSeverity,
      instruction: g.finding.candidate.instruction,
      file: g.finding.candidate.ref.file,
      accountNames: g.finding.candidate.involvedAccounts.map((a) => a.name),
      confidence: g.finding.finalConfidence,
      status: g.finding.status,
      title:
        g.finding.llmConfirmation?.title ||
        g.finding.candidate.reason.slice(0, 120),
    }));
}

/**
 * Get grade distribution summary.
 */
export function gradeDistribution(
  graded: GradedFinding[],
): { A: number; B: number; C: number; D: number; downgraded: number } {
  const dist = { A: 0, B: 0, C: 0, D: 0, downgraded: 0 };
  for (const g of graded) {
    dist[g.grade]++;
    if (g.wasDowngraded) dist.downgraded++;
  }
  return dist;
}
