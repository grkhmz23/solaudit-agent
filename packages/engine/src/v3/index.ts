/**
 * SolAudit V3 Engine — barrel exports.
 *
 * Phase 0: Evaluation harness + V3 type system
 * Phase A: Trust Grade filter + V3 detectors + V3 pipeline
 * Phase B: Verification pipeline (coming)
 * Phase C: GitHub App + Product layer (coming)
 */

// ─── V3 Type System ──────────────────────────────────────────
export * from "./types/index";

// ─── Phase A: Pipeline + Detectors + Filters ─────────────────
export { runV3Pipeline, type V3PipelineResult } from "./pipeline";
export * as detectors from "./detectors/index";
export * as trustGrade from "./filters/trust-grade-filter";

// ─── Evaluation Harness ──────────────────────────────────────
export * as evaluation from "./evaluation/index";
