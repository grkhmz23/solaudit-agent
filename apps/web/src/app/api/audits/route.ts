import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { validateApiKey, errorResponse } from "@/lib/api-key";
import { enqueueAudit } from "@/lib/queue";
import crypto from "crypto";

const CreateAuditSchema = z.object({
  repoUrl: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          const url = new URL(u);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.hostname.match(/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i)
          );
        } catch {
          return false;
        }
      },
      { message: "Invalid or private URL (SSRF protection)" }
    )
    .optional(),
  uploadPath: z.string().max(500).optional(),
  mode: z.enum(["SCAN", "PROVE", "FIX_PLAN"]).default("SCAN"),
});

export async function GET(request: NextRequest) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    const page = parseInt(request.nextUrl.searchParams.get("page") ?? "1");
    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get("limit") ?? "20"),
      100
    );
    const skip = (page - 1) * limit;

    const [audits, total] = await Promise.all([
      prisma.auditJob.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          findings: { select: { id: true, severity: true, title: true, classId: true } },
          _count: { select: { findings: true, artifacts: true } },
        },
      }),
      prisma.auditJob.count(),
    ]);

    return NextResponse.json({ audits, total, page, limit });
  } catch (err: unknown) {
    console.error("GET /api/audits error:", err);
    return errorResponse("Failed to fetch audits", 500);
  }
}

export async function POST(request: NextRequest) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    const body = await request.json();
    const parsed = CreateAuditSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(parsed.error.issues.map((i) => i.message).join(", "), 400);
    }

    const { repoUrl, uploadPath, mode } = parsed.data;

    if (!repoUrl && !uploadPath) {
      return errorResponse("Either repoUrl or uploadPath is required", 400);
    }

    const id = crypto.randomUUID();
    const repoSource = repoUrl ? "url" : "upload";

    const audit = await prisma.auditJob.create({
      data: {
        id,
        status: "QUEUED",
        mode,
        repoSource,
        repoUrl: repoUrl ?? uploadPath ?? "",
        repoMeta: {},
      },
    });

    await enqueueAudit({
      auditJobId: id,
      mode,
      repoSource: repoSource as "url" | "upload",
      repoUrl,
      uploadPath,
    });

    return NextResponse.json({ audit }, { status: 201 });
  } catch (err: unknown) {
    console.error("POST /api/audits error:", err);
    return errorResponse("Failed to create audit", 500);
  }
}
