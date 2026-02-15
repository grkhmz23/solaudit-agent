/**
 * V3 Trust Grades
 *
 * Every finding gets a trust grade that determines what severity it can claim.
 *
 * Policy:
 *   Critical → Grade A only
 *   High     → Grade A or B
 *   Medium   → A, B, or C
 *   Low/Info → any grade
 *
 * This prevents the "50 critical findings with no proof" problem.
 */

export type TrustGrade = "A" | "B" | "C" | "D";

export interface TrustGradeDefinition {
  grade: TrustGrade;
  label: string;
  description: string;
  /** What evidence is required for this grade. */
  requires: string[];
  /** Maximum severity this grade can claim. */
  maxSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}

export const TRUST_GRADE_DEFINITIONS: Record<TrustGrade, TrustGradeDefinition> = {
  A: {
    grade: "A",
    label: "Proven",
    description: "Reproducible test/trace with state delta demonstrating exploit",
    requires: [
      "Complete evidence chain (sink + guard absence + attacker control)",
      "Reproducible PoC (test or transaction trace)",
      "Before/after state comparison showing impact",
    ],
    maxSeverity: "CRITICAL",
  },
  B: {
    grade: "B",
    label: "Verified Reasoning",
    description: "Complete evidence chain with deterministic guard absence proof, no runtime PoC",
    requires: [
      "Complete evidence chain (sink + guard absence + attacker control)",
      "Taint path from attacker source to sink",
      "Deterministic guard absence query result",
      "Concrete verification path documented",
    ],
    maxSeverity: "HIGH",
  },
  C: {
    grade: "C",
    label: "Suspicious",
    description: "Heuristic or taint analysis indicates risk, but evidence chain is incomplete",
    requires: [
      "Sink identified",
      "At least one missing guard indicator",
      "Partial reasoning chain",
    ],
    maxSeverity: "MEDIUM",
  },
  D: {
    grade: "D",
    label: "Informational",
    description: "Code quality concern or best-practice deviation, not exploitable",
    requires: [
      "Pattern match or heuristic flag",
    ],
    maxSeverity: "LOW",
  },
};

/**
 * Check if a trust grade is sufficient for a given severity.
 * Returns true if the grade can support the claimed severity.
 */
export function isGradeSufficientForSeverity(
  grade: TrustGrade,
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
): boolean {
  const gradeMaxIndex = { A: 0, B: 1, C: 2, D: 3 };
  const severityMinGrade: Record<string, number> = {
    CRITICAL: 0,  // requires A
    HIGH: 1,      // requires A or B
    MEDIUM: 2,    // requires A, B, or C
    LOW: 3,       // any
    INFO: 3,      // any
  };
  return gradeMaxIndex[grade] <= severityMinGrade[severity];
}

/**
 * Enforce trust grade policy on a finding.
 * If the grade is insufficient for the claimed severity, downgrade severity.
 */
export function enforceGradePolicy(
  grade: TrustGrade,
  claimedSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" {
  if (isGradeSufficientForSeverity(grade, claimedSeverity)) {
    return claimedSeverity;
  }
  return TRUST_GRADE_DEFINITIONS[grade].maxSeverity;
}
