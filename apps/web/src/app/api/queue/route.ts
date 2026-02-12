import { NextRequest, NextResponse } from "next/server";
import { validateApiKey, errorResponse } from "@/lib/api-key";
import { getQueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    const queue = getQueue();
    const counts = await queue.getJobCounts();
    const isPaused = await queue.isPaused();

    return NextResponse.json({
      name: queue.name,
      counts,
      isPaused,
    });
  } catch (err: unknown) {
    console.error("GET /api/queue error:", err);
    return errorResponse("Failed to fetch queue status", 500);
  }
}
