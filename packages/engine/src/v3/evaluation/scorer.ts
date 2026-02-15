/**
 * V3 Evaluation Scorer
 *
 * Computes precision, recall, F1, and per-vulnerability-class metrics
 * by matching actual findings against expected findings from the golden suite.
 *
 * Matching algorithm:
 *   1. For each expected finding, search actual findings for a match
 *   2. Match requires: same vuln class + overlapping instruction reference
 *   3. Account name overlap is a bonus (increases match confidence)
 *   4. Unmatched actual findings = false positives
 *   5. Unmatched expected findings = false negatives
 */

import type { VulnClass, CandidateSeverity } from "../../v2/types";
import type { ExpectedFinding, MatchCriteria, GoldenRepo, FalsePositiveTrap } from "./golden-suite";

// ─── Types ───────────────────────────────────────────────────

export interface ActualFinding {
  /** Vulnerability class reported by the engine. */
  vulnClass: VulnClass;
  /** Severity reported. */
  severity: CandidateSeverity;
  /** Instruction(s) referenced. */
  instruction: string;
  /** File referenced. */
  file: string;
  /** Account names referenced. */
  accountNames: string[];
  /** Confidence score from engine. */
  confidence: number;
  /** Status from V2 pipeline. */
  status: string;
  /** Finding title. */
  title: string;
}

export interface MatchResult {
  expectedId: string;
  actualIndex: number | null;
  matched: boolean;
  matchScore: number;
  /** Why the match succeeded or failed. */
  reason: string;
}

export interface RepoEvalResult {
  repoId: string;
  repoName: string;
  /** Pinned commit. */
  commit: string;
  /** Expected findings from golden suite. */
  expected: ExpectedFinding[];
  /** Actual findings from engine. */
  actual: ActualFinding[];
  /** Match results. */
  matches: MatchResult[];
  /** True positives (matched expected findings). */
  truePositives: number;
  /** False positives (actual findings that don't match any expected). */
  falsePositives: number;
  /** False negatives (expected findings with no match). */
  falseNegatives: number;
  /** False positive trap violations (scanner flagged something that's safe). */
  trapViolations: TrapViolation[];

  precision: number;
  recall: number;
  f1: number;

  /** Runtime metrics. */
  runtimeMs: number;
  llmTokensUsed: number;
  llmCostUsd: number;

  /** Per-class breakdown. */
  classBreakdown: ClassMetric[];

  /** Errors during scan. */
  error?: string;
}

export interface TrapViolation {
  trap: FalsePositiveTrap;
  /** The actual finding that incorrectly flagged this. */
  actualFinding: ActualFinding;
}

export interface ClassMetric {
  vulnClass: VulnClass;
  expected: number;
  found: number;
  missed: number;
  falsePositive: number;
  precision: number;
  recall: number;
}

export interface SuiteEvalResult {
  /** Timestamp of the evaluation run. */
  timestamp: string;
  /** Engine version identifier. */
  engineVersion: string;
  /** Per-repo results. */
  repos: RepoEvalResult[];

  /** Aggregate metrics. */
  aggregate: {
    totalExpected: number;
    totalActual: number;
    totalTruePositives: number;
    totalFalsePositives: number;
    totalFalseNegatives: number;
    precision: number;
    recall: number;
    f1: number;
    avgRuntimeMs: number;
    totalLlmTokens: number;
    totalLlmCostUsd: number;
    trapViolationRate: number;
  };

  /** Per-class aggregate metrics. */
  classAggregate: ClassMetric[];

  /** Grade distribution of findings. */
  gradeDistribution?: {
    A: number;
    B: number;
    C: number;
    D: number;
  };
}

// ─── Matching Logic ──────────────────────────────────────────

/**
 * Match an actual finding against expected finding criteria.
 * Returns a score from 0.0 (no match) to 1.0 (perfect match).
 */
export function matchFinding(
  actual: ActualFinding,
  criteria: MatchCriteria,
): number {
  let score = 0;
  let maxScore = 0;

  // Vuln class must match (required, weight: 40%)
  maxScore += 0.4;
  if (actual.vulnClass === criteria.vulnClass) {
    score += 0.4;
  } else if (criteria.altVulnClasses?.includes(actual.vulnClass)) {
    score += 0.3; // Alt class match — slightly lower confidence
  } else {
    return 0; // Hard requirement — no match without class match
  }

  // Instruction overlap (required, weight: 30%)
  maxScore += 0.3;
  const instrMatch = criteria.instructions.some((expected) => {
    const normalizedExpected = expected.toLowerCase();

    // Check primary instruction
    const normalizedActual = actual.instruction.toLowerCase();
    if (
      normalizedActual === normalizedExpected ||
      normalizedActual.includes(normalizedExpected) ||
      normalizedExpected.includes(normalizedActual)
    ) {
      return true;
    }

    // Check instruction aliases (from V3 native instruction remapping)
    const aliases: string[] | undefined = (actual as any)._instructionAliases;
    if (aliases) {
      return aliases.some((alias) => {
        const normalizedAlias = alias.toLowerCase();
        return (
          normalizedAlias === normalizedExpected ||
          normalizedAlias.includes(normalizedExpected) ||
          normalizedExpected.includes(normalizedAlias)
        );
      });
    }

    return false;
  });
  if (instrMatch) {
    score += 0.3;
  } else {
    return 0; // Hard requirement — must reference the right instruction
  }

  // Account name overlap (optional, weight: 15%)
  if (criteria.accountNames && criteria.accountNames.length > 0) {
    maxScore += 0.15;
    const actualLower = actual.accountNames.map((n) => n.toLowerCase());
    const expectedLower = criteria.accountNames.map((n) => n.toLowerCase());
    const overlap = expectedLower.filter((e) =>
      actualLower.some((a) => a.includes(e) || e.includes(a)),
    ).length;
    score += 0.15 * (overlap / expectedLower.length);
  }

  // File match (optional, weight: 10%)
  if (criteria.file) {
    maxScore += 0.1;
    if (
      actual.file.includes(criteria.file) ||
      criteria.file.includes(actual.file)
    ) {
      score += 0.1;
    }
  }

  // Severity check (optional, weight: 5%)
  if (criteria.minSeverity) {
    maxScore += 0.05;
    const sevOrder: Record<string, number> = {
      CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0,
    };
    if ((sevOrder[actual.severity] ?? 0) >= (sevOrder[criteria.minSeverity] ?? 0)) {
      score += 0.05;
    }
  }

  return maxScore > 0 ? score / maxScore : 0;
}

// ─── Scoring ─────────────────────────────────────────────────

/**
 * Score a single repo's evaluation results.
 */
export function scoreRepo(
  repo: GoldenRepo,
  actualFindings: ActualFinding[],
  runtimeMs: number,
  llmTokensUsed: number,
  llmCostUsd: number,
): RepoEvalResult {
  const matches: MatchResult[] = [];
  const matchedActualIndices = new Set<number>();

  // Match each expected finding against actual findings
  for (const expected of repo.expectedFindings) {
    let bestMatch: { index: number; score: number } | null = null;

    for (let i = 0; i < actualFindings.length; i++) {
      if (matchedActualIndices.has(i)) continue;
      const score = matchFinding(actualFindings[i], expected.matchCriteria);
      if (score > 0.6 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { index: i, score };
      }
    }

    if (bestMatch) {
      matchedActualIndices.add(bestMatch.index);
      matches.push({
        expectedId: expected.id,
        actualIndex: bestMatch.index,
        matched: true,
        matchScore: bestMatch.score,
        reason: `Matched with score ${bestMatch.score.toFixed(2)}: ${actualFindings[bestMatch.index].title}`,
      });
    } else {
      matches.push({
        expectedId: expected.id,
        actualIndex: null,
        matched: false,
        matchScore: 0,
        reason: `No matching finding for expected ${expected.vulnClass} in ${expected.instruction}`,
      });
    }
  }

  const truePositives = matches.filter((m) => m.matched).length;
  const falseNegatives = matches.filter((m) => !m.matched).length;

  // False positives: actual findings that matched nothing AND have severity >= MEDIUM
  const falsePositives = actualFindings.filter((_, i) => {
    if (matchedActualIndices.has(i)) return false;
    const f = actualFindings[i];
    return f.severity === "CRITICAL" || f.severity === "HIGH" || f.severity === "MEDIUM";
  }).length;

  // Check false positive traps
  const trapViolations: TrapViolation[] = [];
  for (const trap of repo.falsePositiveTraps) {
    const trapped = actualFindings.find((f) => {
      const classMatch = f.vulnClass === trap.likelyFalseClass;
      const locMatch = trap.location.instruction
        ? f.instruction.toLowerCase().includes(trap.location.instruction.toLowerCase())
        : true;
      return classMatch && locMatch && (f.severity === "CRITICAL" || f.severity === "HIGH");
    });
    if (trapped) {
      trapViolations.push({ trap, actualFinding: trapped });
    }
  }

  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives) : 0;
  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives) : 0;
  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall) : 0;

  // Per-class breakdown
  const classMap = new Map<VulnClass, { expected: number; found: number; fp: number }>();
  for (const ef of repo.expectedFindings) {
    const entry = classMap.get(ef.vulnClass) || { expected: 0, found: 0, fp: 0 };
    entry.expected++;
    classMap.set(ef.vulnClass, entry);
  }
  for (const m of matches) {
    if (m.matched && m.actualIndex !== null) {
      const vc = actualFindings[m.actualIndex].vulnClass;
      const entry = classMap.get(vc) || { expected: 0, found: 0, fp: 0 };
      entry.found++;
      classMap.set(vc, entry);
    }
  }
  // Count FPs per class
  for (let i = 0; i < actualFindings.length; i++) {
    if (!matchedActualIndices.has(i)) {
      const vc = actualFindings[i].vulnClass;
      const entry = classMap.get(vc) || { expected: 0, found: 0, fp: 0 };
      entry.fp++;
      classMap.set(vc, entry);
    }
  }

  const classBreakdown: ClassMetric[] = [...classMap.entries()].map(([vc, data]) => ({
    vulnClass: vc,
    expected: data.expected,
    found: data.found,
    missed: data.expected - data.found,
    falsePositive: data.fp,
    precision: data.found + data.fp > 0 ? data.found / (data.found + data.fp) : 0,
    recall: data.expected > 0 ? data.found / data.expected : 0,
  }));

  return {
    repoId: repo.id,
    repoName: repo.name,
    commit: repo.commitSha,
    expected: repo.expectedFindings,
    actual: actualFindings,
    matches,
    truePositives,
    falsePositives,
    falseNegatives,
    trapViolations,
    precision,
    recall,
    f1,
    runtimeMs,
    llmTokensUsed,
    llmCostUsd,
    classBreakdown,
  };
}

/**
 * Aggregate results across all repos into a suite-level result.
 */
export function aggregateResults(
  repoResults: RepoEvalResult[],
  engineVersion: string,
): SuiteEvalResult {
  const successful = repoResults.filter((r) => !r.error);

  const totalExpected = successful.reduce((s, r) => s + r.expected.length, 0);
  const totalActual = successful.reduce((s, r) => s + r.actual.length, 0);
  const totalTP = successful.reduce((s, r) => s + r.truePositives, 0);
  const totalFP = successful.reduce((s, r) => s + r.falsePositives, 0);
  const totalFN = successful.reduce((s, r) => s + r.falseNegatives, 0);

  const precision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 0;
  const recall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const totalTraps = successful.reduce((s, r) => s + r.trapViolations.length, 0);
  const totalTrapChecks = successful.length > 0 ? successful.length : 1;

  // Aggregate class metrics
  const classAgg = new Map<VulnClass, { expected: number; found: number; missed: number; fp: number }>();
  for (const r of successful) {
    for (const cm of r.classBreakdown) {
      const entry = classAgg.get(cm.vulnClass) || { expected: 0, found: 0, missed: 0, fp: 0 };
      entry.expected += cm.expected;
      entry.found += cm.found;
      entry.missed += cm.missed;
      entry.fp += cm.falsePositive;
      classAgg.set(cm.vulnClass, entry);
    }
  }

  const classAggregate: ClassMetric[] = [...classAgg.entries()].map(([vc, d]) => ({
    vulnClass: vc,
    expected: d.expected,
    found: d.found,
    missed: d.missed,
    falsePositive: d.fp,
    precision: d.found + d.fp > 0 ? d.found / (d.found + d.fp) : 0,
    recall: d.expected > 0 ? d.found / d.expected : 0,
  }));

  return {
    timestamp: new Date().toISOString(),
    engineVersion,
    repos: repoResults,
    aggregate: {
      totalExpected,
      totalActual,
      totalTruePositives: totalTP,
      totalFalsePositives: totalFP,
      totalFalseNegatives: totalFN,
      precision,
      recall,
      f1,
      avgRuntimeMs: successful.length > 0
        ? successful.reduce((s, r) => s + r.runtimeMs, 0) / successful.length
        : 0,
      totalLlmTokens: successful.reduce((s, r) => s + r.llmTokensUsed, 0),
      totalLlmCostUsd: successful.reduce((s, r) => s + r.llmCostUsd, 0),
      trapViolationRate: totalTrapChecks > 0 ? totalTraps / totalTrapChecks : 0,
    },
    classAggregate,
  };
}