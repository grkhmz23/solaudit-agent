/**
 * V2 Engine Feature Flags
 *
 * Read from environment. Controls which V2 features are active.
 */

export type EngineVersion = "v1" | "v2" | "hybrid";

export interface V2Config {
  /** Which engine to run: v1, v2, or hybrid (runs both + comparison). */
  engineVersion: EngineVersion;
  /** Use tree-sitter for parsing instead of regex. */
  treeSitter: boolean;
  /** Use LLM confirmation loop for findings. */
  llmConfirm: boolean;
  /** Run PoC compilation + execution (requires Anchor/Solana toolchain). */
  pocValidate: boolean;
  /** Enable Kimi-powered patch authoring. */
  patchAuthor: boolean;
  /** Max candidates fed to LLM selector. */
  selectorCandidates: number;
  /** Max findings for LLM deep investigation. */
  maxDeepDives: number;
  /** LLM concurrency for deep dives. */
  llmConcurrency: number;
  /** Timeout per LLM call in ms. */
  llmTimeoutMs: number;
  /** Max LLM retries on transient errors. */
  llmRetries: number;
  /** Max patch files generated per audit. */
  maxPatchFiles: number;
  /** Timeout per patch author LLM call in ms. */
  patchTimeoutMs: number;
  /** Patch author concurrency (sequential recommended). */
  patchConcurrency: number;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

export function loadV2Config(): V2Config {
  const raw = (process.env.AUDIT_ENGINE_VERSION || "v1").toLowerCase();
  const engineVersion: EngineVersion =
    raw === "v2" ? "v2" : raw === "hybrid" ? "hybrid" : "v1";

  return {
    engineVersion,
    treeSitter: envBool("V2_TREE_SITTER", true),
    llmConfirm: envBool("V2_LLM_CONFIRM", true),
    pocValidate: envBool("V2_POC_VALIDATE", false),
    patchAuthor: envBool("V2_PATCH_AUTHOR", true),
    selectorCandidates: envInt("V2_SELECTOR_CANDIDATES", 50),
    maxDeepDives: envInt("V2_MAX_DEEP_DIVES", 10),
    llmConcurrency: envInt("V2_LLM_CONCURRENCY", 3),
    llmTimeoutMs: envInt("V2_LLM_TIMEOUT_MS", 180_000),
    llmRetries: envInt("V2_LLM_RETRIES", 2),
    maxPatchFiles: envInt("V2_MAX_PATCH_FILES", 10),
    patchTimeoutMs: envInt("V2_PATCH_TIMEOUT_MS", 180_000),
    patchConcurrency: envInt("V2_PATCH_CONCURRENCY", 1),
  };
}
