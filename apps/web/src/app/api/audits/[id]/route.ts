import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateApiKey, errorResponse } from "@/lib/api-key";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    const audit = await prisma.auditJob.findUnique({
      where: { id: params.id },
      include: {
        findings: { orderBy: { severity: "asc" } },
        artifacts: {
          orderBy: { type: "asc" },
          select: {
            id: true,
            type: true,
            name: true,
            contentType: true,
            metadata: true,
            sizeBytes: true,
            createdAt: true,
          },
        },
      },
    });

    if (!audit) {
      return errorResponse("Audit not found", 404);
    }

    return NextResponse.json({ audit });
  } catch (err: unknown) {
    console.error("GET /api/audits/[id] error:", err);
    return errorResponse("Failed to fetch audit", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    await prisma.finding.deleteMany({ where: { auditJobId: params.id } });
    await prisma.artifact.deleteMany({ where: { auditJobId: params.id } });
    await prisma.auditJob.delete({ where: { id: params.id } });
    return NextResponse.json({ deleted: true });
  } catch (err: unknown) {
    console.error("DELETE /api/audits/[id] error:", err);
    return errorResponse("Failed to delete audit", 500);
  }
}
