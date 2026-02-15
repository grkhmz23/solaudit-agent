/**
 * V3 Evaluation Runner
 *
 * Orchestrates the evaluation pipeline:
 *   1. Clone golden suite repos (pinned commits)
 *   2. Run V2 engine against each repo
 *   3. Convert engine output to ActualFinding format
 *   4. Score against expected findings
 *   5. Aggregate and export results
 *
 * Can run against:
 *   - Full golden suite (15 repos)
 *   - Single repo (for quick iteration)
 *   - Synthetic fixtures only (for unit testing detectors)
 */

import { execSync, exec } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { GOLDEN_SUITE, type GoldenRepo } from "./golden-suite";
import {
  scoreRepo,
  aggregateResults,
  type ActualFinding,
  type RepoEvalResult,
  type SuiteEvalResult,
} from "./scorer";
import type { V2Finding, V2PipelineResult, VulnClass, CandidateSeverity } from "../../v2/types";

// ─── Configuration ───────────────────────────────────────────

export interface EvalConfig {
  /** Directory to clone repos into. */
  workDir: string;
  /** Engine version identifier (for tracking). */
  engineVersion: string;
  /** Which repos to evaluate (default: all). */
  repoIds?: string[];
  /** Whether to skip LLM confirmation (for speed). */
  skipLlm?: boolean;
  /** Whether to keep cloned repos after evaluation. */
  keepRepos?: boolean;
  /** Timeout per repo scan in ms. */
  timeoutMs?: number;
  /** Output directory for results. */
  outputDir: string;
  /** Whether to run synthetic fixtures too. */
  includeSynthetic?: boolean;
  /** Whether to use V3 pipeline (detectors + trust grade). */
  useV3?: boolean;
}

const DEFAULT_CONFIG: EvalConfig = {
  workDir: "/tmp/solaudit-eval",
  engineVersion: "v2-baseline",
  outputDir: "/tmp/solaudit-eval/results",
  timeoutMs: 300_000, // 5 min per repo
  keepRepos: false,
  skipLlm: false,
  includeSynthetic: false,
};

// ─── Repo Operations ─────────────────────────────────────────

/**
 * Clone a golden suite repo at the pinned commit.
 */
function cloneRepo(repo: GoldenRepo, workDir: string): string {
  const repoDir = join(workDir, "repos", repo.id);

  if (existsSync(repoDir)) {
    console.log(`  [clone] ${repo.id}: already exists, reusing`);
    return repoDir;
  }

  mkdirSync(join(workDir, "repos"), { recursive: true });

  console.log(`  [clone] ${repo.id}: cloning ${repo.repoUrl}...`);
  try {
    execSync(
      `git clone --depth 1 --branch ${repo.branch} ${repo.repoUrl} ${repoDir} 2>&1`,
      { timeout: 60_000, stdio: "pipe" },
    );

    // If a specific commit is pinned (not 'main' or 'master'), checkout
    if (repo.commitSha !== "main" && repo.commitSha !== "master") {
      execSync(`cd ${repoDir} && git fetch --depth 1 origin ${repo.commitSha} && git checkout ${repo.commitSha}`, {
        timeout: 30_000,
        stdio: "pipe",
      });
    }

    console.log(`  [clone] ${repo.id}: done`);
    return repoDir;
  } catch (err: any) {
    console.error(`  [clone] ${repo.id}: FAILED — ${err.message}`);
    throw new Error(`Failed to clone ${repo.repoUrl}: ${err.message}`);
  }
}

/**
 * Find the Solana program directory within a cloned repo.
 */
function findProgramDir(repoDir: string, repo: GoldenRepo): string {
  const candidate = join(repoDir, repo.programDir);
  if (existsSync(candidate)) return candidate;

  // Fallback: search for Cargo.toml with solana-program dependency
  try {
    const result = execSync(
      `find ${repoDir} -name "Cargo.toml" -exec grep -l "solana-program\\|anchor-lang" {} \\; 2>/dev/null | head -5`,
      { timeout: 10_000, encoding: "utf-8" },
    );
    const paths = result.trim().split("\n").filter(Boolean);
    if (paths.length > 0) {
      const dir = paths[0].replace("/Cargo.toml", "");
      console.log(`  [scan] ${repo.id}: using detected program dir: ${dir}`);
      return dir;
    }
  } catch { /* ignore */ }

  // Last resort: use repo root
  return repoDir;
}

// ─── V2 Engine Integration ───────────────────────────────────

/**
 * Run the V2 engine against a repo directory.
 * Returns the pipeline result or throws on failure.
 */
async function runV2Engine(
  repoPath: string,
  config: EvalConfig,
): Promise<V2PipelineResult> {
  // Dynamically import the V2 pipeline to avoid circular deps
  const { runPipelineV2 } = await import("../../v2/index");

  // Set env vars for this run
  if (config.skipLlm) {
    process.env.V2_LLM_CONFIRM = "false";
  }
  process.env.AUDIT_ENGINE_VERSION = "v2";
  process.env.V2_TREE_SITTER = "true";
  process.env.V2_POC_VALIDATE = "false"; // No PoC in eval (too slow)

  const ctx = {
    repoPath,
    onProgress: async (_stage: string, _pct: number) => {},
  };

  return runPipelineV2(ctx as any);
}

/**
 * Convert V2 pipeline findings to ActualFinding format for scoring.
 */
function v2FindingsToActual(findings: V2Finding[]): ActualFinding[] {
  return findings
    .filter((f) => f.status !== "REJECTED")
    .map((f) => ({
      vulnClass: f.candidate.vulnClass,
      severity: f.finalSeverity,
      instruction: f.candidate.instruction,
      file: f.candidate.ref.file,
      accountNames: f.candidate.involvedAccounts.map((a) => a.name),
      confidence: f.finalConfidence,
      status: f.status,
      title: f.llmConfirmation?.title || f.candidate.reason.slice(0, 120),
    }));
}

// ─── Main Runner ─────────────────────────────────────────────

/**
 * Run evaluation against a single golden repo.
 */
export async function evalSingleRepo(
  repo: GoldenRepo,
  config: EvalConfig,
): Promise<RepoEvalResult> {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Evaluating: ${repo.name} (${repo.id})`);
  console.log(`  Framework: ${repo.framework} | Difficulty: ${repo.difficulty}`);
  console.log(`  Expected findings: ${repo.expectedFindings.length}`);
  console.log(`  Pipeline: ${config.useV3 ? "V3 (V2 + detectors + trust grade)" : "V2 baseline"}`);
  console.log(`${"═".repeat(60)}`);

  const t0 = Date.now();

  try {
    // Clone
    const repoDir = cloneRepo(repo, config.workDir);
    const programDir = findProgramDir(repoDir, repo);

    // Run V2 engine (always needed — provides parsing)
    console.log(`  [scan] Running V2 engine on ${programDir}...`);
    const v2Result = await runV2Engine(programDir, config);

    let actualFindings: ActualFinding[];
    let v3Info = "";

    if (config.useV3) {
      // Run V3 pipeline on top of V2
      const { runV3Pipeline } = await import("../pipeline");
      const v3Result = runV3Pipeline(v2Result);

      actualFindings = v3Result.actionableFindings;
      v3Info = ` [V3: ${v3Result.v3Metrics.v3CandidateCount} new, ` +
        `${v3Result.v3Metrics.filteredOut} filtered, ` +
        `grades A=${v3Result.grades.A} B=${v3Result.grades.B} C=${v3Result.grades.C} D=${v3Result.grades.D}]`;
    } else {
      actualFindings = v2FindingsToActual(v2Result.findings);
    }

    const runtimeMs = Date.now() - t0;

    console.log(`  [scan] Got ${actualFindings.length} actionable findings in ${runtimeMs}ms${v3Info}`);
    console.log(`  [scan] Severities: ${countSeverities(actualFindings)}`);

    // Debug: show finding details for matching analysis
    if (actualFindings.length > 0 && actualFindings.length <= 50) {
      console.log(`  [debug] Findings by class:instruction ──`);
      const byClass = new Map<string, string[]>();
      for (const f of actualFindings) {
        const key = f.vulnClass;
        const existing = byClass.get(key) || [];
        existing.push(f.instruction);
        byClass.set(key, existing);
      }
      for (const [cls, instrs] of byClass) {
        const unique = [...new Set(instrs)];
        console.log(`    ${cls}: [${unique.slice(0, 8).join(", ")}]${unique.length > 8 ? ` +${unique.length - 8} more` : ""}`);
      }
      console.log(`  [debug] Expected: ${repo.expectedFindings.map(e => `${e.vulnClass} in [${e.matchCriteria.instructions.join(",")}]`).join("; ")}`);
    }
    // Score
    const evalResult = scoreRepo(
      repo,
      actualFindings,
      runtimeMs,
      v2Result.metrics.llmDeepDiveCount * 2000,
      v2Result.metrics.llmDeepDiveCount * 0.02,
    );

    console.log(`  [score] TP=${evalResult.truePositives} FP=${evalResult.falsePositives} FN=${evalResult.falseNegatives}`);
    console.log(`  [score] Precision=${(evalResult.precision * 100).toFixed(1)}% Recall=${(evalResult.recall * 100).toFixed(1)}% F1=${(evalResult.f1 * 100).toFixed(1)}%`);

    if (evalResult.trapViolations.length > 0) {
      console.warn(`  [traps] ${evalResult.trapViolations.length} false positive trap(s) triggered!`);
      for (const tv of evalResult.trapViolations) {
        console.warn(`    - ${tv.trap.description}: flagged as ${tv.actualFinding.vulnClass}`);
      }
    }

    return evalResult;
  } catch (err: any) {
    const runtimeMs = Date.now() - t0;
    console.error(`  [error] ${repo.id}: ${err.message}`);

    return {
      repoId: repo.id,
      repoName: repo.name,
      commit: repo.commitSha,
      expected: repo.expectedFindings,
      actual: [],
      matches: [],
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: repo.expectedFindings.length,
      trapViolations: [],
      precision: 0,
      recall: 0,
      f1: 0,
      runtimeMs,
      llmTokensUsed: 0,
      llmCostUsd: 0,
      classBreakdown: [],
      error: err.message,
    };
  }
}

/**
 * Run evaluation against the full golden suite.
 */
export async function evalFullSuite(
  config: Partial<EvalConfig> = {},
): Promise<SuiteEvalResult> {
  const cfg: EvalConfig = { ...DEFAULT_CONFIG, ...config };

  // Filter repos if specified
  const repos = cfg.repoIds
    ? GOLDEN_SUITE.filter((r) => cfg.repoIds!.includes(r.id))
    : GOLDEN_SUITE;

  console.log(`\n${"╔".padEnd(59, "═")}╗`);
  console.log(`║  SolAudit V3 Evaluation Suite`.padEnd(59) + `║`);
  console.log(`║  Engine: ${cfg.engineVersion}`.padEnd(59) + `║`);
  console.log(`║  Repos: ${repos.length} / ${GOLDEN_SUITE.length}`.padEnd(59) + `║`);
  console.log(`║  LLM: ${cfg.skipLlm ? "DISABLED" : "ENABLED"}`.padEnd(59) + `║`);
  console.log(`${"╚".padEnd(59, "═")}╝\n`);

  // Setup work directory
  mkdirSync(cfg.workDir, { recursive: true });
  mkdirSync(cfg.outputDir, { recursive: true });

  // Run each repo
  const results: RepoEvalResult[] = [];
  for (const repo of repos) {
    const result = await evalSingleRepo(repo, cfg);
    results.push(result);
  }

  // Aggregate
  const suite = aggregateResults(results, cfg.engineVersion);

  // Print summary
  printSummary(suite);

  // Save results
  const outputPath = join(cfg.outputDir, `eval-${cfg.engineVersion}-${Date.now()}.json`);
  writeFileSync(outputPath, JSON.stringify(suite, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  // Cleanup
  if (!cfg.keepRepos) {
    try {
      rmSync(join(cfg.workDir, "repos"), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  return suite;
}

/**
 * Compare two evaluation runs (for regression detection).
 */
export function compareRuns(
  baseline: SuiteEvalResult,
  current: SuiteEvalResult,
): ComparisonResult {
  const precDelta = current.aggregate.precision - baseline.aggregate.precision;
  const recDelta = current.aggregate.recall - baseline.aggregate.recall;
  const f1Delta = current.aggregate.f1 - baseline.aggregate.f1;

  const regressions: string[] = [];
  const improvements: string[] = [];

  if (precDelta < -0.05) regressions.push(`Precision dropped ${(precDelta * 100).toFixed(1)}%`);
  if (recDelta < -0.05) regressions.push(`Recall dropped ${(recDelta * 100).toFixed(1)}%`);
  if (f1Delta < -0.05) regressions.push(`F1 dropped ${(f1Delta * 100).toFixed(1)}%`);

  if (precDelta > 0.05) improvements.push(`Precision improved ${(precDelta * 100).toFixed(1)}%`);
  if (recDelta > 0.05) improvements.push(`Recall improved ${(recDelta * 100).toFixed(1)}%`);
  if (f1Delta > 0.05) improvements.push(`F1 improved ${(f1Delta * 100).toFixed(1)}%`);

  // Per-repo regressions
  for (const cr of current.repos) {
    const br = baseline.repos.find((r) => r.repoId === cr.repoId);
    if (!br) continue;
    if (cr.f1 < br.f1 - 0.1) {
      regressions.push(`${cr.repoName}: F1 ${(br.f1 * 100).toFixed(0)}% → ${(cr.f1 * 100).toFixed(0)}%`);
    }
  }

  return {
    baselineVersion: baseline.engineVersion,
    currentVersion: current.engineVersion,
    precisionDelta: precDelta,
    recallDelta: recDelta,
    f1Delta,
    regressions,
    improvements,
    passed: regressions.length === 0,
  };
}

export interface ComparisonResult {
  baselineVersion: string;
  currentVersion: string;
  precisionDelta: number;
  recallDelta: number;
  f1Delta: number;
  regressions: string[];
  improvements: string[];
  passed: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────

function countSeverities(findings: ActualFinding[]): string {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
}

function printSummary(suite: SuiteEvalResult): void {
  const a = suite.aggregate;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  EVALUATION SUMMARY — ${suite.engineVersion}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Repos scanned:       ${suite.repos.length}`);
  console.log(`  Repos with errors:   ${suite.repos.filter((r) => r.error).length}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Total expected:      ${a.totalExpected}`);
  console.log(`  Total actual:        ${a.totalActual}`);
  console.log(`  True positives:      ${a.totalTruePositives}`);
  console.log(`  False positives:     ${a.totalFalsePositives}`);
  console.log(`  False negatives:     ${a.totalFalseNegatives}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  PRECISION:           ${(a.precision * 100).toFixed(1)}%`);
  console.log(`  RECALL:              ${(a.recall * 100).toFixed(1)}%`);
  console.log(`  F1:                  ${(a.f1 * 100).toFixed(1)}%`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Avg runtime:         ${(a.avgRuntimeMs / 1000).toFixed(1)}s`);
  console.log(`  Total LLM tokens:    ${a.totalLlmTokens}`);
  console.log(`  Total LLM cost:      $${a.totalLlmCostUsd.toFixed(2)}`);
  console.log(`  Trap violation rate:  ${(a.trapViolationRate * 100).toFixed(1)}%`);
  console.log(`${"═".repeat(60)}`);

  // Per-class summary
  if (suite.classAggregate.length > 0) {
    console.log(`\n  Per-Class Breakdown:`);
    console.log(`  ${"Class".padEnd(28)} ${"Prec".padStart(6)} ${"Recall".padStart(6)} ${"Found".padStart(6)} ${"FP".padStart(4)}`);
    console.log(`  ${"─".repeat(50)}`);
    for (const cm of suite.classAggregate) {
      console.log(
        `  ${cm.vulnClass.padEnd(28)} ${(cm.precision * 100).toFixed(0).padStart(5)}% ${(cm.recall * 100).toFixed(0).padStart(5)}% ${String(cm.found).padStart(6)} ${String(cm.falsePositive).padStart(4)}`,
      );
    }
  }

  // Per-repo summary
  console.log(`\n  Per-Repo Results:`);
  console.log(`  ${"Repo".padEnd(24)} ${"P".padStart(5)} ${"R".padStart(5)} ${"F1".padStart(5)} ${"TP".padStart(4)} ${"FP".padStart(4)} ${"FN".padStart(4)} ${"Time".padStart(6)}`);
  console.log(`  ${"─".repeat(56)}`);
  for (const r of suite.repos) {
    const status = r.error ? " ERR" : "";
    console.log(
      `  ${(r.repoName.slice(0, 22) + status).padEnd(24)} ${(r.precision * 100).toFixed(0).padStart(4)}% ${(r.recall * 100).toFixed(0).padStart(4)}% ${(r.f1 * 100).toFixed(0).padStart(4)}% ${String(r.truePositives).padStart(4)} ${String(r.falsePositives).padStart(4)} ${String(r.falseNegatives).padStart(4)} ${(r.runtimeMs / 1000).toFixed(1).padStart(5)}s`,
    );
  }
}
