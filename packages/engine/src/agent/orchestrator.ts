/**
 * Agent Orchestrator v2 — Full End-to-End Bounty Pipeline
 *
 * Autonomous flow:
 * 1. Clone target repo
 * 2. Run audit pipeline (SCAN → PROVE → FIX_PLAN)
 * 3. Generate code patches for actionable findings
 * 4. Execute PoC harnesses (if anchor/cargo available)
 * 5. LLM-enrich findings (dedupe → select → deep dive)
 * 6. Generate professional advisory document
 * 7. Generate PR content via LLM
 * 8. Fork repo, commit patches, open PR
 */

import { execSync, type ExecSyncOptions } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { runPipeline } from "../pipeline";
import { generatePatches, type CodePatch } from "../remediation/patcher";
import { executePocs, type PoCResult } from "../proof/executor";
import { generateSecurityAdvisory, generatePRBody } from "../report/advisory";
import {
  isLLMAvailable,
  analyzeAllFindings,
  generatePRContent,
  generateLLMAdvisory,
  type EnrichedFinding,
  type LLMMetrics,
} from "../llm/analyzer";
import type { PipelineResult } from "../types";

export interface AgentConfig {
  workDir: string;
  githubToken?: string;
  maxRepos?: number;
  executePoCs?: boolean;
  submitPRs?: boolean;
  onProgress?: (step: string, detail: string) => Promise<void>;
  mode?: "SCAN" | "PROVE" | "FIX_PLAN";
}

export interface AgentRun {
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  stars: number;
  score: number;
  pipelineResult: PipelineResult | null;
  patches: CodePatch[];
  pocResults: PoCResult[];
  enrichedFindings: EnrichedFinding[];
  llmMetrics: LLMMetrics | null;
  advisory: string | null;
  prUrl: string | null;
  error: string | null;
  durationMs: number;
}

export interface AgentReport {
  runs: AgentRun[];
  totalReposScanned: number;
  totalFindingsCreated: number;
  totalPRsOpened: number;
  startedAt: string;
  finishedAt: string;
}

export async function runAgent(
  repos: Array<{ url: string; owner: string; name: string; stars: number; score: number }>,
  config: AgentConfig
): Promise<AgentReport> {
  const startedAt = new Date().toISOString();
  const runs: AgentRun[] = [];
  const maxRepos = config.maxRepos ?? 5;
  const progress = config.onProgress || (async () => {});
  const mode = config.mode || "FIX_PLAN";

  if (!existsSync(config.workDir)) {
    mkdirSync(config.workDir, { recursive: true });
  }

  const llmReady = isLLMAvailable();
  if (llmReady) {
    await progress("llm", "Moonshot/Kimi API available — findings will be LLM-enriched");
  } else {
    await progress("llm", "MOONSHOT_API_KEY not set — using template descriptions");
  }

  for (const repo of repos.slice(0, maxRepos)) {
    const runStart = Date.now();
    const repoDir = path.join(config.workDir, `${repo.owner}_${repo.name}`);

    await progress("start", `Processing ${repo.owner}/${repo.name} (${repo.stars} stars)`);

    const run: AgentRun = {
      repoUrl: repo.url,
      repoOwner: repo.owner,
      repoName: repo.name,
      stars: repo.stars,
      score: repo.score,
      pipelineResult: null,
      patches: [],
      pocResults: [],
      enrichedFindings: [],
      llmMetrics: null,
      advisory: null,
      prUrl: null,
      error: null,
      durationMs: 0,
    };

    try {
      // —— Step 1: Clone ——
      await progress("clone", `Cloning ${repo.url}...`);
      if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
      mkdirSync(repoDir, { recursive: true });

      const cloneUrl = config.githubToken
        ? repo.url.replace("https://", `https://${config.githubToken}@`)
        : repo.url;

      const execOpts: ExecSyncOptions = {
        timeout: 60_000,
        stdio: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      };
      execSync(`git clone --depth=1 --single-branch "${cloneUrl}" "${repoDir}"`, execOpts);

      // —— Step 2: Audit pipeline ——
      await progress("audit", `Running ${mode} pipeline...`);
      const pipelineResult = await runPipeline({
        repoPath: repoDir,
        mode: mode as "SCAN" | "PROVE" | "FIX_PLAN",
        onProgress: async (stage, pct) => {
          await progress("pipeline", `${stage} ${pct}%`);
        },
      });
      run.pipelineResult = pipelineResult;

      const actionable = pipelineResult.findings.filter(
        (f) => ["CRITICAL", "HIGH"].includes(f.severity) && f.confidence >= 0.6
      );

      if (actionable.length === 0) {
        await progress("skip", "No actionable findings found");
        run.durationMs = Date.now() - runStart;
        runs.push(run);
        continue;
      }

      await progress("found", `${actionable.length} actionable finding(s)`);

      // —— Step 3: Generate patches ——
      await progress("patch", `Generating code patches...`);
      const patches = generatePatches(actionable, pipelineResult.program, repoDir);
      run.patches = patches;
      await progress("patch", `${patches.length} file(s) patched`);

      // —— Step 4: Execute PoCs ——
      if (config.executePoCs) {
        await progress("poc", "Running proof-of-concept tests...");
        const pocResults = executePocs(actionable, pipelineResult.program, repoDir);
        run.pocResults = pocResults;
        const proven = pocResults.filter((p) => p.status === "proven").length;
        await progress("poc", `${proven}/${pocResults.length} PoCs proven`);
      }

      // —— Step 5: LLM enrichment (v2: dedupe → select → deep dive) ——
      if (llmReady) {
        await progress("llm", "Analyzing findings with Kimi K2 (v2: dedupe → select → deep dive)...");
        try {
          const { enriched, metrics } = await analyzeAllFindings(
            pipelineResult.findings,
            pipelineResult.program,
            patches,
            run.pocResults
          );
          run.enrichedFindings = enriched;
          run.llmMetrics = metrics;
          await progress(
            "llm",
            `${metrics.deepDivesSucceeded}/${metrics.deepDivesAttempted} enriched (${metrics.dedupedFindings} deduped from ${metrics.totalFindings}), ${metrics.totalDurationMs}ms`
          );
        } catch (e: any) {
          await progress("llm_error", `LLM enrichment failed: ${e.message}`);
        }
      }

      // —— Step 6: Generate advisory ——
      await progress("advisory", "Generating security advisory...");

      let advisory: string;
      if (llmReady && run.enrichedFindings.length > 0) {
        const llmAdvisory = await generateLLMAdvisory(
          pipelineResult.program,
          pipelineResult.findings,
          pipelineResult.summary,
          run.enrichedFindings,
          patches,
          run.pocResults,
          repo.url
        );
        advisory = llmAdvisory || generateSecurityAdvisory(
          pipelineResult.program,
          pipelineResult.findings,
          pipelineResult.summary,
          pipelineResult.graphs,
          {
            repoUrl: repo.url,
            repoMeta: { stars: repo.stars, framework: pipelineResult.program.framework },
            patches,
            pocResults: run.pocResults,
          }
        );
      } else {
        advisory = generateSecurityAdvisory(
          pipelineResult.program,
          pipelineResult.findings,
          pipelineResult.summary,
          pipelineResult.graphs,
          {
            repoUrl: repo.url,
            repoMeta: { stars: repo.stars, framework: pipelineResult.program.framework },
            patches,
            pocResults: run.pocResults,
          }
        );
      }

      run.advisory = advisory;
      const advisoryPath = path.join(repoDir, "SECURITY_ADVISORY.md");
      writeFileSync(advisoryPath, advisory, "utf-8");

      // —— Step 7: Submit PR ——
      if (config.submitPRs && config.githubToken && patches.length > 0) {
        await progress("pr", "Forking repo and opening pull request...");
        try {
          const { GitHubClient } = await import("@solaudit/github");
          const gh = new GitHubClient(config.githubToken);

          let prTitle: string;
          let prBody: string;

          if (llmReady && run.enrichedFindings.length > 0) {
            const prContent = await generatePRContent(
              pipelineResult.program,
              actionable,
              run.enrichedFindings,
              patches,
              repo.url
            );
            prTitle = prContent.title;
            prBody = prContent.body;
          } else {
            const fallback = generatePRBody(
              pipelineResult.program,
              actionable,
              pipelineResult.summary,
              patches,
              { repoUrl: repo.url }
            );
            prTitle = fallback.title;
            prBody = fallback.body;
          }

          prBody += `\n\n<details>\n<summary>Full Security Advisory</summary>\n\n${advisory}\n\n</details>`;

          const prResult = await gh.submitFix(repo.url, {
            title: prTitle,
            body: prBody,
            patches: patches.map((p) => ({
              path: p.file,
              content: p.patchedContent,
            })),
            branch: `solaudit/security-fix-${Date.now()}`,
          });

          run.prUrl = prResult.prUrl;
          await progress("pr", `PR opened: ${prResult.prUrl}`);
        } catch (prErr: any) {
          await progress("pr_error", prErr.message);
          run.error = `PR failed: ${prErr.message}`;
        }
      }

      await progress("done", `Completed ${repo.owner}/${repo.name}`);
    } catch (err: any) {
      run.error = err.message;
      await progress("error", err.message);
    } finally {
      run.durationMs = Date.now() - runStart;
      runs.push(run);

      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  }

  return {
    runs,
    totalReposScanned: runs.length,
    totalFindingsCreated: runs.reduce(
      (sum, r) => sum + (r.pipelineResult?.findings.length ?? 0),
      0
    ),
    totalPRsOpened: runs.filter((r) => r.prUrl).length,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}