import { NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.API_KEY ?? "";

export function validateApiKey(request: NextRequest): NextResponse | null {
  // Skip API key check if not configured (dev mode)
  if (!API_KEY || API_KEY === "change-me-to-a-secure-random-string") {
    return null;
  }

  const provided =
    request.headers.get("x-api-key") ??
    request.nextUrl.searchParams.get("api_key") ??
    "";

  if (provided !== API_KEY) {
    return NextResponse.json(
      { error: "Unauthorized: invalid or missing API key" },
      { status: 401 }
    );
  }

  return null;
}

export function errorResponse(message: string, status: number = 400) {
  return NextResponse.json({ error: message }, { status });
}
