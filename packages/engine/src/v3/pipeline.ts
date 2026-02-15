/**
 * V3 Pipeline
 *
 * Wraps the V2 engine and adds:
 *   1. V3 detectors (oracle_validation, native_missing_owner, stale_post_cpi)
 *   2. Instruction dispatch remapping for native programs
 *   3. Trust Grade enforcement (downgrades unproven CRITICALs)
 *
 * The pipeline preserves V2's parsing layer (which works well) and
 * improves the analysis layer where V2 falls short.
 */

import type {
  V2PipelineResult,
  V2Finding,
  VulnCandidate,
  ParsedProgramV2,
  FindingStatus,
  CandidateSeverity,
} from "../v2/types";
import {
  applyTrustGradeFilter,
  gradedToActual,
  gradeDistribution,
  type GradedFinding,
} from "./filters/trust-grade-filter";
import {
  runV3Detectors,
  remapInstruction,
  type V3DetectorResult,
  type InstructionMapping,
} from "./detectors/index";
import type { ActualFinding } from "./evaluation/scorer";

// ─── V3 Pipeline Result ────────────────────────────────────

export interface V3PipelineResult {
  /** Original V2 result (preserved). */
  v2Result: V2PipelineResult;
  /** V3 detector results. */
  v3Detectors: V3DetectorResult;
  /** All candidates (V2 + V3) before Trust Grade. */
  allCandidates: VulnCandidate[];
  /** All findings (V2 + V3) with Trust Grades applied. */
  gradedFindings: GradedFinding[];
  /** Final actionable findings (after Trust Grade filter). */
  actionableFindings: ActualFinding[];
  /** Grade distribution. */
  grades: { A: number; B: number; C: number; D: number; downgraded: number };
  /** Instruction mappings (for native programs). */
  instructionMappings: InstructionMapping[];
  /** V3 pipeline metrics. */
  v3Metrics: {
    v2CandidateCount: number;
    v3CandidateCount: number;
    totalCandidates: number;
    preFilterFindings: number;
    postFilterFindings: number;
    filteredOut: number;
    v3DurationMs: number;
  };
}

// ─── Pipeline ──────────────────────────────────────────────

/**
 * Run the V3 pipeline on top of a V2 result.
 *
 * Steps:
 *   1. Run V3 detectors on V2's parsed program
 *   2. Merge V3 candidates with V2 candidates
 *   3. Convert new V3 candidates to V2Finding format (status: LIKELY)
 *   4. Apply Trust Grade enforcement to all findings
 *   5. Apply instruction remapping for scoring
 *   6. Return filtered, graded findings
 */
export function runV3Pipeline(v2Result: V2PipelineResult): V3PipelineResult {
  const t0 = Date.now();
  const program = v2Result.program;

  // ── Step 1: Run V3 detectors ──
  const v3Detectors = runV3Detectors(program);

  console.log(
    `[v3] Detectors found: ` +
      `${v3Detectors.stats.oracleValidationFound} oracle, ` +
      `${v3Detectors.stats.nativeMissingOwnerFound} native-owner, ` +
      `${v3Detectors.stats.stalePostCpiFound} stale-cpi, ` +
      `${v3Detectors.stats.instructionsMapped} instruction mappings`,
  );

  // ── Step 2: Merge candidates ──
  const allCandidates = [...v2Result.candidates, ...v3Detectors.newCandidates];

  // ── Step 3: Convert V3 candidates to V2Finding format ──
  const v3Findings: V2Finding[] = v3Detectors.newCandidates.map((c, i) => ({
    id: 10_000 + i,
    candidate: c,
    status: "LIKELY" as FindingStatus,
    finalSeverity: c.severity,
    finalConfidence: c.confidence,
  }));

  // Combine V2 findings (non-rejected) + V3 findings
  const allFindings = [...v2Result.findings, ...v3Findings];

  // ── Step 4: Apply Trust Grade enforcement ──
  const gradedFindings = applyTrustGradeFilter(allFindings, program);
  const grades = gradeDistribution(gradedFindings);

  console.log(
    `[v3] Trust Grades: A=${grades.A} B=${grades.B} C=${grades.C} D=${grades.D} (${grades.downgraded} downgraded)`,
  );

  // ── Step 5: Convert to ActualFinding with instruction remapping ──
  const actionableFindings = gradedToActualWithRemapping(
    gradedFindings,
    v3Detectors.instructionMappings,
  );

  const v3DurationMs = Date.now() - t0;

  console.log(
    `[v3] Pipeline: ${v2Result.candidates.length} V2 + ${v3Detectors.newCandidates.length} V3 candidates → ` +
      `${actionableFindings.length} actionable (${v3DurationMs}ms)`,
  );

  return {
    v2Result,
    v3Detectors,
    allCandidates,
    gradedFindings,
    actionableFindings,
    grades,
    instructionMappings: v3Detectors.instructionMappings,
    v3Metrics: {
      v2CandidateCount: v2Result.candidates.length,
      v3CandidateCount: v3Detectors.newCandidates.length,
      totalCandidates: allCandidates.length,
      preFilterFindings: allFindings.filter((f) => f.status !== "REJECTED").length,
      postFilterFindings: actionableFindings.length,
      filteredOut:
        allFindings.filter((f) => f.status !== "REJECTED").length -
        actionableFindings.length,
      v3DurationMs,
    },
  };
}

// ─── Instruction Remapping for Scoring ─────────────────────

/**
 * Convert graded findings to ActualFinding with instruction remapping.
 *
 * For native programs, V2 reports findings under function names like
 * "process_liquidate" or "process_instruction". The scorer expects
 * dispatch names like "liquidate". This function applies the mapping.
 *
 * Also: for findings with severity >= MEDIUM after Trust Grade, output them.
 * Findings downgraded below MEDIUM are excluded from scoring.
 */
function gradedToActualWithRemapping(
  graded: GradedFinding[],
  mappings: InstructionMapping[],
): ActualFinding[] {
  const SEVERITY_ORDER: Record<CandidateSeverity, number> = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
    INFO: 0,
  };

  return graded
    .filter((g) => SEVERITY_ORDER[g.enforcedSeverity] >= SEVERITY_ORDER["MEDIUM"])
    .map((g) => {
      const candidate = g.finding.candidate;

      // Apply instruction remapping
      const remapped = remapInstruction(candidate.instruction, mappings);
      // Use the first remapped name (most specific) for primary instruction
      // but store all aliases so the scorer can match any of them
      const primaryInstruction = remapped[0];

      return {
        vulnClass: candidate.vulnClass,
        severity: g.enforcedSeverity,
        instruction: primaryInstruction,
        file: candidate.ref.file,
        accountNames: candidate.involvedAccounts.map((a) => a.name),
        confidence: g.finding.finalConfidence,
        status: g.finding.status,
        title:
          g.finding.llmConfirmation?.title ||
          candidate.reason.slice(0, 120),
        // Extra: store all instruction aliases for fuzzy matching
        _instructionAliases: remapped.length > 1 ? remapped : undefined,
      } as ActualFinding & { _instructionAliases?: string[] };
    });
}
