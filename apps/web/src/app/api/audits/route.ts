import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { validateApiKey, errorResponse } from "@/lib/api-key";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueueAudit } from "@/lib/queue";
import crypto from "crypto";

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[::1\]|\[fc|\[fd|\[fe80)/i;

const CreateAuditSchema = z.object({
  repoUrl: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          const url = new URL(u);
          // HTTPS only
          if (url.protocol !== "https:") return false;
          // Block private/loopback/link-local
          if (BLOCKED_HOSTS.test(url.hostname)) return false;
          // Block bare IPs (simple heuristic)
          if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname)) return false;
          return true;
        } catch {
          return false;
        }
      },
      { message: "Only public HTTPS URLs are allowed (SSRF protection)" }
    ),
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

  // Rate limit: 5 audits per hour per IP in public mode
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    const retryAfter = Math.ceil((limit.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${Math.ceil(retryAfter / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const body = await request.json();
    const parsed = CreateAuditSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(parsed.error.issues.map((i) => i.message).join(", "), 400);
    }

    const { repoUrl, mode } = parsed.data;
    const id = crypto.randomUUID();

    const audit = await prisma.auditJob.create({
      data: {
        id,
        status: "QUEUED",
        mode,
        repoSource: "url",
        repoUrl,
        repoMeta: {},
      },
    });

    await enqueueAudit({
      auditJobId: id,
      mode,
      repoSource: "url",
      repoUrl,
    });

    return NextResponse.json({ audit }, { status: 201 });
  } catch (err: unknown) {
    console.error("POST /api/audits error:", err);
    return errorResponse("Failed to create audit", 500);
  }
}
