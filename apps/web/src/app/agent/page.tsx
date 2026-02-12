"use client";
export const dynamic = "force-dynamic";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui";

const TARGETS = [
  { name: "orca-so/whirlpools", stars: "2.5K", cat: "DEX" },
  { name: "raydium-io/raydium-amm", stars: "1.8K", cat: "DEX" },
  { name: "drift-labs/protocol-v2", stars: "1.2K", cat: "Perps" },
  { name: "marinade-finance/liquid-staking-program", stars: "900", cat: "Staking" },
  { name: "openbook-dex/openbook-v2", stars: "800", cat: "DEX" },
  { name: "squads-protocol/v4", stars: "600", cat: "Multisig" },
  { name: "switchboard-xyz/switchboard-v2", stars: "500", cat: "Oracle" },
  { name: "jito-foundation/jito-programs", stars: "450", cat: "MEV" },
];

export default function AgentPage() {
  const [mode, setMode] = useState<"targeted" | "discover">("targeted");
  const [selected, setSelected] = useState<string[]>([]);
  const [customUrl, setCustomUrl] = useState("");
  const [submitPRs, setSubmitPRs] = useState(false);
  const [maxRepos, setMaxRepos] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const apiKey =
    typeof window !== "undefined"
      ? localStorage.getItem("solaudit_api_key") ?? ""
      : "";

  const toggle = (n: string) =>
    setSelected((p) =>
      p.includes(n) ? p.filter((r) => r !== n) : [...p, n]
    );

  const addUrl = () => {
    if (customUrl.trim() && !selected.includes(customUrl.trim())) {
      setSelected((p) => [...p, customUrl.trim()]);
      setCustomUrl("");
    }
  };

  const start = async () => {
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const h: HeadersInit = { "Content-Type": "application/json" };
      if (apiKey) h["x-api-key"] = apiKey;

      const body =
        mode === "discover"
          ? { mode: "discover", maxRepos, submitPRs }
          : {
              mode: "audit",
              repos: selected.map((r) =>
                r.startsWith("http") ? r : `https://github.com/${r}`
              ),
              submitPRs,
            };

      const res = await fetch("/api/agent", {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Agent request failed");
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-lg font-semibold">Agent Mode</h1>
        <span className="badge badge-info">autonomous</span>
      </div>

      <p className="text-xs text-[var(--fg-muted)] mb-6">
        Discover repos, audit them, generate patches, and open pull requests
        autonomously.
      </p>

      {/* Mode selector */}
      <Card className="mb-4">
        <label className="block text-xs font-medium text-[var(--fg-muted)] mb-3 mono">
          mode
        </label>
        <div className="flex gap-2">
          {(["targeted", "discover"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 px-3 py-2.5 rounded border text-xs mono transition-all ${
                mode === m
                  ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--fg-dim)]"
              }`}
            >
              {m === "targeted" ? "targeted audit" : "auto discover"}
              <br />
              <span className="text-[10px] opacity-60">
                {m === "targeted" ? "select specific repos" : "find high-value targets"}
              </span>
            </button>
          ))}
        </div>
      </Card>

      {/* Repo selection */}
      {mode === "targeted" && (
        <Card className="mb-4">
          <label className="block text-xs font-medium text-[var(--fg-muted)] mb-3 mono">
            target repositories
          </label>

          <div className="grid grid-cols-2 gap-1.5 mb-4">
            {TARGETS.map((t) => (
              <button
                key={t.name}
                onClick={() => toggle(t.name)}
                className={`px-3 py-2 rounded border text-left transition-all ${
                  selected.includes(t.name)
                    ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)] hover:border-[var(--border-hover)]"
                }`}
              >
                <p className="text-xs text-[var(--fg)] truncate">{t.name}</p>
                <div className="flex gap-2 mt-0.5">
                  <span className="text-[10px] mono text-[var(--fg-dim)]">
                    {t.stars}
                  </span>
                  <span className="text-[10px] mono text-[var(--fg-dim)]">
                    {t.cat}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addUrl()}
              placeholder="https://github.com/org/repo"
              className="flex-1 px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded text-sm mono text-[var(--fg)] placeholder-[var(--fg-dim)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={addUrl}
              className="px-3 py-2 border border-[var(--border)] rounded text-xs mono text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--border-hover)]"
            >
              add
            </button>
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {selected.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)] text-[11px] mono text-[var(--fg-muted)]"
                >
                  {r.replace("https://github.com/", "")}
                  <button
                    onClick={() =>
                      setSelected((p) => p.filter((x) => x !== r))
                    }
                    className="text-[var(--fg-dim)] hover:text-red-400 ml-1"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Discovery options */}
      {mode === "discover" && (
        <Card className="mb-4">
          <label className="block text-xs font-medium text-[var(--fg-muted)] mb-3 mono">
            discovery options
          </label>
          <div>
            <span className="text-[10px] mono text-[var(--fg-dim)] block mb-1">
              max repos
            </span>
            <select
              value={maxRepos}
              onChange={(e) => setMaxRepos(Number(e.target.value))}
              className="px-2 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded text-xs mono text-[var(--fg)]"
            >
              {[1, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </Card>
      )}

      {/* PR toggle */}
      <Card className="mb-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={submitPRs}
            onChange={(e) => setSubmitPRs(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <div>
            <p className="text-xs font-medium text-[var(--fg)]">
              Auto-submit pull requests
            </p>
            <p className="text-[10px] text-[var(--fg-dim)] mono mt-0.5">
              Fork repos, commit patches, and open PRs. Requires GITHUB_TOKEN on worker.
            </p>
          </div>
        </label>
      </Card>

      {/* Error */}
      {error && (
        <Card className="mb-4 border-red-900/50">
          <p className="text-red-400 text-xs mono">{error}</p>
        </Card>
      )}

      {/* Result */}
      {result && (
        <Card className="mb-4 border-[var(--accent)]/20">
          <p className="text-[var(--accent)] text-xs mono mb-2">
            Agent jobs queued
          </p>
          {result.jobId && (
            <Link
              href={`/audit/${result.jobId}`}
              className="text-xs mono text-[var(--accent)] hover:brightness-110"
            >
              View job: {result.jobId}
            </Link>
          )}
          {result.jobs?.map((j: any) => (
            <Link
              key={j.jobId}
              href={`/audit/${j.jobId}`}
              className="block text-xs mono text-[var(--accent)] hover:brightness-110 mt-1"
            >
              {j.repoUrl} → {j.jobId}
            </Link>
          ))}
        </Card>
      )}

      {/* Start button */}
      <button
        onClick={start}
        disabled={running || (mode === "targeted" && selected.length === 0)}
        className="w-full px-4 py-2.5 bg-[var(--accent)] text-black text-sm font-semibold rounded hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {running ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
            running agent...
          </span>
        ) : mode === "discover" ? (
          "Discover and audit"
        ) : (
          `Audit ${selected.length} repo${selected.length !== 1 ? "s" : ""}`
        )}
      </button>
    </div>
  );
}
