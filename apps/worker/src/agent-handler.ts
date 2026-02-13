/**
 * Agent Job Handler for the Worker
 *
 * Processes agent jobs from the queue:
 * - "discover" mode: Search GitHub → rank repos → run agent pipeline
 * - "audit" mode: Direct audit on specified repo URL
 *
 * Wires the full orchestrator into the BullMQ worker.
 *
 * FIXES (v2.1):
 * - resultJson → summary (matches Prisma schema)
 * - Strip file contents from report before saving (91MB → ~500KB)
 *   to stay within Upstash Redis 10MB limit
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

// ── Payload stripping ──────────────────────────────────────────────
// The orchestrator returns full file contents (source code) inside
// pipelineResult.program.files[].content / .lines which can be 90MB+.
// We strip those before persisting to Postgres and before BullMQ
// stores the return value in Redis (Upstash 10MB limit).

function stripLargeFields(report: any): any {
  if (!report || typeof report !== "object") return report;

  // Deep clone to avoid mutating the original
  const stripped = JSON.parse(JSON.stringify(report));

  if (Array.isArray(stripped.runs)) {
    for (const run of stripped.runs) {
      // Strip file contents from pipelineResult.program.files
      if (run.pipelineResult?.program?.files) {
        run.pipelineResult.program.files = run.pipelineResult.program.files.map(
          (f: any) => ({
            path: f.path,
            language: f.language,
            size: f.size ?? f.content?.length ?? 0,
            lineCount: f.lineCount ?? f.lines?.length ?? 0,
            // Drop: content, lines, ast, tokens — these are the massive fields
          })
        );
      }

      // Strip raw source from findings if embedded
      if (Array.isArray(run.pipelineResult?.findings)) {
        for (const finding of run.pipelineResult.findings) {
          if (finding.sourceSnippet && finding.sourceSnippet.length > 2000) {
            finding.sourceSnippet =
              finding.sourceSnippet.slice(0, 2000) + "\n// ... truncated";
          }
        }
      }

      // Strip patches content if very large (keep first 5000 chars each)
      if (Array.isArray(run.patches)) {
        for (const patch of run.patches) {
          if (patch.diff && patch.diff.length > 5000) {
            patch.diff =
              patch.diff.slice(0, 5000) +
              "\n// ... truncated (full patch in PR)";
          }
        }
      }

      // Keep advisory as-is (it's generated markdown, typically <100KB)
      // Keep enrichedFindings as-is (compact LLM summaries)
    }
  }

  return stripped;
}

// Validate stripped payload is under a size limit (default 8MB, leaving 2MB headroom)
function validatePayloadSize(
  payload: any,
  label: string,
  maxBytes = 8 * 1024 * 1024
): any {
  const json = JSON.stringify(payload);
  const size = Buffer.byteLength(json, "utf-8");
  console.log(
    `[agent] ${label} payload size: ${(size / 1024 / 1024).toFixed(2)} MB`
  );

  if (size > maxBytes) {
    console.warn(
      `[agent] ${label} still too large (${(size / 1024 / 1024).toFixed(2)} MB), ` +
        `creating minimal summary instead`
    );
    return createMinimalSummary(payload);
  }
  return payload;
}

function createMinimalSummary(report: any): any {
  const summary: any = {
    _truncated: true,
    _reason: "Payload exceeded 8MB limit, storing minimal summary",
    totalFindings: 0,
    runs: [],
  };

  if (Array.isArray(report.runs)) {
    for (const run of report.runs) {
      const runSummary: any = {
        repoUrl: run.repoUrl,
        owner: run.owner,
        name: run.name,
        error: run.error || null,
        findingCount: run.pipelineResult?.findings?.length ?? 0,
        enrichedCount: run.enrichedFindings?.length ?? 0,
        patchCount: run.patches?.length ?? 0,
        hasAdvisory: !!run.advisory,
        prUrl: run.prUrl || null,
        severityCounts: {} as Record<string, number>,
      };

      // Count by severity
      if (Array.isArray(run.pipelineResult?.findings)) {
        for (const f of run.pipelineResult.findings) {
          const sev = f.severity || "unknown";
          runSummary.severityCounts[sev] =
            (runSummary.severityCounts[sev] || 0) + 1;
        }
        summary.totalFindings += run.pipelineResult.findings.length;
      }

      // Keep enriched finding titles/descriptions (compact)
      if (Array.isArray(run.enrichedFindings)) {
        runSummary.enrichedFindings = run.enrichedFindings.map((ef: any) => ({
          title: ef.title,
          severity: ef.severity,
          description: ef.description?.slice(0, 500),
        }));
      }

      summary.runs.push(runSummary);
    }
  }

  return summary;
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
        audit: 30,
        pipeline: 40,
        patch: 50,
        poc: 55,
        llm: 60,
        advisory: 70,
        pr: 80,
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

  // ── Strip large fields and save (FIX: resultJson → summary) ──
  const strippedReport = stripLargeFields(report);
  const safeSummary = validatePayloadSize(strippedReport, "discover");

  await prisma.auditJob.update({
    where: { id: jobData.auditJobId },
    data: {
      status: "COMPLETED",
      progress: 100,
      stageName: "completed",
      summary: safeSummary,
    },
  });

  await updateProgress("completed", 100);
  // Returns void — BullMQ stores return values in Redis; void avoids 91MB blow-up.
}

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
        pipeline: 40,
        found: 45,
        patch: 50,
        poc: 55,
        llm: 65,
        advisory: 75,
        pr: 85,
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

  // Store findings in DB
  if (run?.pipelineResult?.findings) {
    for (const f of run.pipelineResult.findings) {
      try {
        const enriched = run.enrichedFindings?.find(
          (e: any) => e.title === f.title || e.title.includes(f.className)
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

  // ── Strip large fields and save (FIX: resultJson → summary) ──
  const strippedReport = stripLargeFields(report);
  const safeSummary = validatePayloadSize(strippedReport, "single-repo");

  await prisma.auditJob.update({
    where: { id: jobData.auditJobId },
    data: {
      status: run?.error ? "FAILED" : "COMPLETED",
      progress: 100,
      stageName: "completed",
      summary: safeSummary,
    },
  });

  await updateProgress("completed", 100);
  // Returns void — BullMQ stores return values in Redis; void avoids 91MB blow-up.
}