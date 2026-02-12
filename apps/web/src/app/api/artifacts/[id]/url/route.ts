import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateApiKey, errorResponse } from "@/lib/api-key";
import { getStorage } from "@solaudit/storage";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authErr = validateApiKey(request);
  if (authErr) return authErr;

  try {
    const artifact = await prisma.artifact.findUnique({
      where: { id: params.id },
    });

    if (!artifact) {
      return errorResponse("Artifact not found", 404);
    }

    const storage = getStorage();
    const url = await storage.getSignedUrl(artifact.objectKey, 3600);

    return NextResponse.json({
      url,
      name: artifact.name,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
    });
  } catch (err: unknown) {
    console.error("GET /api/artifacts/[id]/url error:", err);
    return errorResponse("Failed to generate download URL", 500);
  }
}
