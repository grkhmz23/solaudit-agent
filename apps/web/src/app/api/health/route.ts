import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getQueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  try {
    const queue = getQueue();
    const counts = await queue.getJobCounts();
    checks.redis = "ok";
    checks.queueWaiting = String(counts.waiting ?? 0);
    checks.queueActive = String(counts.active ?? 0);
    checks.queueCompleted = String(counts.completed ?? 0);
    checks.queueFailed = String(counts.failed ?? 0);
  } catch {
    checks.redis = "error";
  }

  const allOk = checks.database === "ok" && checks.redis === "ok";

  return NextResponse.json(
    { status: allOk ? "healthy" : "degraded", checks },
    { status: allOk ? 200 : 503 }
  );
}
