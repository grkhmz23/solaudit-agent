import { handleAgentJob } from "./agent-handler";
import { Worker, Job } from "bullmq";
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "fs";
import path from "path";
import { prisma } from "@solaudit/db";
import { AUDIT_QUEUE_NAME, createRedisConnection, type AuditJobData } from "@solaudit/queue";
import { runPipeline } from "@solaudit/engine";
import { getStorage } from "@solaudit/storage";

const STORAGE_DIR = process.env.STORAGE_DIR || "/tmp/solaudit-storage";
const MAX_REPO_SIZE_MB = 200;
const CLONE_TIMEOUT_MS = 120_000;

function truncateError(err: unknown, max = 2000): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? msg.slice(0, max) + "…(truncated)" : msg;
}

if (!existsSync(STORAGE_DIR)) {
  mkdirSync(STORAGE_DIR, { recursive: true });
}

const storage = getStorage();
const redis = createRedisConnection();

console.log(`[worker] starting solaudit worker...`);
console.log(`[worker] storage dir: ${STORAGE_DIR}`);

const worker = new Worker<AuditJobData>(
  AUDIT_QUEUE_NAME,
  async (job: Job<AuditJobData>) => {
    const { auditJobId, repoUrl, repoSource, mode } = job.data;

    // ── Agent mode: full autonomous pipeline ──
    if (repoUrl.startsWith("agent://") || job.data.agentConfig) {
      console.log(`[worker] Agent mode for job ${auditJobId}`);
      try {
        await handleAgentJob(job.data, async (stage, pct) => {
          await job.updateProgress(pct);
        });
      } catch (agentErr: any) {
        const truncated = truncateError(agentErr);
        console.error(`[worker] agent job ${auditJobId} failed:`, truncated);
        await prisma.auditJob.update({
          where: { id: auditJobId },
          data: { status: "FAILED", finishedAt: new Date(), error: truncated },
        });
        throw new Error(truncated);
      }
      return;
    }

    // ── Standard audit mode ──
    const jobDir = path.join(STORAGE_DIR, "jobs", auditJobId);
    const repoDir = path.join(jobDir, "repo");

    try {
      await prisma.auditJob.update({
        where: { id: auditJobId },
        data: { status: "RUNNING", startedAt: new Date(), stageName: "fetching" },
      });

      mkdirSync(repoDir, { recursive: true });
      await updateProgress(auditJobId, "fetching", 2);

      if (repoSource === "url" && repoUrl) {
        cloneRepo(repoUrl, repoDir);
      } else {
        throw new Error(`Only Git URL source is supported. Got: ${repoSource}`);
      }

      const sizeBytes = getDirSizeRecursive(repoDir);
      if (sizeBytes > MAX_REPO_SIZE_MB * 1024 * 1024) {
        throw new Error(`Repository exceeds ${MAX_REPO_SIZE_MB}MB size limit.`);
      }

      const result = await runPipeline({
        repoPath: repoDir,
        mode: mode as "SCAN" | "PROVE" | "FIX_PLAN",
        onProgress: async (stage: string, pct: number) => {
          await updateProgress(auditJobId, stage, pct);
          await job.updateProgress(pct);
        },
      });

      // ── Store findings in DB ──
      await updateProgress(auditJobId, "storing_results", 96);

      for (const finding of result.findings) {
        await prisma.finding.create({
          data: {
            auditJobId,
            severity: finding.severity,
            classId: finding.classId,
            className: finding.className,
            title: finding.title,
            location: finding.location as any,
            confidence: finding.confidence,
            hypothesis: finding.hypothesis || undefined,
            proofStatus: finding.proofPlan ? "PLANNED" : "PENDING",
            proofPlan: finding.proofPlan as any || undefined,
            fixPlan: finding.fixPlan as any || undefined,
            blastRadius: finding.blastRadius as any || undefined,
          },
        });
      }

      // ── Upload artifacts to R2 ──
      await updateProgress(auditJobId, "uploading_artifacts", 97);

      const mdResult = await storage.putArtifact(
        auditJobId, "report.md", result.reportMarkdown, "text/markdown"
      );
      await prisma.artifact.create({
        data: {
          auditJobId, type: "REPORT", name: "report.md",
          objectKey: mdResult.objectKey, contentType: "text/markdown",
          metadata: {}, sizeBytes: mdResult.sizeBytes,
        },
      });

      const jsonBody = JSON.stringify(result.reportJson, null, 2);
      const jsonResult = await storage.putArtifact(
        auditJobId, "report.json", jsonBody, "application/json"
      );
      await prisma.artifact.create({
        data: {
          auditJobId, type: "REPORT", name: "report.json",
          objectKey: jsonResult.objectKey, contentType: "application/json",
          metadata: {}, sizeBytes: jsonResult.sizeBytes,
        },
      });

      for (const graph of result.graphs) {
        const slug = graph.name.toLowerCase().replace(/\s+/g, "-");
        const graphBody = JSON.stringify(graph, null, 2);
        const graphResult = await storage.putArtifact(
          auditJobId, `graph-${slug}.json`, graphBody, "application/json"
        );
        await prisma.artifact.create({
          data: {
            auditJobId, type: "GRAPH", name: graph.name,
            objectKey: graphResult.objectKey, contentType: "application/json",
            metadata: { nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
            sizeBytes: graphResult.sizeBytes,
          },
        });
      }

      // ── Mark complete ──
      await prisma.auditJob.update({
        where: { id: auditJobId },
        data: {
          status: "SUCCEEDED", finishedAt: new Date(),
          progress: 100, stageName: "complete",
          summary: result.summary as any,
        },
      });

      console.log(`[worker] audit ${auditJobId} completed: ${result.findings.length} findings`);
    } catch (err: any) {
      const truncated = truncateError(err);
      console.error(`[worker] audit ${auditJobId} failed:`, truncated);
      await prisma.auditJob.update({
        where: { id: auditJobId },
        data: { status: "FAILED", finishedAt: new Date(), error: truncated },
      });
      // Re-throw truncated so BullMQ failedReason stays small
      throw new Error(truncated);
    } finally {
      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  },
  {
    connection: redis,
    concurrency: 2,
    limiter: { max: 4, duration: 60_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
    lockDuration: 600_000,
    lockRenewTime: 30_000,
  }
);

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("[worker] worker error:", err);
});

async function updateProgress(auditJobId: string, stage: string, pct: number) {
  await prisma.auditJob.update({
    where: { id: auditJobId },
    data: { progress: Math.min(pct, 100), stageName: stage },
  });
}

function cloneRepo(url: string, dest: string): void {
  if (!/^https:\/\//i.test(url)) {
    throw new Error("Only HTTPS repository URLs are supported.");
  }
  try { new URL(url); } catch { throw new Error("Invalid repository URL."); }

  const githubToken = process.env.GITHUB_TOKEN;
  let cloneUrl = url;
  if (githubToken && url.includes("github.com")) {
    cloneUrl = url.replace("https://", `https://${githubToken}@`);
  }

  try {
    execSync(
      `git clone --depth=1 --single-branch -- ${JSON.stringify(cloneUrl)} ${JSON.stringify(dest)}`,
      { timeout: CLONE_TIMEOUT_MS, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
    );
  } catch (err: any) {
    if (err.killed) throw new Error("Repository clone timed out.");
    const msg = (err.stderr?.toString() || err.message || "").replace(/https:\/\/[^@]+@/g, "https://***@");
    throw new Error(`Failed to clone repository: ${msg}`);
  }
}

function getDirSizeRecursive(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirSizeRecursive(full);
    } else {
      try { total += statSync(full).size; } catch {}
    }
  }
  return total;
}

process.on("SIGTERM", async () => {
  console.log("[worker] shutting down...");
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[worker] shutting down...");
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

console.log("[worker] ready, waiting for jobs...");