import { Queue, Worker, Job, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";

// ── Redis Connection ──
export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new IORedis(url, { maxRetriesPerRequest: null });
}

// ── Job Schemas ──
export const AuditJobDataSchema = z.object({
  auditJobId: z.string(),
  mode: z.enum(["SCAN", "PROVE", "FIX_PLAN"]),
  repoSource: z.enum(["url", "upload", "agent"]),
  repoUrl: z.string().optional(),
  uploadPath: z.string().optional(),
  agentConfig: z.any().optional(),
});

export type AuditJobData = z.infer<typeof AuditJobDataSchema>;

export const AUDIT_QUEUE_NAME = "audit-jobs";

// ── Queue Factory ──
export function createAuditQueue(connection: IORedis): Queue<AuditJobData> {
  return new Queue<AuditJobData>(AUDIT_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
      attempts: 1, // audits should not auto-retry
    },
  });
}

// ── Worker Factory ──
export function createAuditWorker(
  connection: IORedis,
  processor: (job: Job<AuditJobData>) => Promise<void>
): Worker<AuditJobData> {
  return new Worker<AuditJobData>(AUDIT_QUEUE_NAME, processor, {
    connection,
    concurrency: 2,
    limiter: { max: 4, duration: 60_000 },
  });
}

// ── Queue Events ──
export function createQueueEvents(connection: IORedis): QueueEvents {
  return new QueueEvents(AUDIT_QUEUE_NAME, { connection });
}

// ── Health Check ──
export async function getQueueHealth(
  queue: Queue
): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

export { Queue, Worker, Job, QueueEvents } from "bullmq";
export type { IORedis };
