/**
 * End-to-end Agent Orchestrator
 *
 * Autonomous pipeline:
 * 1. Clone target repos
 * 2. Audit each with full pipeline
 * 3. Execute PoC tests
 * 4. Generate code patches
 * 5. Create professional advisory
 * 6. Fork repo, commit patches, open PR
 */

import { execSync, type ExecSyncOptions } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { runPipeline } from "../pipeline";
import { generatePatches, type CodePatch } from "../remediation/patcher";
import { executePocs, type PoCResult } from "../proof/executor";
import { generateSecurityAdvisory, generatePRBody } from "../report/advisory";
import type { PipelineResult } from "../types";

export interface AgentConfig {
  /** Working directory for cloned repos */
  workDir: string;
  /** GitHub token for API access */
  githubToken?: string;
  /** Max repos to process in one run */
  maxRepos?: number;
  /** Run PoC tests? (requires anchor/cargo) */
  executePoCs?: boolean;
  /** Submit PRs? */
  submitPRs?: boolean;
  /** Progress callback */
  onProgress?: (step: string, detail: string) => Promise<void>;
  /** Audit mode */
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

/**
 * Run the full autonomous agent pipeline
 */
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

  const reposToProcess = repos.slice(0, maxRepos);

  for (const repo of reposToProcess) {
    const runStart = Date.now();
    const repoDir = path.join(config.workDir, `${repo.owner}_${repo.name}`);

    await progress("auditing", `${repo.owner}/${repo.name} (${repo.stars} stars)`);

    const run: AgentRun = {
      repoUrl: repo.url,
      repoOwner: repo.owner,
      repoName: repo.name,
      stars: repo.stars,
      score: repo.score,
      pipelineResult: null,
      patches: [],
      pocResults: [],
      advisory: null,
      prUrl: null,
      error: null,
      durationMs: 0,
    };

    try {
      // ── Step 1: Clone ──
      await progress("cloning", repo.url);
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

      // ── Step 2: Audit ──
      await progress("scanning", `Running ${mode} pipeline on ${repo.owner}/${repo.name}`);
      const pipelineResult = await runPipeline({
        repoPath: repoDir,
        mode: mode as "SCAN" | "PROVE" | "FIX_PLAN",
        onProgress: async (stage, pct) => {
          await progress("pipeline", `${stage} ${pct}%`);
        },
      });
      run.pipelineResult = pipelineResult;

      const actionableFindings = pipelineResult.findings.filter(
        (f) => ["CRITICAL", "HIGH"].includes(f.severity) && f.confidence >= 0.6
      );

      if (actionableFindings.length === 0) {
        await progress("skip", "No critical/high findings with sufficient confidence");
        run.durationMs = Date.now() - runStart;
        runs.push(run);
        continue;
      }

      // ── Step 3: Generate patches ──
      await progress("patching", `Generating fixes for ${actionableFindings.length} findings`);
      const patches = generatePatches(actionableFindings, pipelineResult.program, repoDir);
      run.patches = patches;

      // ── Step 4: Execute PoCs ──
      if (config.executePoCs) {
        await progress("proving", "Executing proof-of-concept harnesses");
        const pocResults = executePocs(actionableFindings, pipelineResult.program, repoDir);
        run.pocResults = pocResults;
      }

      // ── Step 5: Generate advisory ──
      await progress("reporting", "Generating security advisory");
      const advisory = generateSecurityAdvisory(
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
      run.advisory = advisory;

      // Save advisory to disk
      const advisoryPath = path.join(repoDir, "SECURITY_ADVISORY.md");
      writeFileSync(advisoryPath, advisory, "utf-8");

      // ── Step 6: Submit PR ──
      if (config.submitPRs && config.githubToken && patches.length > 0) {
        await progress("submitting", "Creating fork and opening PR");
        try {
          // Dynamic import to avoid hard dependency
          const { GitHubClient } = await import("@solaudit/github");
          const gh = new GitHubClient(config.githubToken);
          const { title, body } = generatePRBody(
            pipelineResult.program,
            actionableFindings,
            pipelineResult.summary,
            patches,
            { repoUrl: repo.url }
          );

          const prResult = await gh.submitFix(repo.url, {
            title,
            body,
            patches: patches.map((p) => ({
              path: p.file,
              content: p.patchedContent,
            })),
            branch: `solaudit/security-fix-${Date.now()}`,
          });

          run.prUrl = prResult.prUrl;
          await progress("done", `PR opened: ${prResult.prUrl}`);
        } catch (prErr: any) {
          await progress("pr_error", prErr.message);
          run.error = `PR submission failed: ${prErr.message}`;
        }
      }
    } catch (err: any) {
      run.error = err.message;
      await progress("error", err.message);
    } finally {
      run.durationMs = Date.now() - runStart;
      runs.push(run);

      // Cleanup
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
