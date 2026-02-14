import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateApiKey, errorResponse } from "@/lib/api-key";
import { getStorage } from "@solaudit/storage";

/**
 * GET /api/audits/[id]/submission
 *
 * Returns submission-ready URLs for a completed audit:
 *   - prUrl: the PR link to the target repo (the fix)
 *   - writeupUrl: the writeup doc link (findings + impact + proof)
 *
 * These two URLs are what\'s required for the "Audit & Fix" bounty submission.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    const job = await prisma.auditJob.findUnique({
      where: { id: params.id },
      include: {
        artifacts: {
          where: {
            OR: [
              { metadata: { path: ["purpose"], equals: "bounty_submission" } },
              { type: "ADVISORY" },
              { name: { contains: "submission" } },
            ],
          },
        },
        findings: {
          orderBy: { severity: "asc" },
        },
      },
    });

    if (!job) {
      return errorResponse("Audit not found", 404);
    }

    if (job.status !== "SUCCEEDED") {
      return NextResponse.json(
        {
          ready: false,
          status: job.status,
          error: `Audit is ${job.status} — must be SUCCEEDED to submit`,
        },
        { status: 400 }
      );
    }

    const summary = job.summary as any;

    // Extract URLs from the run summaries
    let prUrl: string | null = null;
    let writeupUrl: string | null = null;

    if (summary?.runs) {
      for (const run of summary.runs) {
        if (run.prUrl) prUrl = run.prUrl;
        if (run.writeupUrl) writeupUrl = run.writeupUrl;
      }
    }

    // Fallback: get writeup from R2 signed URL
    let writeupR2Url: string | null = null;
    const writeupArtifact = job.artifacts.find(
      (a) =>
        a.name.includes("submission") ||
        (a.metadata as any)?.purpose === "bounty_submission"
    );

    if (writeupArtifact) {
      try {
        const storage = getStorage();
        writeupR2Url = await storage.getSignedUrl(writeupArtifact.objectKey, 86400);
      } catch {}
    }

    const ready = !!prUrl && !!(writeupUrl || writeupR2Url);
    const findingsSummary = job.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      classId: f.classId,
      className: f.className,
      confidence: f.confidence,
      proofStatus: f.proofStatus,
    }));

    return NextResponse.json({
      ready,
      auditId: job.id,
      repoUrl: job.repoUrl,
      status: job.status,
      prUrl,
      writeupUrl: writeupUrl || writeupR2Url,
      writeupGistUrl: writeupUrl,
      writeupR2Url,
      findings: findingsSummary,
      findingsCount: job.findings.length,
      message: ready
        ? "Submission ready. Use prUrl and writeupUrl for the bounty API call."
        : `Missing: ${!prUrl ? "PR link" : ""}${!prUrl && !(writeupUrl || writeupR2Url) ? " + " : ""}${!(writeupUrl || writeupR2Url) ? "writeup link" : ""}`,
    });
  } catch (err: any) {
    console.error("GET /api/audits/[id]/submission error:", err);
    return errorResponse("Failed to get submission info", 500);
  }
}
