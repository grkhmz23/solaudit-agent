/**
 * Agent Orchestrator v3 — Full End-to-End Bounty Pipeline
 *
 * Autonomous flow:
 * 1. Clone target repo
 * 2. Run audit pipeline (SCAN → PROVE → FIX_PLAN)
 * 3. Generate code patches for actionable findings
 * 4. Execute PoC harnesses (if anchor/cargo available)
 * 5. LLM-enrich findings (dedupe → select → deep dive)
 * 5.5. LLM PoC generation (NEW — realistic test files per finding)
 * 6. Generate professional advisory document
 * 6.5. Generate bounty submission document (NEW — detailed write-up)
 * 7. Generate bounty-grade PR body, fork repo, commit patches + PoCs, open PR
 */

import { execSync, type ExecSyncOptions } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { runPipeline } from "../pipeline";
import { runPipelineV2, v2ResultToV1, runHybridPipeline, loadV2Config } from "../v2/index";
import { buildV2Advisory } from "../v2/report/index";
import type { V2PipelineResult } from "../v2/types";
import { runPatchPipeline, v2PatchesToLegacy, type PatchPipelineResult, type V2PatchResult } from "../v2/patch/index";
import { generatePatches, type CodePatch } from "../remediation/patcher";
import { executePocs, type PoCResult } from "../proof/executor";
import { generatePoCs, type GeneratedPoC } from "../proof/llm-poc-generator";
import { generateSecurityAdvisory, generatePRBody } from "../report/advisory";
import { generateSubmissionDocument } from "../report/submission-doc";
import {
  isLLMAvailable,
  analyzeAllFindings,
  generatePRContent,
  generateLLMAdvisory,
  generateBountyPRBody,
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
  generatedPocs: GeneratedPoC[];
  enrichedFindings: EnrichedFinding[];
  llmMetrics: LLMMetrics | null;
  advisory: string | null;
  submissionDoc: string | null;
  prUrl: string | null;
  writeupUrl: string | null;
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
      generatedPocs: [],
      enrichedFindings: [],
      llmMetrics: null,
      advisory: null,
      submissionDoc: null,
      prUrl: null,
      writeupUrl: null,
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
      const v2Config = loadV2Config();
      const pipelineCtx = {
        repoPath: repoDir,
        mode: mode as "SCAN" | "PROVE" | "FIX_PLAN",
        onProgress: async (stage: string, pct: number) => {
          await progress("pipeline", `${stage} ${pct}%`);
        },
      };

      let pipelineResult;
      let v2Result: V2PipelineResult | null = null;
      const isV2 = v2Config.engineVersion === "v2" || v2Config.engineVersion === "hybrid";

      if (v2Config.engineVersion === "v2") {
        console.log("[orchestrator] Engine version: V2");
        v2Result = await runPipelineV2(pipelineCtx);
        pipelineResult = v2ResultToV1(v2Result);
        console.log(
          `[orchestrator] V2: ${v2Result.findings.length} findings ` +
          `(${v2Result.findings.filter((f) => f.status !== "REJECTED").length} actionable)`,
        );
      } else if (v2Config.engineVersion === "hybrid") {
        console.log("[orchestrator] Engine version: HYBRID (V1 + V2)");
        v2Result = await runHybridPipeline(pipelineCtx, runPipeline);
        pipelineResult = v2ResultToV1(v2Result);
        if (v2Result.hybridComparison) {
          const hc = v2Result.hybridComparison;
          console.log(
            `[orchestrator] Hybrid: V1=${hc.v1TotalFindings} V2=${hc.v2TotalFindings} ` +
            `overlap=${hc.overlap} V1-FP=${hc.v1FalsePositivesRejected} V2-novel=${hc.v2NovelFindings}`,
          );
        }
      } else {
        console.log("[orchestrator] Engine version: V1 (legacy)");
        pipelineResult = await runPipeline(pipelineCtx);
      }
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

      // ════════════════════════════════════════════════════════════
      // V2-native path: V2 already did LLM confirmation + PoC.
      // Now: Kimi Patch Author → Validate → Advisory → PR
      // ════════════════════════════════════════════════════════════
      if (isV2 && v2Result) {
        // —— V2 Step 3: Kimi Patch Author (LLM-powered patches) ——
        let patches: CodePatch[] = [];
        let patchPipelineResult: PatchPipelineResult | null = null;

        if (v2Config.patchAuthor && actionable.length > 0) {
          await progress("patch", "Kimi patch author: generating validated patches...");
          try {
            patchPipelineResult = await runPatchPipeline(
              v2Result.findings,
              v2Result.program,
              repoDir,
              v2Config,
              async (step, detail) => progress(step, detail),
            );

            const validated = patchPipelineResult.results.filter((r) => r.status === "validated");
            const needsHuman = patchPipelineResult.results.filter((r) => r.status === "needs_human");

            // Convert validated patches to legacy format for PR submission
            patches = v2PatchesToLegacy(patchPipelineResult.results, repoDir);
            run.patches = patches;

            await progress("patch",
              `Kimi patches: ${validated.length} validated, ${needsHuman.length} needs_human ` +
              `(${patchPipelineResult.metrics.totalDurationMs}ms)`
            );
          } catch (e: any) {
            console.error(`[orchestrator] Kimi patch author failed: ${e.message}`);
            await progress("patch_error", `Kimi patch author failed: ${e.message}`);
          }
        }

        // Fallback: if Kimi patch author is disabled or produced nothing, use deterministic patcher
        if (patches.length === 0) {
          await progress("patch", "Fallback: deterministic patches...");
          patches = generatePatches(actionable, pipelineResult.program, repoDir);
          run.patches = patches;
          await progress("patch", `${patches.length} file(s) patched (deterministic)`);
        }

        // —— V2 Step 4: Advisory from V2 findings (already LLM-enriched) ——
        await progress("advisory", "Generating V2 security advisory...");
        const advisory = buildV2Advisory(v2Result);
        run.advisory = advisory;
        const advisoryPath = path.join(repoDir, "SECURITY_ADVISORY.md");
        writeFileSync(advisoryPath, advisory, "utf-8");

        // Include patch validation results in advisory
        if (patchPipelineResult) {
          const patchSection = buildPatchSummarySection(patchPipelineResult);
          const fullAdvisory = advisory + "\n\n" + patchSection;
          writeFileSync(advisoryPath, fullAdvisory, "utf-8");
          run.advisory = fullAdvisory;
        }

        // —— V2 Step 5: Submission document ——
        await progress("submission_doc", "Generating bounty submission document...");
        try {
          const submissionDoc = generateSubmissionDocument(
            pipelineResult.program,
            pipelineResult.findings,
            pipelineResult.summary,
            pipelineResult.graphs,
            [],  // V2 findings are already enriched inline
            patches,
            run.pocResults,
            run.generatedPocs,
            null,
            {
              repoUrl: repo.url,
              repoMeta: { stars: repo.stars, framework: pipelineResult.program.framework },
              agentRepoUrl: "https://github.com/grkhmz23/solaudit-agent",
            },
          );
          run.submissionDoc = submissionDoc;
          const submissionDocPath = path.join(repoDir, "SUBMISSION.md");
          writeFileSync(submissionDocPath, submissionDoc, "utf-8");
          await progress("submission_doc", "Submission document generated");
        } catch (e: any) {
          await progress("submission_doc_error", `Submission doc failed: ${e.message}`);
        }

        // —— V2 Step 6: Submit PR (only if patches validated) ——
        const validatedPatches = patchPipelineResult?.results?.filter((r) => r.status === "validated") ?? [];
        if (config.submitPRs && config.githubToken && validatedPatches.length > 0) {
          await progress("pr", "Forking repo and opening pull request...");
          try {
            const { GitHubClient } = await import("@solaudit/github");
            const gh = new GitHubClient(config.githubToken);

            const prTitle = `[SolAudit] Security: ${actionable.length} finding(s) in ${repo.name}`;
            let prBody = `## SolAudit V2 Security Report\n\n`;
            prBody += `**Engine:** V2 (tree-sitter + LLM confirmation + Kimi patch author)\n`;
            prBody += `**Findings:** ${actionable.length} actionable\n`;
            prBody += `**Patches:** ${validatedPatches.length} validated, build-tested\n\n`;

            for (const f of actionable.slice(0, 10)) {
              prBody += `- **${f.severity}** ${f.classId}: ${f.title || f.hypothesis}\n`;
            }

            // Add patch rationale
            prBody += `\n### Patch Details\n\n`;
            for (const vp of validatedPatches) {
              const finding = v2Result.findings.find((f) => f.id === vp.findingId);
              prBody += `**${finding?.candidate.vulnClass || "fix"}** in \`${finding?.candidate.instruction || "?"}\`\n`;
              prBody += `> ${vp.rationale}\n\n`;
              if (vp.riskNotes) {
                prBody += `⚠️ ${vp.riskNotes}\n\n`;
              }
            }

            prBody += `\n<details>\n<summary>Full Security Advisory</summary>\n\n${advisory}\n\n</details>`;

            const allPatchFiles: Array<{ path: string; content: string }> = [];
            for (const vp of validatedPatches) {
              for (const p of vp.patches) {
                try {
                  const content = require("fs").readFileSync(
                    require("path").join(repoDir, p.path),
                    "utf-8",
                  );
                  allPatchFiles.push({ path: p.path, content });
                } catch {}
              }
            }

            const prResult = await gh.submitFix(repo.url, {
              title: prTitle,
              body: prBody,
              patches: allPatchFiles,
              branch: `solaudit/security-fix-${Date.now()}`,
            });

            run.prUrl = prResult.prUrl;
            await progress("pr", `PR opened: ${prResult.prUrl}`);
          } catch (prErr: any) {
            await progress("pr_error", prErr.message);
            run.error = `PR failed: ${prErr.message}`;
          }
        } else if (config.submitPRs && validatedPatches.length === 0) {
          await progress("pr", "Skipped PR: no validated patches to submit");
        }

        // —— V2 Step 7: Publish writeup as GitHub Gist ——
        if (config.githubToken && run.submissionDoc) {
          await progress("writeup", "Publishing writeup to GitHub Gist...");
          try {
            const { GitHubClient } = await import("@solaudit/github");
            const gh = new GitHubClient(config.githubToken);
            const gist = await gh.publishWriteup(repo.owner, repo.name, run.submissionDoc);
            run.writeupUrl = gist.gistUrl;
            await progress("writeup", `Writeup published: ${gist.gistUrl}`);
          } catch (gistErr: any) {
            await progress("writeup_error", `Gist failed: ${gistErr.message}`);
          }
        }

        await progress("done", `Completed ${repo.owner}/${repo.name}`);

      } else {
        // ════════════════════════════════════════════════════════════
        // V1 legacy path (unchanged)
        // ════════════════════════════════════════════════════════════

        // —— Step 3: Generate patches ——
        await progress("patch", `Generating code patches...`);
        const patches = generatePatches(actionable, pipelineResult.program, repoDir);
        run.patches = patches;
        await progress("patch", `${patches.length} file(s) patched`);

        // —— Step 4: Execute PoCs (legacy — optional) ——
        if (config.executePoCs) {
          await progress("poc", "Running proof-of-concept tests...");
          const pocResults = executePocs(actionable, pipelineResult.program, repoDir);
          run.pocResults = pocResults;
          const proven = pocResults.filter((p) => p.status === "proven").length;
          await progress("poc", `${proven}/${pocResults.length} PoCs proven`);
        }

        // —— Step 5: LLM enrichment ——
        if (llmReady) {
          await progress("llm", "Analyzing findings with Kimi K2 (v1: dedupe → select → deep dive)...");
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

        // —— Step 5.5: LLM PoC Generation ——
        await progress("poc_gen", "Generating proof-of-concept tests via LLM...");
        try {
          const generatedPocs = await generatePoCs(
            pipelineResult.findings,
            pipelineResult.program,
            run.enrichedFindings,
            patches,
          );
          run.generatedPocs = generatedPocs;
          const llmGen = generatedPocs.filter((p) => p.status === "generated").length;
          await progress(
            "poc_gen",
            `${llmGen}/${generatedPocs.length} PoCs LLM-generated`
          );
        } catch (e: any) {
          await progress("poc_gen_error", `PoC generation failed: ${e.message}`);
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

        // —— Step 6.5: Submission Document ——
        await progress("submission_doc", "Generating bounty submission document...");
        try {
          const submissionDoc = generateSubmissionDocument(
            pipelineResult.program,
            pipelineResult.findings,
            pipelineResult.summary,
            pipelineResult.graphs,
            run.enrichedFindings,
            patches,
            run.pocResults,
            run.generatedPocs,
            run.llmMetrics,
            {
              repoUrl: repo.url,
              repoMeta: { stars: repo.stars, framework: pipelineResult.program.framework },
              agentRepoUrl: "https://github.com/grkhmz23/solaudit-agent",
            },
          );
          run.submissionDoc = submissionDoc;
          const submissionDocPath = path.join(repoDir, "SUBMISSION.md");
          writeFileSync(submissionDocPath, submissionDoc, "utf-8");
          await progress("submission_doc", "Submission document generated");
        } catch (e: any) {
          await progress("submission_doc_error", `Submission doc failed: ${e.message}`);
        }

        // —— Step 7: Submit PR ——
        if (config.submitPRs && config.githubToken && patches.length > 0) {
          await progress("pr", "Forking repo and opening pull request...");
          try {
            const { GitHubClient } = await import("@solaudit/github");
            const gh = new GitHubClient(config.githubToken);

            let prTitle: string;
            let prBody: string;

            if (run.enrichedFindings.length > 0 || run.generatedPocs.length > 0) {
              const bountyPR = generateBountyPRBody(
                pipelineResult.program,
                actionable,
                run.enrichedFindings,
                patches,
                run.generatedPocs,
                run.pocResults,
                repo.url,
              );
              prTitle = bountyPR.title;
              prBody = bountyPR.body;
            } else if (llmReady && run.enrichedFindings.length > 0) {
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

            const allPatchFiles: Array<{ path: string; content: string }> = [
              ...patches.map((p) => ({ path: p.file, content: p.patchedContent })),
              ...run.generatedPocs.map((poc) => ({ path: poc.fileName, content: poc.testCode })),
            ];

            const prResult = await gh.submitFix(repo.url, {
              title: prTitle,
              body: prBody,
              patches: allPatchFiles,
              branch: `solaudit/security-fix-${Date.now()}`,
            });

            run.prUrl = prResult.prUrl;
            await progress("pr", `PR opened: ${prResult.prUrl}`);

            if (run.submissionDoc) {
              run.submissionDoc = run.submissionDoc.replace(
                "| **Pull Request** | Pending |",
                `| **Pull Request** | [View PR](${prResult.prUrl}) |`
              );
            }
          } catch (prErr: any) {
            await progress("pr_error", prErr.message);
            run.error = `PR failed: ${prErr.message}`;
          }
        }

        await progress("done", `Completed ${repo.owner}/${repo.name}`);
      } // end V1 legacy path
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

// ─── Patch Summary for Advisory ─────────────────────────────

function buildPatchSummarySection(patchResult: PatchPipelineResult): string {
  const lines: string[] = [];
  lines.push("## Automated Patch Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Patches attempted | ${patchResult.metrics.patchesAttempted} |`);
  lines.push(`| Validated (build-tested) | ${patchResult.metrics.patchesValidated} |`);
  lines.push(`| Needs human review | ${patchResult.metrics.patchesNeedHuman} |`);
  lines.push(`| Failed | ${patchResult.metrics.patchesFailed} |`);
  lines.push(`| Duration | ${(patchResult.metrics.totalDurationMs / 1000).toFixed(1)}s |`);
  lines.push("");

  for (const r of patchResult.results) {
    if (r.status === "validated") {
      lines.push(`### Finding #${r.findingId} — ✅ Validated`);
      lines.push(`> ${r.rationale}`);
      if (r.riskNotes) lines.push(`> ⚠️ ${r.riskNotes}`);
      lines.push(`Files: ${r.patches.map((p) => p.path).join(", ")}`);
      lines.push("");
    } else if (r.status === "needs_human") {
      lines.push(`### Finding #${r.findingId} — ⚠️ Needs Human Review`);
      lines.push(`> ${r.error || "Patch could not be validated after 2 attempts"}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}