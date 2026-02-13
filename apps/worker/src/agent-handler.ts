/**
 * Agent Job Handler for the Worker
 *
 * Processes agent jobs from the queue:
 * - "discover" mode: Search GitHub → rank repos → run agent pipeline
 * - "audit" mode: Direct audit on specified repo URL
 *
 * Wires the full orchestrator into the BullMQ worker.
 */

import { prisma } from "@solaudit/db";
import {
  runAgent,
  scoreRepo,
  getKnownProtocols,
  type AgentConfig,
} from "@solaudit/engine";
import type { AuditJobData } from "@solaudit/queue";

interface AgentJobConfig {
  type: "discover" | "audit";
  minStars?: number;
  maxRepos?: number;
  submitPRs?: boolean;
}

export async function handleAgentJob(
  jobData: AuditJobData,
  updateProgress: (stage: string, pct: number) => Promise<void>
): Promise<void> {
  const agentConfig = jobData.agentConfig as AgentJobConfig | undefined;

  if (!agentConfig) {
    // Regular audit — run on the single repo
    await handleSingleRepoAgent(jobData, updateProgress);
    return;
  }

  if (agentConfig.type === "discover") {
    await handleDiscoverAgent(jobData, agentConfig, updateProgress);
  } else {
    await handleSingleRepoAgent(jobData, updateProgress);
  }
}

async function handleDiscoverAgent(
  jobData: AuditJobData,
  agentConfig: AgentJobConfig,
  updateProgress: (stage: string, pct: number) => Promise<void>
): Promise<void> {
  await updateProgress("discovering", 5);

  // Use known protocols list as targets
  const protocols = getKnownProtocols();
  const repos = protocols.map((p) => {
    const { score, reason } = scoreRepo({
      stars: 500, // Default estimate
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

  // If GitHub token available, get real star counts
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

      // Merge search results with known protocols
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

  // Sort by score and take top N
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
        clone: 20, audit: 30, pipeline: 40, patch: 50,
        poc: 55, llm: 60, advisory: 70, pr: 80, done: 90,
      };
      const pct = pctMap[step] || 50;
      await updateProgress(`agent_${step}`, pct);
      // Update DB
      try {
        await prisma.auditJob.update({
          where: { id: jobData.auditJobId },
          data: { stageName: `agent:${step}`, progress: pct },
        });
      } catch {}
    },
  };

  const report = await runAgent(repos, config);

  // Save results
  await prisma.auditJob.update({
    where: { id: jobData.auditJobId },
    data: {
      status: "COMPLETED",
      progress: 100,
      stageName: "completed",
      resultJson: JSON.stringify(report) as any,
    },
  });

  await updateProgress("completed", 100);
}

async function handleSingleRepoAgent(
  jobData: AuditJobData,
  updateProgress: (stage: string, pct: number) => Promise<void>
): Promise<void> {
  const repoUrl = jobData.repoUrl;
  const agentConfig = jobData.agentConfig as AgentJobConfig | undefined;
  const ghToken = process.env.GITHUB_TOKEN;

  // Parse owner/name from URL
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
        clone: 15, audit: 25, pipeline: 40, found: 45,
        patch: 50, poc: 55, llm: 65, advisory: 75,
        pr: 85, done: 95,
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

  // Get real star count if GitHub token available
  if (ghToken) {
    try {
      const { GitHubClient } = await import("@solaudit/github");
      const gh = new GitHubClient(ghToken);
      const info = await gh.getRepoInfo({ owner, repo: name });
      repos[0].stars = info.stars;
    } catch {}
  }

  const report = await runAgent(repos, config);

  // Store advisory as artifact if we have one
  const run = report.runs[0];
  if (run?.advisory) {
    try {
      await prisma.artifact.create({
        data: {
          auditJobId: jobData.auditJobId,
          type: "ADVISORY",
          name: `${owner}_${name}_advisory.md`,
          contentType: "text/markdown",
          size: Buffer.byteLength(run.advisory, "utf-8"),
          storageKey: `advisories/${jobData.auditJobId}.md`,
        },
      });
    } catch (e: any) {
      console.warn(`[agent] Failed to store advisory artifact: ${e.message}`);
    }
  }

  // Store findings
  if (run?.pipelineResult?.findings) {
    for (const f of run.pipelineResult.findings) {
      try {
        const enriched = run.enrichedFindings.find(
          (e) => e.title === f.title || e.title.includes(f.className)
        );
        await prisma.finding.create({
          data: {
            auditJobId: jobData.auditJobId,
            classId: f.classId,
            className: f.className,
            severity: f.severity,
            confidence: f.confidence,
            title: enriched?.title || f.title,
            description: enriched?.description || f.hypothesis || "",
            file: f.location.file,
            line: f.location.line,
            instruction: f.location.instruction || null,
          },
        });
      } catch (e: any) {
        console.warn(`[agent] Failed to store finding: ${e.message}`);
      }
    }
  }

  await prisma.auditJob.update({
    where: { id: jobData.auditJobId },
    data: {
      status: run?.error ? "FAILED" : "COMPLETED",
      progress: 100,
      stageName: "completed",
      resultJson: JSON.stringify(report) as any,
    },
  });

  await updateProgress("completed", 100);
}
