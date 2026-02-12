import { NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.API_KEY ?? "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Fail closed: in production, if API_KEY is not set, reject everything
if (IS_PRODUCTION && (!API_KEY || API_KEY.length < 16)) {
  console.error("[FATAL] API_KEY is missing or too short in production. All requests will be rejected.");
}

export function validateApiKey(request: NextRequest): NextResponse | null {
  // In production: fail closed — no valid key means deny all
  if (IS_PRODUCTION && (!API_KEY || API_KEY.length < 16)) {
    return NextResponse.json(
      { error: "Server misconfigured: API key not set" },
      { status: 500 }
    );
  }

  // In dev: skip auth if key not configured
  if (!IS_PRODUCTION && !API_KEY) {
    return null;
  }

  // Header-only auth — no query param
  const provided = request.headers.get("x-api-key") ?? "";

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
