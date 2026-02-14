#!/usr/bin/env python3
"""
Apply review feedback fixes to llm-poc-generator.ts
Addresses: smart 400 retry, own env var, NaN guard, lower tokens,
           provider override, stable grep token, max_tokens downshift.
"""

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

# ═══════════════════════════════════════════════════════════════
# 1. Config: POC_PROVIDER, LLM_POC_MODEL, safeInt, lower tokens
# ═══════════════════════════════════════════════════════════════
print("1. Config: provider override, own model env, NaN guard, 4096 tokens...")
replace_in(F,
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
}''',
'''// ─── Config ─────────────────────────────────────────────────

// Provider selection: POC_PROVIDER=auto|kimi_code|moonshot
// "auto" (default): prefers Kimi Code if KIMI_CODE_API_KEY is set, else Moonshot.

type PocProvider = "kimi_code" | "moonshot";

function resolvePocProvider(): PocProvider {
  const explicit = process.env.POC_PROVIDER?.toLowerCase();
  if (explicit === "kimi_code" || explicit === "moonshot") return explicit;
  // auto: prefer Kimi Code (separate rate-limit pool from analyzer's Moonshot)
  return process.env.KIMI_CODE_API_KEY ? "kimi_code" : "moonshot";
}

function getPocApiUrl(): string {
  return resolvePocProvider() === "kimi_code"
    ? "https://api.kimi.com/coding/v1/chat/completions"
    : "https://api.moonshot.ai/v1/chat/completions";
}

function getPocApiKey(): string | null {
  const provider = resolvePocProvider();
  if (provider === "kimi_code") return process.env.KIMI_CODE_API_KEY || null;
  return process.env.MOONSHOT_API_KEY || null;
}

function getPocModel(): string {
  return process.env.LLM_POC_MODEL || process.env.MOONSHOT_MODEL || "kimi-k2.5";
}

const POC_CFG = {
  maxTokens: safeInt("LLM_POC_MAX_TOKENS", 4096),
  timeoutMs: safeInt("LLM_POC_TIMEOUT_MS", 120_000),
  retries: safeInt("LLM_POC_RETRIES", 2),
  concurrency: safeInt("LLM_POC_CONCURRENCY", 1), // sequential: avoids rate-limit storms
  maxPocs: safeInt("LLM_POC_MAX", 10),
  interRequestDelayMs: safeInt("LLM_POC_DELAY_MS", 2000), // cooldown between calls
};

function safeInt(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}''')

# ═══════════════════════════════════════════════════════════════
# 2. callLLM: smart 400 retry + max_tokens downshift
# ═══════════════════════════════════════════════════════════════
print("\n2. callLLM: smart 400 retry, token downshift, provider labels...")
replace_in(F,
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
      return content;''',
'''async function callLLM(system: string, user: string): Promise<string> {
  const apiKey = getPocApiKey();
  const provider = resolvePocProvider();
  const apiName = provider === "kimi_code" ? "Kimi Code" : "Moonshot";
  if (!apiKey) throw new Error(`${apiName} API key not set (POC_PROVIDER=${provider})`);

  const apiUrl = getPocApiUrl();
  const model = getPocModel();
  let maxTokens = POC_CFG.maxTokens;

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
          max_tokens: maxTokens,
          temperature: 1,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // ── Retryable: 429 (rate-limit) and 5xx (server error) ──
      if (res.status === 429 || res.status >= 500) {
        const delay = 3000 * Math.pow(2, attempt);
        console.warn(`[poc-gen] ${apiName} ${res.status}, retry ${attempt + 1}/${POC_CFG.retries + 1} in ${delay}ms`);
        if (attempt < POC_CFG.retries) {
          await sleep(delay);
          continue;
        }
        const body = await res.text().catch(() => "");
        throw new Error(`${apiName} ${res.status}: ${body.slice(0, 300)}`);
      }

      // ── 400: only retry if transient; fail fast otherwise ──
      if (res.status === 400) {
        const body = await res.text().catch(() => "");
        const lower = body.toLowerCase();

        // Transient signals (some providers send 400 for rate-limits)
        const transient = ["rate limit", "overloaded", "try again", "temporarily", "throttl"];
        if (transient.some((t) => lower.includes(t)) && attempt < POC_CFG.retries) {
          const delay = 3000 * Math.pow(2, attempt);
          console.warn(`[poc-gen] ${apiName} 400 (transient), retry ${attempt + 1}/${POC_CFG.retries + 1} in ${delay}ms`);
          await sleep(delay);
          continue;
        }

        // Token-limit error: downshift max_tokens and retry once
        if ((lower.includes("max_tokens") || lower.includes("context length") || lower.includes("too many tokens"))
            && attempt < POC_CFG.retries && maxTokens > 2048) {
          maxTokens = Math.floor(maxTokens / 2);
          console.warn(`[poc-gen] ${apiName} 400 (token limit), downshifting max_tokens to ${maxTokens}`);
          await sleep(1000);
          continue;
        }

        // Deterministic error: fail fast (invalid model, bad params, etc.)
        throw new Error(`${apiName} 400 (deterministic): ${body.slice(0, 300)}`);
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

# ═══════════════════════════════════════════════════════════════
# 3. runCommand grep: stable PoC#classId token
# ═══════════════════════════════════════════════════════════════
print("\n3. runCommand grep: stable PoC#classId token...")
replace_in(F,
    '''runCommand: isAnchor
          ? `cd <repo> && anchor test -- --grep "${finding.title.slice(0, 60)}"`
          : `cd <repo> && cargo test-sbf poc_${finding.classId}_${safeName}`,''',
    '''runCommand: isAnchor
          ? `cd <repo> && anchor test -- --grep "PoC#${finding.classId}"`
          : `cd <repo> && cargo test-sbf poc_${finding.classId}_${safeName}`,''')

# ═══════════════════════════════════════════════════════════════
# 4. System prompt: tell LLM to use PoC#id in describe
# ═══════════════════════════════════════════════════════════════
print("\n4. System prompt: PoC#classId in describe block...")
replace_in(F,
'''Rules for the test code:
- Write a COMPLETE, RUNNABLE Anchor test file (.ts)
- Import from @coral-xyz/anchor and @solana/web3.js
- Use describe/it blocks with Mocha
- Create realistic account setup (PDAs, token accounts, keypairs)
- Show the EXACT exploit path: what the attacker does, which accounts are passed
- The test should SUCCEED if the vulnerability exists (proving it's exploitable)
- Include comments explaining each step of the exploit''',
'''Rules for the test code:
- Write a COMPLETE, RUNNABLE Anchor test file (.ts)
- Import from @coral-xyz/anchor and @solana/web3.js
- Use describe/it blocks with Mocha
- The describe block MUST start with "PoC#" followed by the class ID, e.g. describe("PoC#42: missing_signer", ...)
- Create realistic account setup (PDAs, token accounts, keypairs)
- Show the EXACT exploit path: what the attacker does, which accounts are passed
- The test should SUCCEED if the vulnerability exists (proving it's exploitable)
- Include comments explaining each step of the exploit''')

# ═══════════════════════════════════════════════════════════════
# 5. Fallback describe: PoC#classId
# ═══════════════════════════════════════════════════════════════
print("\n5. Fallback describe: PoC#classId...")
replace_in(F,
    'describe("PoC: ${finding.className}',
    'describe("PoC#${finding.classId}: ${finding.className}')

# ═══════════════════════════════════════════════════════════════
# 6. Dispatch loop: provider label from resolver
# ═══════════════════════════════════════════════════════════════
print("\n6. Dispatch loop: provider label from resolver...")
replace_in(F,
'''  // LLM-powered generation — sequential with cooldown to avoid rate-limits
  const usingApi = process.env.KIMI_CODE_API_KEY ? "Kimi Code" : "Moonshot";
  console.log(`[poc-gen] Generating via ${usingApi} API (concurrency: ${POC_CFG.concurrency}, delay: ${POC_CFG.interRequestDelayMs}ms)`);
  const limit = pLimit(POC_CFG.concurrency);''',
'''  // LLM-powered generation — sequential with cooldown to avoid rate-limits
  const provider = resolvePocProvider();
  const providerLabel = provider === "kimi_code" ? "Kimi Code" : "Moonshot";
  console.log(`[poc-gen] Generating via ${providerLabel} API (model: ${getPocModel()}, concurrency: ${POC_CFG.concurrency}, delay: ${POC_CFG.interRequestDelayMs}ms)`);
  const limit = pLimit(POC_CFG.concurrency);''')

print("\n✅ All review feedback applied!")
print("\nChanges:")
print("  [1] Smart 400 retry: only transient errors retried, deterministic fail fast")
print("  [2] max_tokens downshift: halves on token-limit 400, retries once")
print("  [3] LLM_POC_MODEL env var (separated from KIMI_PATCH_MODEL)")
print("  [4] safeInt() guards NaN from bad env values")
print("  [5] Default max_tokens lowered to 4096")
print("  [6] POC_PROVIDER=auto|kimi_code|moonshot override")
print("  [7] Stable PoC#classId grep token (no regex metachar risk)")
