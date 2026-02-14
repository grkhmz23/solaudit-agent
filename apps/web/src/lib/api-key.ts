import { NextRequest, NextResponse } from "next/server";

/**
 * Public mode: If API_KEY env var is not set, all requests are allowed.
 * Protected mode: If API_KEY is set, requests must include x-api-key header.
 * Set API_KEY in Replit Secrets to enable authentication (for paid plans).
 */
export function validateApiKey(request: NextRequest): NextResponse | null {
  const API_KEY = process.env.API_KEY ?? "";
  if (!API_KEY) return null;
  const provided = request.headers.get("x-api-key") ?? "";
  if (provided !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized: invalid or missing API key" }, { status: 401 });
  }
  return null;
}

export function errorResponse(message: string, status: number = 400) {
  return NextResponse.json({ error: message }, { status });
}
