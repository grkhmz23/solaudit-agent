/**
 * Agent Job Handler for the Worker
 *
 * Processes agent jobs from the queue:
 * - "discover" mode: Search GitHub → rank repos → run agent pipeline
 * - "audit" mode: Direct audit on specified repo URL
 *
 * FIXES (v3 — production hardening per manager review):
 * - Full report uploaded to R2 as artifact (not stuffed into Postgres summary)
 * - Advisory content actually uploaded to R2 (not just DB record)
 * - Artifact field names fixed: size→sizeBytes, storageKey→objectKey
 * - Only minimal summary stored in auditJob.summary
 * - Error messages truncated to prevent BullMQ/Upstash blowup
 * - LLM timeout raised to 180s (in analyzer.ts)
 */

import { prisma } from "@solaudit/db";
import {
  runAgent,
  scoreRepo,
  getKnownProtocols,
  type AgentConfig,
} from "@solaudit/engine";
import { getStorage } from "@solaudit/storage";
import type { AuditJobData } from "@solaudit/queue";

interface AgentJobConfig {
  type: "discover" | "audit";
  minStars?: number;
  maxRepos?: number;
  submitPRs?: boolean;
}

const storage = getStorage();

// ── Error truncation ────────────────────────────────────────────────
// Prevents massive Prisma/runtime errors from blowing up BullMQ
// failedReason in Redis (Upstash 10MB limit).

function truncateError(err: unknown, max = 2000): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? msg.slice(0, max) + "…(truncated)" : msg;
}

// ── Minimal summary for Postgres ────────────────────────────────────
// Only counts, severity breakdown, and enriched titles go into the DB.
// Full report goes to R2.

function buildMinimalSummary(report: any): any {
  const summary: any = {
    totalFindings: 0,
    totalEnriched: 0,
    totalPatches: 0,
    totalPRs: 0,
    totalPocs: 0,
    runs: [],
  };

  if (Array.isArray(report.runs)) {
    for (const run of report.runs) {
      const runSummary: any = {
        repoUrl: run.repoUrl,
        owner: run.repoOwner,
        name: run.repoName,
        error: run.error ? truncateError(run.error, 500) : null,
        findingCount: run.pipelineResult?.findings?.length ?? 0,
        enrichedCount: run.enrichedFindings?.length ?? 0,
        patchCount: run.patches?.length ?? 0,
        pocCount: run.generatedPocs?.length ?? 0,
        hasAdvisory: !!run.advisory,
        hasSubmissionDoc: !!run.submissionDoc,
        prUrl: run.prUrl || null,
        writeupUrl: run.writeupUrl || null,
        durationMs: run.durationMs || null,
        severityCounts: {} as Record<string, number>,
      };

      if (Array.isArray(run.pipelineResult?.findings)) {
        for (const f of run.pipelineResult.findings) {
          const sev = f.severity || "UNKNOWN";
          runSummary.severityCounts[sev] = (runSummary.severityCounts[sev] || 0) + 1;
        }
        summary.totalFindings += run.pipelineResult.findings.length;
      }

      // Keep enriched titles + impact (compact, ~50 bytes each)
      if (Array.isArray(run.enrichedFindings)) {
        runSummary.enrichedTitles = run.enrichedFindings.map((ef: any) => ({
          title: String(ef.title || "").slice(0, 120),
          impact: String(ef.impact || ef.description || "").slice(0, 240),
          exploitability: ef.exploitability || "unknown",
          confidence: ef.confidence,
        }));
        summary.totalEnriched += run.enrichedFindings.length;
      }

      summary.totalPatches += runSummary.patchCount;
      summary.totalPocs += runSummary.pocCount;
      if (run.prUrl) summary.totalPRs++;

      summary.runs.push(runSummary);
    }
  }

  return summary;
}

// ── R2 upload helpers ───────────────────────────────────────────────

async function uploadReportToR2(auditJobId: string, report: any): Promise<void> {
  try {
    const reportJson = JSON.stringify(report, null, 2);
    const result = await storage.putArtifact(
      auditJobId, "agent-result.json", reportJson, "application/json"
    );
    await prisma.artifact.create({
      data: {
        auditJobId,
        type: "REPORT",
        name: "agent-result.json",
        objectKey: result.objectKey,
        contentType: "application/json",
        metadata: {},
        sizeBytes: result.sizeBytes,
      },
    });
    console.log(`[agent] Full report uploaded to R2: ${result.objectKey} (${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e: any) {
    console.warn(`[agent] Failed to upload report to R2: ${e.message}`);
  }
}

async function uploadAdvisoryToR2(
  auditJobId: string,
  advisory: string,
  owner: string,
  name: string
): Promise<void> {
  try {
    const result = await storage.putArtifact(
      auditJobId, `${owner}_${name}_advisory.md`, advisory, "text/markdown"
    );
    await prisma.artifact.create({
      data: {
        auditJobId,
        type: "ADVISORY",
        name: `${owner}_${name}_advisory.md`,
        objectKey: result.objectKey,
        contentType: "text/markdown",
        metadata: {},
        sizeBytes: result.sizeBytes,
      },
    });
    console.log(`[agent] Advisory uploaded to R2: ${result.objectKey}`);
  } catch (e: any) {
    console.warn(`[agent] Failed to upload advisory to R2: ${e.message}`);
  }
}

async function uploadSubmissionDocToR2(
  auditJobId: string,
  doc: string,
  owner: string,
  name: string
): Promise<string | null> {
  try {
    const fileName = `${owner}_${name}_submission.md`;
    const result = await storage.putArtifact(
      auditJobId, fileName, doc, "text/markdown"
    );
    await prisma.artifact.create({
      data: {
        auditJobId,
        type: "REPORT",
        name: fileName,
        objectKey: result.objectKey,
        contentType: "text/markdown",
        metadata: { purpose: "bounty_submission" },
        sizeBytes: result.sizeBytes,
      },
    });
    console.log(`[agent] Submission doc uploaded to R2: ${result.objectKey} (${(result.sizeBytes / 1024).toFixed(1)} KB)`);
    return result.objectKey;
  } catch (e: any) {
    console.warn(`[agent] Failed to upload submission doc to R2: ${e.message}`);
    return null;
  }
}

// ── Main handler ────────────────────────────────────────────────────

export async function handleAgentJob(
  jobData: AuditJobData,
  updateProgress: (stage: string, pct: number) => Promise<void>
): Promise<void> {
  const agentConfig = jobData.agentConfig as AgentJobConfig | undefined;

  if (!agentConfig) {
    await handleSingleRepoAgent(jobData, updateProgress);
    return;
  }

  if (agentConfig.type === "discover") {
    await handleDiscoverAgent(jobData, agentConfig, updateProgress);
  } else {
    await handleSingleRepoAgent(jobData, updateProgress);
  }
}

// ── Discover mode ───────────────────────────────────────────────────

async function handleDiscoverAgent(
  jobData: AuditJobData,
  agentConfig: AgentJobConfig,
  updateProgress: (stage: string, pct: number) => Promise<void>
): Promise<void> {
  await updateProgress("discovering", 5);

  const protocols = getKnownProtocols();
  const repos = protocols.map((p) => {
    const { score } = scoreRepo({
      stars: 500,
      forks: 100,
      topics: ["solana", p.category],
      updatedAt: new Date().toISOString(),
      owner: p.owner,
      name: p.repo,
    });
    return {
      url: `https://github.com/${p.owner}/${p.repo}`,
      owner: p.owner,
      name: p.repo,
      stars: 500,
      score,
    };
  });

  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) {
    try {
      const { GitHubClient } = await import("@solaudit/github");
      const gh = new GitHubClient(ghToken);
      await updateProgress("searching_github", 10);

      const searchResults = await gh.searchSolanaRepos({
        minStars: agentConfig.minStars || 50,
        maxResults: 30,
      });

      for (const sr of searchResults) {
        const existing = repos.find(
          (r) => r.owner === sr.owner && r.name === sr.repo
        );
        if (existing) {
          existing.stars = sr.stars;
          const { score } = scoreRepo({
            stars: sr.stars,
            forks: sr.forks,
            topics: sr.topics,
            updatedAt: sr.updatedAt,
            owner: sr.owner,
            name: sr.repo,
          });
          existing.score = score;
        } else {
          const { score } = scoreRepo({
            stars: sr.stars,
            forks: sr.forks,
            topics: sr.topics,
            updatedAt: sr.updatedAt,
            owner: sr.owner,
            name: sr.repo,
          });
          repos.push({
            url: sr.htmlUrl,
            owner: sr.owner,
            name: sr.repo,
            stars: sr.stars,
            score,
          });
        }
      }
    } catch (e: any) {
      console.warn(`[agent] GitHub search failed: ${e.message}`);
    }
  }

  repos.sort((a, b) => b.score - a.score);
  const maxRepos = agentConfig.maxRepos || 5;

  await updateProgress("agent_starting", 15);

  const config: AgentConfig = {
    workDir: `/tmp/solaudit-agent-${Date.now()}`,
    githubToken: ghToken,
    maxRepos,
    executePoCs: process.env.WORKER_ENABLE_PROVE === "true",
    submitPRs: agentConfig.submitPRs && !!ghToken,
    mode: "FIX_PLAN",
    onProgress: async (step, detail) => {
      console.log(`[agent] ${step}: ${detail}`);
      const pctMap: Record<string, number> = {
        clone: 20,
        audit: 28,
        pipeline: 36,
        patch: 44,
        patch_author: 45,
        patch_validate: 48,
        patch_retry: 49,
        poc: 52,
        llm: 55,
        poc_gen: 63,
        advisory: 70,
        submission_doc: 76,
        pr: 82,
        writeup: 86,
        done: 90,
      };
      const pct = pctMap[step] || 50;
      await updateProgress(`agent_${step}`, pct);
      try {
        await prisma.auditJob.update({
          where: { id: jobData.auditJobId },
          data: { stageName: `agent:${step}`, progress: pct },
        });
      } catch {}
    },
  };

  const report = await runAgent(repos, config);

  // ── Upload full report to R2 ──
  await uploadReportToR2(jobData.auditJobId, report);

  // ── Upload per-run advisories + submission docs to R2 ──
  for (const run of report.runs) {
    if (run.advisory) {
      await uploadAdvisoryToR2(jobData.auditJobId, run.advisory, run.repoOwner, run.repoName);
    }
    if (run.submissionDoc) {
      await uploadSubmissionDocToR2(jobData.auditJobId, run.submissionDoc, run.repoOwner, run.repoName);
    }
  }

  // ── Store only minimal summary in Postgres ──
  const minimalSummary = buildMinimalSummary(report);

  await prisma.auditJob.update({
    where: { id: jobData.auditJobId },
    data: {
      status: "SUCCEEDED",
      progress: 100,
      stageName: "completed",
      summary: minimalSummary,
    },
  });

  await updateProgress("completed", 100);
}

// ── Single repo mode ────────────────────────────────────────────────

async function handleSingleRepoAgent(
  jobData: AuditJobData,
  updateProgress: (stage: string, pct: number) => Promise<void>
): Promise<void> {
  const repoUrl = jobData.repoUrl;
  const agentConfig = jobData.agentConfig as AgentJobConfig | undefined;
  const ghToken = process.env.GITHUB_TOKEN;

  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.\s]+)/);
  if (!match) {
    throw new Error(`Invalid repo URL: ${repoUrl}`);
  }

  const [, owner, name] = match;

  await updateProgress("agent_starting", 10);

  const config: AgentConfig = {
    workDir: `/tmp/solaudit-agent-${Date.now()}`,
    githubToken: ghToken,
    maxRepos: 1,
    executePoCs: process.env.WORKER_ENABLE_PROVE === "true",
    submitPRs: (agentConfig?.submitPRs ?? false) && !!ghToken,
    mode: (jobData.mode as "SCAN" | "PROVE" | "FIX_PLAN") || "FIX_PLAN",
    onProgress: async (step, detail) => {
      console.log(`[agent] ${step}: ${detail}`);
      const pctMap: Record<string, number> = {
        clone: 15,
        audit: 25,
        pipeline: 35,
        found: 40,
        patch: 45,
        patch_author: 47,
        patch_validate: 50,
        patch_retry: 52,
        poc: 55,
        llm: 58,
        poc_gen: 66,
        advisory: 72,
        submission_doc: 78,
        pr: 85,
        writeup: 90,
        done: 95,
      };
      const pct = pctMap[step] || 50;
      await updateProgress(`agent_${step}`, pct);
      try {
        await prisma.auditJob.update({
          where: { id: jobData.auditJobId },
          data: { stageName: `agent:${step}`, progress: pct },
        });
      } catch {}
    },
  };

  const repos = [{ url: repoUrl, owner, name, stars: 0, score: 0 }];

  if (ghToken) {
    try {
      const { GitHubClient } = await import("@solaudit/github");
      const gh = new GitHubClient(ghToken);
      const info = await gh.getRepoInfo({ owner, repo: name });
      repos[0].stars = info.stars;
    } catch {}
  }

  const report = await runAgent(repos, config);
  const run = report.runs[0];

  // ── Upload full report to R2 ──
  await uploadReportToR2(jobData.auditJobId, report);

  // ── Upload advisory to R2 (actual content, not just DB record) ──
  if (run?.advisory) {
    await uploadAdvisoryToR2(jobData.auditJobId, run.advisory, owner, name);
  }

  // ── Upload submission document to R2 (Priority 3) ──
  if (run?.submissionDoc) {
    await uploadSubmissionDocToR2(jobData.auditJobId, run.submissionDoc, owner, name);
  }

  // ── Store findings in DB (with PoC data, fix plans, blast radius) ──
  if (run?.pipelineResult?.findings) {
    for (const f of run.pipelineResult.findings) {
      try {
        const enriched = run.enrichedFindings?.find(
          (e: any) => e.title === f.title || e.title.includes(f.className)
        );

        // Match generated PoC to this finding
        const poc = run.generatedPocs?.find(
          (p: any) =>
            p.findingTitle === f.title ||
            (p.classId === f.classId && p.severity === f.severity)
        );

        // Match legacy PoC execution result
        const pocExec = run.pocResults?.find(
          (p: any) => p.findingTitle === f.title
        );

        // Determine proof status
        let proofStatus: "PENDING" | "PLANNED" | "PROVEN" | "DISPROVEN" | "SKIPPED" | "ERROR" = "PENDING";
        if (pocExec?.status === "proven") proofStatus = "PROVEN";
        else if (pocExec?.status === "disproven") proofStatus = "DISPROVEN";
        else if (pocExec?.status === "error") proofStatus = "ERROR";
        else if (poc?.status === "generated") proofStatus = "PLANNED";
        else if (poc?.status === "fallback") proofStatus = "PLANNED";

        // Build proof plan from generated PoC or existing plan
        const proofPlan = poc
          ? {
              steps: poc.reproSteps,
              harness: poc.testCode.slice(0, 8000),
              fileName: poc.fileName,
              runCommand: poc.runCommand,
              framework: poc.framework,
              stateComparison: poc.stateComparison,
              generationStatus: poc.status,
            }
          : f.proofPlan
            ? {
                steps: f.proofPlan.steps,
                harness: f.proofPlan.harness?.slice(0, 4000) || null,
                deltaSchema: f.proofPlan.deltaSchema || null,
              }
            : null;

        // Build proof artifacts from execution results
        const proofArtifacts = pocExec
          ? {
              status: pocExec.status,
              output: pocExec.output?.slice(0, 3000) || null,
              testFile: pocExec.testFile,
              command: pocExec.command,
              durationMs: pocExec.durationMs,
            }
          : null;

        await prisma.finding.create({
          data: {
            auditJobId: jobData.auditJobId,
            classId: f.classId,
            className: f.className,
            severity: f.severity,
            confidence: f.confidence,
            title: enriched?.title || f.title,
            hypothesis: enriched?.description || f.hypothesis || "",
            location: {
              file: f.location.file,
              line: f.location.line,
              instruction: f.location.instruction || null,
            },
            proofStatus,
            proofPlan: proofPlan || undefined,
            proofArtifacts: proofArtifacts || undefined,
            fixPlan: f.fixPlan
              ? {
                  pattern: f.fixPlan.pattern,
                  description: f.fixPlan.description,
                  code: f.fixPlan.code?.slice(0, 4000) || null,
                  regressionTests: f.fixPlan.regressionTests || [],
                }
              : undefined,
            blastRadius: f.blastRadius
              ? {
                  affectedAccounts: f.blastRadius.affectedAccounts,
                  affectedInstructions: f.blastRadius.affectedInstructions,
                  signerChanges: f.blastRadius.signerChanges,
                }
              : undefined,
          },
        });
      } catch (e: any) {
        console.warn(`[agent] Failed to store finding: ${e.message}`);
      }
    }
  }

  // ── Store only minimal summary in Postgres ──
  const minimalSummary = buildMinimalSummary(report);

  await prisma.auditJob.update({
    where: { id: jobData.auditJobId },
    data: {
      status: (run?.error && !run?.pipelineResult?.findings?.length) ? "FAILED" : "SUCCEEDED",
      progress: 100,
      stageName: "completed",
      summary: minimalSummary,
    },
  });

  await updateProgress("completed", 100);
}