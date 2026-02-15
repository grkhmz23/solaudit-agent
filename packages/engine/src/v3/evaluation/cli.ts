/**
 * V3 Evaluation CLI
 *
 * Usage:
 *   npx tsx packages/engine/src/v3/evaluation/cli.ts [command] [options]
 *
 * Commands:
 *   run           Run full evaluation suite
 *   run-single    Run single repo evaluation
 *   fixtures      Generate synthetic fixtures
 *   compare       Compare two evaluation results
 *   list          List golden suite repos
 *
 * Options:
 *   --repo=ID           Run single repo (e.g., --repo=cashio)
 *   --skip-llm          Skip LLM confirmation (faster)
 *   --keep-repos        Keep cloned repos after evaluation
 *   --work-dir=PATH     Working directory (default: /tmp/solaudit-eval)
 *   --output-dir=PATH   Output directory (default: /tmp/solaudit-eval/results)
 *   --version=TAG       Engine version tag (default: v2-baseline)
 *   --baseline=PATH     Baseline JSON for comparison
 *   --current=PATH      Current JSON for comparison
 */

import { GOLDEN_SUITE, getTotalExpectedFindings } from "./golden-suite";
import { evalFullSuite, evalSingleRepo, compareRuns } from "./runner";
import { generateFixturesOnDisk, SYNTHETIC_FIXTURES } from "./fixtures/index";
import { readFileSync } from "fs";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  function getOpt(name: string): string | undefined {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg?.split("=").slice(1).join("=");
  }
  function hasFlag(name: string): boolean {
    return args.includes(`--${name}`);
  }

  switch (command) {
    case "run": {
      const config = {
        workDir: getOpt("work-dir") || "/tmp/solaudit-eval",
        outputDir: getOpt("output-dir") || "/tmp/solaudit-eval/results",
        engineVersion: getOpt("version") || (hasFlag("v3") ? "v3-alpha" : "v2-baseline"),
        skipLlm: hasFlag("skip-llm"),
        keepRepos: hasFlag("keep-repos"),
        repoIds: getOpt("repo") ? [getOpt("repo")!] : undefined,
        useV3: hasFlag("v3"),
      };
      await evalFullSuite(config);
      break;
    }

    case "run-single": {
      const repoId = getOpt("repo");
      if (!repoId) {
        console.error("Usage: run-single --repo=ID");
        console.error("Available repos:", GOLDEN_SUITE.map((r) => r.id).join(", "));
        process.exit(1);
      }
      const repo = GOLDEN_SUITE.find((r) => r.id === repoId);
      if (!repo) {
        console.error(`Repo not found: ${repoId}`);
        console.error("Available repos:", GOLDEN_SUITE.map((r) => r.id).join(", "));
        process.exit(1);
      }
      const config = {
        workDir: getOpt("work-dir") || "/tmp/solaudit-eval",
        outputDir: getOpt("output-dir") || "/tmp/solaudit-eval/results",
        engineVersion: getOpt("version") || (hasFlag("v3") ? "v3-alpha" : "v2-baseline"),
        skipLlm: hasFlag("skip-llm"),
        keepRepos: hasFlag("keep-repos"),
        useV3: hasFlag("v3"),
      };
      await evalSingleRepo(repo, config);
      break;
    }

    case "fixtures": {
      const dir = getOpt("output-dir") || "/tmp/solaudit-eval/fixtures";
      generateFixturesOnDisk(dir);
      break;
    }

    case "compare": {
      const baselinePath = getOpt("baseline");
      const currentPath = getOpt("current");
      if (!baselinePath || !currentPath) {
        console.error("Usage: compare --baseline=PATH --current=PATH");
        process.exit(1);
      }
      const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
      const current = JSON.parse(readFileSync(currentPath, "utf-8"));
      const result = compareRuns(baseline, current);

      console.log(`\nComparison: ${result.baselineVersion} → ${result.currentVersion}`);
      console.log(`  Precision: ${(result.precisionDelta * 100).toFixed(1)}%`);
      console.log(`  Recall:    ${(result.recallDelta * 100).toFixed(1)}%`);
      console.log(`  F1:        ${(result.f1Delta * 100).toFixed(1)}%`);

      if (result.improvements.length > 0) {
        console.log(`\n  Improvements:`);
        for (const i of result.improvements) console.log(`    ✓ ${i}`);
      }
      if (result.regressions.length > 0) {
        console.log(`\n  Regressions:`);
        for (const r of result.regressions) console.log(`    ✗ ${r}`);
      }
      console.log(`\n  Status: ${result.passed ? "PASSED ✓" : "FAILED ✗"}`);
      process.exit(result.passed ? 0 : 1);
      break;
    }

    case "list": {
      console.log(`\nSolAudit V3 Golden Suite — ${GOLDEN_SUITE.length} repos, ${getTotalExpectedFindings()} expected findings\n`);
      console.log(`${"ID".padEnd(18)} ${"Name".padEnd(26)} ${"Framework".padEnd(10)} ${"Diff".padEnd(8)} ${"Findings".padStart(8)}`);
      console.log("─".repeat(72));
      for (const r of GOLDEN_SUITE) {
        console.log(
          `${r.id.padEnd(18)} ${r.name.slice(0, 24).padEnd(26)} ${r.framework.padEnd(10)} ${r.difficulty.padEnd(8)} ${String(r.expectedFindings.length).padStart(8)}`,
        );
      }
      console.log(`\nSynthetic Fixtures: ${SYNTHETIC_FIXTURES.length}`);
      for (const f of SYNTHETIC_FIXTURES) {
        console.log(`  ${f.id.padEnd(28)} ${f.vulnClass.padEnd(28)} ${f.name}`);
      }
      break;
    }

    default: {
      console.log(`
SolAudit V3 Evaluation CLI
══════════════════════════

Commands:
  run             Run full evaluation suite
  run-single      Run single repo (--repo=ID)
  fixtures        Generate synthetic fixtures
  compare         Compare two evaluation runs
  list            List golden suite repos and fixtures

Options:
  --repo=ID           Target repo ID
  --skip-llm          Skip LLM confirmation
  --keep-repos        Keep cloned repos
  --work-dir=PATH     Working directory
  --output-dir=PATH   Output directory
  --version=TAG       Engine version tag
  --baseline=PATH     Baseline JSON (for compare)
  --current=PATH      Current JSON (for compare)

Examples:
  npx tsx packages/engine/src/v3/evaluation/cli.ts list
  npx tsx packages/engine/src/v3/evaluation/cli.ts run --skip-llm --version=v2-baseline
  npx tsx packages/engine/src/v3/evaluation/cli.ts run-single --repo=cashio --skip-llm
  npx tsx packages/engine/src/v3/evaluation/cli.ts fixtures --output-dir=./fixtures
  npx tsx packages/engine/src/v3/evaluation/cli.ts compare --baseline=baseline.json --current=v3.json
      `);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
