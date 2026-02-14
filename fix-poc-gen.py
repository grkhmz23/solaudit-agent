#!/usr/bin/env python3
"""Fix PoC generator: route through Kimi Code API, retry 400, sequential with delay."""

def replace_in(path, old, new):
    content = open(path).read()
    if old not in content:
        print(f"  ⚠ Pattern not found in {path}")
        return False
    content = content.replace(old, new, 1)
    open(path, 'w').write(content)
    print(f"  ✅ {path}")
    return True

F = "packages/engine/src/proof/llm-poc-generator.ts"

print("1. Replace config section (Kimi Code API + lower concurrency)...")
replace_in(F,
'''// ─── Config ─────────────────────────────────────────────────

const MOONSHOT_API_URL = "https://api.moonshot.ai/v1/chat/completions";
const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL || "kimi-k2.5";

const POC_CFG = {
  maxTokens: int("LLM_POC_MAX_TOKENS", 8192),
  timeoutMs: int("LLM_POC_TIMEOUT_MS", 120_000),
  retries: int("LLM_POC_RETRIES", 2),
  concurrency: int("LLM_POC_CONCURRENCY", 3),
  maxPocs: int("LLM_POC_MAX", 10),
};

function int(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function getApiKey(): string | null {
  return process.env.MOONSHOT_API_KEY || null;
}''',
'''// ─── Config ─────────────────────────────────────────────────

// Prefer Kimi Code API (separate rate-limit pool from analyzer's Moonshot).
// Falls back to Moonshot if KIMI_CODE_API_KEY is not set.

function getPocApiUrl(): string {
  if (process.env.KIMI_CODE_API_KEY) {
    return "https://api.kimi.com/coding/v1/chat/completions";
  }
  return "https://api.moonshot.ai/v1/chat/completions";
}

function getPocApiKey(): string | null {
  return process.env.KIMI_CODE_API_KEY || process.env.MOONSHOT_API_KEY || null;
}

function getPocModel(): string {
  return process.env.KIMI_PATCH_MODEL || process.env.MOONSHOT_MODEL || "kimi-k2.5";
}

const POC_CFG = {
  maxTokens: int("LLM_POC_MAX_TOKENS", 8192),
  timeoutMs: int("LLM_POC_TIMEOUT_MS", 120_000),
  retries: int("LLM_POC_RETRIES", 2),
  concurrency: int("LLM_POC_CONCURRENCY", 1), // sequential: avoids rate-limit storms
  maxPocs: int("LLM_POC_MAX", 10),
  interRequestDelayMs: int("LLM_POC_DELAY_MS", 2000), // cooldown between calls
};

function int(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}''')

print("\n2. Replace callLLM function (Kimi Code API + retry 400)...")
replace_in(F,
'''async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("MOONSHOT_API_KEY not set");

  for (let attempt = 0; attempt <= POC_CFG.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POC_CFG.timeoutMs);

    try {
      const res = await fetch(MOONSHOT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MOONSHOT_MODEL,
          max_tokens: POC_CFG.maxTokens,
          temperature: 1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        const delay = 1500 * Math.pow(2, attempt);
        console.warn(`[poc-gen] ${res.status}, retry in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Moonshot ${res.status}: ${body}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        if (attempt < POC_CFG.retries) {
          await sleep(1000);
          continue;
        }
        throw new Error("Empty response after retries");
      }
      return content;''',
'''async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = getPocApiKey();
  if (!apiKey) throw new Error("KIMI_CODE_API_KEY or MOONSHOT_API_KEY not set");

  const apiUrl = getPocApiUrl();
  const model = getPocModel();
  const apiName = process.env.KIMI_CODE_API_KEY ? "Kimi Code" : "Moonshot";

  for (let attempt = 0; attempt <= POC_CFG.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POC_CFG.timeoutMs);

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: POC_CFG.maxTokens,
          temperature: 1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // Retry on 429, 5xx, AND 400 (Moonshot sends 400 for rate-limits
      // with misleading "invalid temperature" errors)
      if (res.status === 429 || res.status >= 500 || res.status === 400) {
        const body = await res.text().catch(() => "");
        const delay = 3000 * Math.pow(2, attempt);
        console.warn(`[poc-gen] ${apiName} ${res.status}, retry ${attempt + 1}/${POC_CFG.retries + 1} in ${delay}ms`);
        if (attempt < POC_CFG.retries) {
          await sleep(delay);
          continue;
        }
        throw new Error(`${apiName} ${res.status}: ${body.slice(0, 300)}`);
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${apiName} ${res.status}: ${body}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        if (attempt < POC_CFG.retries) {
          await sleep(1000);
          continue;
        }
        throw new Error("Empty response after retries");
      }
      return content;''')

print("\n3. Fix getApiKey reference in main function...")
replace_in(F,
    "  const apiKey = getApiKey();",
    "  const apiKey = getPocApiKey();")

print("\n4. Add inter-request delay to dispatch loop...")
replace_in(F,
'''  // LLM-powered generation with concurrency limit
  const limit = pLimit(POC_CFG.concurrency);

  const results = await Promise.all(
    toProcess.map((finding) =>
      limit(async () => {
        const enriched = enrichedFindings?.find(
          (e) => e.title === finding.title || e.title.includes(finding.className)
        );
        const patch = patches?.find((p) => p.file === finding.location.file);
        return generateSinglePoC(finding, program, enriched, patch);
      })
    )
  );''',
'''  // LLM-powered generation — sequential with cooldown to avoid rate-limits
  const usingApi = process.env.KIMI_CODE_API_KEY ? "Kimi Code" : "Moonshot";
  console.log(`[poc-gen] Generating via ${usingApi} API (concurrency: ${POC_CFG.concurrency}, delay: ${POC_CFG.interRequestDelayMs}ms)`);
  const limit = pLimit(POC_CFG.concurrency);

  const results = await Promise.all(
    toProcess.map((finding, idx) =>
      limit(async () => {
        // Inter-request cooldown to avoid rate-limit storms
        if (idx > 0) await sleep(POC_CFG.interRequestDelayMs);
        const enriched = enrichedFindings?.find(
          (e) => e.title === finding.title || e.title.includes(finding.className)
        );
        const patch = patches?.find((p) => p.file === finding.location.file);
        return generateSinglePoC(finding, program, enriched, patch);
      })
    )
  );''')

print("\n✅ Done! PoC gen now uses Kimi Code API with sequential execution + retry on 400")
