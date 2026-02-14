/**
 * V2 Patch Pipeline — Author → Validate → Retry → Report
 *
 * For each confirmed/likely finding:
 *   1. Author patch via Kimi (structured JSON output)
 *   2. Validate with git apply + build check
 *   3. If validation fails, retry once with compiler errors
 *   4. If retry fails, mark as "needs_human"
 *
 * Payloads stay small — patch diffs stored as R2 artifacts,
 * only pointers go to DB/queue.
 */

import type { V2Finding, ParsedProgramV2 } from "../types";
import type { V2Config } from "../config";
import {
  authorPatch,
  retryPatch,
  type PatchAuthorResult,
  type KimiPatchResult,
} from "./kimi-patch-author";
import {
  validatePatches,
  revertPatches,
  type ValidationResult,
} from "./patch-validator";

// ─── Types ──────────────────────────────────────────────────

export type PatchStatus = "validated" | "needs_human" | "failed" | "skipped";

export interface V2PatchResult {
  findingId: number;
  status: PatchStatus;
  patches: Array<{ path: string; unifiedDiff: string }>;
  tests: Array<{ path: string; unifiedDiff: string }>;
  rationale: string;
  riskNotes: string;
  validation?: ValidationResult;
  error?: string;
  attempts: number;
  durationMs: number;
}

export interface PatchPipelineResult {
  results: V2PatchResult[];
  metrics: {
    totalFindings: number;
    patchesAttempted: number;
    patchesValidated: number;
    patchesNeedHuman: number;
    patchesFailed: number;
    patchesSkipped: number;
    totalDurationMs: number;
  };
}

// ─── Concurrency Limiter ────────────────────────────────────

async function mapSequential<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i], i));
  }
  return results;
}

// ─── Main Pipeline ──────────────────────────────────────────

/**
 * Run the patch pipeline for all actionable findings.
 *
 * Only patches findings with status PROVEN or LIKELY.
 * Runs sequentially to avoid git conflicts (patches stack).
 */
export async function runPatchPipeline(
  findings: V2Finding[],
  program: ParsedProgramV2,
  repoPath: string,
  config: V2Config,
  onProgress?: (step: string, detail: string) => Promise<void>,
): Promise<PatchPipelineResult> {
  const t0 = Date.now();
  const progress = onProgress || (async () => {});

  // Filter to patchable findings
  const patchable = findings.filter(
    (f) => f.status === "PROVEN" || f.status === "LIKELY",
  );

  const maxPatches = config.maxPatchFiles;
  const toPatch = patchable.slice(0, maxPatches);

  console.log(
    `[patch-pipeline] ${toPatch.length} findings to patch ` +
    `(${patchable.length} patchable, max ${maxPatches})`,
  );

  if (toPatch.length === 0) {
    return {
      results: [],
      metrics: {
        totalFindings: findings.length,
        patchesAttempted: 0,
        patchesValidated: 0,
        patchesNeedHuman: 0,
        patchesFailed: 0,
        patchesSkipped: findings.length,
        totalDurationMs: Date.now() - t0,
      },
    };
  }

  await progress("patch_author", `Generating patches for ${toPatch.length} findings via Kimi...`);

  // Process sequentially (patches stack on each other)
  const results = await mapSequential(toPatch, async (finding, idx) => {
    return processSingleFinding(finding, program, repoPath, config, idx, toPatch.length, progress);
  });

  const metrics = {
    totalFindings: findings.length,
    patchesAttempted: results.length,
    patchesValidated: results.filter((r) => r.status === "validated").length,
    patchesNeedHuman: results.filter((r) => r.status === "needs_human").length,
    patchesFailed: results.filter((r) => r.status === "failed").length,
    patchesSkipped: findings.length - results.length,
    totalDurationMs: Date.now() - t0,
  };

  console.log(
    `[patch-pipeline] Complete: ${metrics.patchesValidated} validated, ` +
    `${metrics.patchesNeedHuman} needs_human, ${metrics.patchesFailed} failed ` +
    `(${metrics.totalDurationMs}ms)`,
  );

  return { results, metrics };
}

// ─── Single Finding Processor ───────────────────────────────

async function processSingleFinding(
  finding: V2Finding,
  program: ParsedProgramV2,
  repoPath: string,
  config: V2Config,
  idx: number,
  total: number,
  progress: (step: string, detail: string) => Promise<void>,
): Promise<V2PatchResult> {
  const t0 = Date.now();
  const label = `[${idx + 1}/${total}] ${finding.candidate.vulnClass} in ${finding.candidate.instruction}`;

  console.log(`[patch-pipeline] ${label}: Authoring patch...`);
  await progress("patch_author", `${label}: Generating patch via Kimi...`);

  // ── Step 1: Author patch ──
  const authorResult = await authorPatch(finding, program, repoPath, config);

  if (authorResult.status !== "success" || !authorResult.patchResult) {
    console.warn(`[patch-pipeline] ${label}: Author failed — ${authorResult.error}`);
    return {
      findingId: finding.id,
      status: "failed",
      patches: [],
      tests: [],
      rationale: "",
      riskNotes: "",
      error: authorResult.error,
      attempts: authorResult.attempts,
      durationMs: Date.now() - t0,
    };
  }

  // ── Step 2: Validate patch ──
  console.log(`[patch-pipeline] ${label}: Validating patch...`);
  await progress("patch_validate", `${label}: Validating (git apply + build)...`);

  const validation = validatePatches(authorResult.patchResult, repoPath);

  if (validation.passed) {
    console.log(`[patch-pipeline] ${label}: Patch validated ✓`);
    return {
      findingId: finding.id,
      status: "validated",
      patches: authorResult.patchResult.patches,
      tests: authorResult.patchResult.tests,
      rationale: authorResult.patchResult.rationale,
      riskNotes: authorResult.patchResult.riskNotes,
      validation,
      attempts: 1,
      durationMs: Date.now() - t0,
    };
  }

  // ── Step 3: Retry with errors ──
  console.log(`[patch-pipeline] ${label}: Validation failed at ${validation.failedGate}, retrying...`);
  await progress("patch_retry", `${label}: Retry with errors → Kimi...`);

  // Revert any partially applied patches
  if (validation.appliedFiles.length > 0) {
    revertPatches(validation.appliedFiles, repoPath);
  }

  const retryResult = await retryPatch(
    finding,
    program,
    repoPath,
    authorResult.patchResult,
    validation.error || "Unknown validation error",
    config,
  );

  if (retryResult.status !== "success" || !retryResult.patchResult) {
    console.warn(`[patch-pipeline] ${label}: Retry failed — needs human`);
    return {
      findingId: finding.id,
      status: "needs_human",
      patches: authorResult.patchResult.patches,  // keep original for reference
      tests: [],
      rationale: authorResult.patchResult.rationale,
      riskNotes: `VALIDATION FAILED: ${validation.error?.slice(0, 500)}`,
      validation,
      error: `Retry failed: ${retryResult.error}`,
      attempts: 2,
      durationMs: Date.now() - t0,
    };
  }

  // ── Step 4: Validate retry ──
  console.log(`[patch-pipeline] ${label}: Validating retry patch...`);
  const retryValidation = validatePatches(retryResult.patchResult, repoPath);

  if (retryValidation.passed) {
    console.log(`[patch-pipeline] ${label}: Retry patch validated ✓`);
    return {
      findingId: finding.id,
      status: "validated",
      patches: retryResult.patchResult.patches,
      tests: retryResult.patchResult.tests,
      rationale: retryResult.patchResult.rationale,
      riskNotes: retryResult.patchResult.riskNotes,
      validation: retryValidation,
      attempts: 2,
      durationMs: Date.now() - t0,
    };
  }

  // ── Both attempts failed — needs human ──
  if (retryValidation.appliedFiles.length > 0) {
    revertPatches(retryValidation.appliedFiles, repoPath);
  }

  console.warn(`[patch-pipeline] ${label}: Both attempts failed — needs human`);
  return {
    findingId: finding.id,
    status: "needs_human",
    patches: retryResult.patchResult.patches,
    tests: [],
    rationale: retryResult.patchResult.rationale,
    riskNotes: `STILL FAILING: ${retryValidation.error?.slice(0, 500)}`,
    validation: retryValidation,
    error: `Both attempts failed: ${retryValidation.error}`,
    attempts: 2,
    durationMs: Date.now() - t0,
  };
}

// ─── Utility: Convert to legacy CodePatch format ────────────

import * as fs from "fs";
import * as pathModule from "path";

export interface LegacyCodePatch {
  file: string;
  originalContent: string;
  patchedContent: string;
  diff: string;
  description: string;
}

/**
 * Convert validated V2 patch results to the legacy CodePatch format
 * used by the orchestrator for PR submission.
 */
export function v2PatchesToLegacy(
  results: V2PatchResult[],
  repoPath: string,
): LegacyCodePatch[] {
  const legacyPatches: LegacyCodePatch[] = [];

  for (const r of results) {
    if (r.status !== "validated") continue;

    for (const patch of r.patches) {
      let originalContent = "";
      try {
        originalContent = fs.readFileSync(
          pathModule.join(repoPath, patch.path),
          "utf-8",
        );
      } catch {}

      legacyPatches.push({
        file: patch.path,
        originalContent,
        patchedContent: originalContent, // actual content is applied via git apply
        diff: patch.unifiedDiff,
        description: r.rationale,
      });
    }
  }

  return legacyPatches;
}
