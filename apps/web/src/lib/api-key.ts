import { NextRequest, NextResponse } from "next/server";

function getApiKeyConfig() {
  const key = process.env.API_KEY ?? "";
  const isProd = process.env.NODE_ENV === "production";
  return { key, isProd };
}

export function validateApiKey(request: NextRequest): NextResponse | null {
  const { key: API_KEY, isProd: IS_PRODUCTION } = getApiKeyConfig();

  if (IS_PRODUCTION && (!API_KEY || API_KEY.length < 16)) {
    return NextResponse.json(
      { error: "Server misconfigured: API key not set" },
      { status: 500 }
    );
  }

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
