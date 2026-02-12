import { Worker, Job } from "bullmq";
import { execSync, exec } from "child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from "fs";
import path from "path";
import { prisma } from "@solaudit/db";
import { AUDIT_QUEUE_NAME, createRedisConnection, type AuditJobData } from "@solaudit/queue";
import { runPipeline } from "@solaudit/engine";

const STORAGE_DIR = process.env.STORAGE_DIR || "/tmp/solaudit-storage";
const WORKER_ENABLE_PROVE = process.env.WORKER_ENABLE_PROVE === "true";
const MAX_REPO_SIZE_MB = 200;
const CLONE_TIMEOUT_MS = 60_000;
const PIPELINE_TIMEOUT_MS = 300_000;

if (!existsSync(STORAGE_DIR)) {
  mkdirSync(STORAGE_DIR, { recursive: true });
}

console.log("[worker] starting solaudit worker...");
console.log(`[worker] storage: ${STORAGE_DIR}`);
console.log(`[worker] prove mode: ${WORKER_ENABLE_PROVE ? "enabled" : "disabled"}`);

const redis = createRedisConnection();

const worker = new Worker<AuditJobData>(
  AUDIT_QUEUE_NAME,
  async (job: Job<AuditJobData>) => {
    const { auditJobId, repoUrl, repoSource, mode } = job.data;
    const jobDir = path.join(STORAGE_DIR, "jobs", auditJobId);
    const repoDir = path.join(jobDir, "repo");
    const artifactsDir = path.join(jobDir, "artifacts");

    try {
      // Mark as running
      await prisma.auditJob.update({
        where: { id: auditJobId },
        data: { status: "RUNNING", startedAt: new Date(), stageName: "fetching" },
      });

      mkdirSync(repoDir, { recursive: true });
      mkdirSync(artifactsDir, { recursive: true });

      // ── Stage: Fetch repo ──
      await updateProgress(auditJobId, "fetching", 2);

      if (repoSource === "url" && repoUrl) {
        await cloneRepo(repoUrl, repoDir);
      } else if (repoSource === "upload") {
        // Upload stored in STORAGE_DIR/uploads/<auditJobId>.zip
        const zipPath = path.join(STORAGE_DIR, "uploads", `${auditJobId}.zip`);
        if (!existsSync(zipPath)) {
          throw new Error("Upload zip not found. Please re-upload.");
        }
        execSync(`unzip -o -q "${zipPath}" -d "${repoDir}"`, { timeout: 30_000 });
        // If zip contains a single top-level directory, move contents up
        const entries = readdirSync(repoDir);
        if (entries.length === 1) {
          const singleDir = path.join(repoDir, entries[0]);
          if (statSync(singleDir).isDirectory()) {
            execSync(`mv "${singleDir}"/* "${repoDir}"/ 2>/dev/null || true`, { shell: "/bin/bash" });
            rmSync(singleDir, { recursive: true, force: true });
          }
        }
      } else {
        throw new Error(`Invalid repo source: ${repoSource}`);
      }

      // Validate repo size
      const sizeBytes = getDirSize(repoDir);
      if (sizeBytes > MAX_REPO_SIZE_MB * 1024 * 1024) {
        throw new Error(`Repository exceeds ${MAX_REPO_SIZE_MB}MB size limit.`);
      }

      // ── Run audit pipeline ──
      const result = await runPipeline({
        repoPath: repoDir,
        mode: mode as "SCAN" | "PROVE" | "FIX_PLAN",
        onProgress: async (stage: string, pct: number) => {
          await updateProgress(auditJobId, stage, pct);
          await job.updateProgress(pct);
        },
      });

      // ── Store findings ──
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
            hypothesis: finding.hypothesis || null,
            proofStatus: finding.proofPlan ? "PLANNED" : "PENDING",
            proofPlan: finding.proofPlan as any || null,
            proofArtifacts: null,
            fixPlan: finding.fixPlan as any || null,
            blastRadius: finding.blastRadius as any || null,
          },
        });
      }

      // ── Store artifacts ──
      const mdReportPath = path.join(artifactsDir, "report.md");
      writeFileSync(mdReportPath, result.reportMarkdown, "utf-8");

      const jsonReportPath = path.join(artifactsDir, "report.json");
      writeFileSync(jsonReportPath, JSON.stringify(result.reportJson, null, 2), "utf-8");

      await prisma.artifact.create({
        data: {
          auditJobId,
          type: "REPORT",
          name: "report.md",
          path: mdReportPath,
          metadata: {},
          sizeBytes: Buffer.byteLength(result.reportMarkdown),
        },
      });

      await prisma.artifact.create({
        data: {
          auditJobId,
          type: "REPORT",
          name: "report.json",
          path: jsonReportPath,
          metadata: {},
          sizeBytes: Buffer.byteLength(JSON.stringify(result.reportJson)),
        },
      });

      // Store graph data as artifacts
      for (const graph of result.graphs) {
        const graphPath = path.join(artifactsDir, `graph-${graph.name.toLowerCase().replace(/\s+/g, "-")}.json`);
        const graphJson = JSON.stringify(graph, null, 2);
        writeFileSync(graphPath, graphJson, "utf-8");

        await prisma.artifact.create({
          data: {
            auditJobId,
            type: "GRAPH",
            name: graph.name,
            path: graphPath,
            metadata: {
              nodeCount: graph.nodes.length,
              edgeCount: graph.edges.length,
              nodes: graph.nodes,
              edges: graph.edges,
            },
            sizeBytes: Buffer.byteLength(graphJson),
          },
        });
      }

      // ── Store summary ──
      const summaryJson = JSON.stringify(result.summary);
      await prisma.auditJob.update({
        where: { id: auditJobId },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          progress: 100,
          stageName: "complete",
          summary: result.summary as any,
        },
      });

      console.log(`[worker] audit ${auditJobId} completed: ${result.findings.length} findings`);
    } catch (err: any) {
      console.error(`[worker] audit ${auditJobId} failed:`, err.message);
      await prisma.auditJob.update({
        where: { id: auditJobId },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: err.message || "Unknown error",
        },
      });
      throw err;
    } finally {
      // Cleanup cloned repo (keep artifacts)
      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  },
  {
    connection: redis,
    concurrency: 2,
    limiter: { max: 4, duration: 60_000 },
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

// ── Helpers ──

async function updateProgress(auditJobId: string, stage: string, pct: number) {
  await prisma.auditJob.update({
    where: { id: auditJobId },
    data: { progress: Math.min(pct, 100), stageName: stage },
  });
}

function cloneRepo(url: string, dest: string): void {
  // Validate URL to prevent command injection
  const sanitized = url.replace(/[^a-zA-Z0-9\-._~:/?#\[\]@!$&'()*+,;=%]/g, "");
  if (sanitized !== url) {
    throw new Error("Invalid characters in repository URL.");
  }

  // Block non-http(s) protocols
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only HTTP(S) repository URLs are supported.");
  }

  const githubToken = process.env.GITHUB_TOKEN;
  let cloneUrl = url;
  if (githubToken && url.includes("github.com")) {
    cloneUrl = url.replace("https://", `https://${githubToken}@`);
  }

  try {
    execSync(
      `git clone --depth=1 --single-branch "${cloneUrl}" "${dest}"`,
      {
        timeout: CLONE_TIMEOUT_MS,
        stdio: "pipe",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    );
  } catch (err: any) {
    if (err.killed) {
      throw new Error("Repository clone timed out.");
    }
    throw new Error(`Failed to clone repository: ${err.stderr?.toString() || err.message}`);
  }
}

function getDirSize(dir: string): number {
  try {
    const output = execSync(`du -sb "${dir}" | cut -f1`, { encoding: "utf-8" });
    return parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// Graceful shutdown
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
