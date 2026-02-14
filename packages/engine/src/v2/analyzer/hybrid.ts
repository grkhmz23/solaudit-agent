/**
 * Phase 6 — Hybrid Mode Comparison.
 *
 * Runs V1 + V2 on the same repo and compares results:
 * - Overlap of findings
 * - V1 false positives rejected by V2
 * - V2 novel findings not in V1
 */

import type { FindingResult } from "../../types";
import type { V2Finding, HybridComparison, VulnCandidate } from "../types";

/**
 * Compare V1 and V2 results to produce a hybrid comparison summary.
 */
export function compareV1V2(
  v1Findings: FindingResult[],
  v2Findings: V2Finding[],
): HybridComparison {
  // Build fingerprints for matching
  const v1Fingerprints = new Set(
    v1Findings.map((f) =>
      `${f.classId}:${f.location.instruction || ""}:${f.location.file}:${f.location.line}`,
    ),
  );

  const v2Fingerprints = new Set(
    v2Findings.map((f) => f.candidate.fingerprint),
  );

  // Build a "relaxed" match set for V2 → V1 comparison
  // V1 and V2 may have different fingerprint formats, so also match on file+instruction+class
  const v1Relaxed = new Set(
    v1Findings.map((f) =>
      `${f.classId}:${f.location.instruction || ""}:${f.location.file}`,
    ),
  );

  const v2Relaxed = new Set(
    v2Findings.map((f) =>
      `${vulnClassToId(f.candidate.vulnClass)}:${f.candidate.instruction}:${f.candidate.ref.file}`,
    ),
  );

  let overlap = 0;
  let v1Only = 0;
  let v2Only = 0;

  for (const key of v1Relaxed) {
    if (v2Relaxed.has(key)) overlap++;
    else v1Only++;
  }

  for (const key of v2Relaxed) {
    if (!v1Relaxed.has(key)) v2Only++;
  }

  // V1 false positives = V1 findings that V2 investigated and rejected
  const v2Rejected = new Set(
    v2Findings
      .filter((f) => f.status === "REJECTED")
      .map(
        (f) =>
          `${vulnClassToId(f.candidate.vulnClass)}:${f.candidate.instruction}:${f.candidate.ref.file}`,
      ),
  );

  let v1FalsePositives = 0;
  for (const key of v1Relaxed) {
    if (v2Rejected.has(key)) v1FalsePositives++;
  }

  // V2 novel = V2 confirmed/proven findings not in V1
  const v2Novel = v2Findings.filter(
    (f) =>
      (f.status === "PROVEN" || f.status === "LIKELY") &&
      !v1Relaxed.has(
        `${vulnClassToId(f.candidate.vulnClass)}:${f.candidate.instruction}:${f.candidate.ref.file}`,
      ),
  );

  return {
    v1TotalFindings: v1Findings.length,
    v2TotalFindings: v2Findings.length,
    overlap,
    v1OnlyCount: v1Only,
    v2OnlyCount: v2Only,
    v1FalsePositivesRejected: v1FalsePositives,
    v2NovelFindings: v2Novel.length,
  };
}

function vulnClassToId(vc: string): number {
  const map: Record<string, number> = {
    missing_signer: 1,
    missing_owner: 2,
    pda_derivation: 3,
    arbitrary_cpi: 4,
    type_confusion: 5,
    reinit: 6,
    close_revive: 7,
    unchecked_realloc: 8,
    integer_overflow: 9,
    state_machine: 10,
    remaining_accounts: 11,
    oracle_validation: 12,
    token_authority_mismatch: 13,
    stale_post_cpi: 14,
    duplicate_account: 15,
  };
  return map[vc] || 0;
}
