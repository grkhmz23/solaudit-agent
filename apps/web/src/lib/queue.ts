import { createRedisConnection, createAuditQueue, type AuditJobData } from "@solaudit/queue";

let queueSingleton: ReturnType<typeof createAuditQueue> | null = null;

export function getQueue() {
  if (!queueSingleton) {
    const redis = createRedisConnection();
    queueSingleton = createAuditQueue(redis);
  }
  return queueSingleton;
}

export async function enqueueAudit(data: AuditJobData): Promise<string> {
  const queue = getQueue();
  const job = await queue.add("audit", data, {
    jobId: data.auditJobId,
  });
  return job.id ?? data.auditJobId;
}
