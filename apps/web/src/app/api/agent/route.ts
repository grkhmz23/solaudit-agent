import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@solaudit/db";

// POST /api/agent - Start an agent run
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-api-key");
  const expected = process.env.API_KEY;
  if (expected && apiKey !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { mode, repos, minStars, maxRepos, submitPRs } = body;

    if (mode === "discover") {
      const job = await prisma.auditJob.create({
        data: {
          repoUrl: "agent://discover",
          repoSource: "agent",
          mode: "FIX_PLAN",
          status: "QUEUED",
          progress: 0,
          stageName: "queued",
        },
      });

      return NextResponse.json({ jobId: job.id, status: "queued" });
    }

    if (mode === "audit" && repos?.length > 0) {
      const jobs: any[] = [];
      for (const repoUrl of repos.slice(0, 10)) {
        const job = await prisma.auditJob.create({
          data: {
            repoUrl,
            repoSource: "url",
            mode: "FIX_PLAN",
            status: "QUEUED",
            progress: 0,
            stageName: "queued",
          },
        });
        jobs.push({ jobId: job.id, repoUrl });
      }

      return NextResponse.json({ jobs, status: "queued" });
    }

    return NextResponse.json(
      { error: "Invalid mode. Use 'discover' or 'audit' with repos[]." },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/agent - Get agent run status
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("x-api-key");
  const expected = process.env.API_KEY;
  if (expected && apiKey !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const agentJobs = await prisma.auditJob.findMany({
      where: {
        OR: [{ repoSource: "agent" }, { mode: "FIX_PLAN" }],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return NextResponse.json({ jobs: agentJobs });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
