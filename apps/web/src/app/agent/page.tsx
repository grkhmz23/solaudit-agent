"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";

const KNOWN_TARGETS = [
  { name: "orca-so/whirlpools", stars: "2.5K", cat: "DEX", tvl: "High" },
  { name: "raydium-io/raydium-amm", stars: "1.8K", cat: "DEX", tvl: "High" },
  { name: "drift-labs/protocol-v2", stars: "1.2K", cat: "Perps", tvl: "High" },
  { name: "marinade-finance/liquid-staking-program", stars: "900", cat: "LST", tvl: "High" },
  { name: "openbook-dex/openbook-v2", stars: "800", cat: "DEX", tvl: "High" },
  { name: "jito-foundation/jito-programs", stars: "450", cat: "MEV", tvl: "High" },
  { name: "squads-protocol/v4", stars: "600", cat: "Multisig", tvl: "Med" },
  { name: "switchboard-xyz/switchboard-v2", stars: "500", cat: "Oracle", tvl: "Med" },
];

type LogEntry = { time: string; step: string; detail: string };

export default function AgentPage() {
  const [mode, setMode] = useState<"bounty" | "targeted" | "discover">("bounty");
  const [selected, setSelected] = useState<string[]>([]);
  const [customUrl, setCustomUrl] = useState("");
  const [submitPRs, setSubmitPRs] = useState(true);
  const [maxRepos, setMaxRepos] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [polling, setPolling] = useState<string | null>(null);
  const logsEnd = useRef<HTMLDivElement>(null);

  const apiKey =
    typeof window !== "undefined"
      ? localStorage.getItem("solaudit_api_key") ?? ""
      : "";

  const toggle = (n: string) =>
    setSelected((p) => (p.includes(n) ? p.filter((r) => r !== n) : [...p, n]));

  const addUrl = () => {
    if (customUrl.trim() && !selected.includes(customUrl.trim())) {
      setSelected((p) => [...p, customUrl.trim()]);
      setCustomUrl("");
    }
  };

  const addLog = (step: string, detail: string) => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((p) => [...p, { time, step, detail }]);
  };

  // Auto-scroll logs
  useEffect(() => {
    logsEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Poll job status
  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/audits/${polling}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.stageName) {
          addLog(data.stageName, `Progress: ${data.progress}%`);
        }
        if (data.status === "COMPLETED") {
          addLog("completed", "Agent run finished successfully!");
          setPolling(null);
          setRunning(false);
        } else if (data.status === "FAILED") {
          addLog("failed", data.error || "Agent run failed");
          setPolling(null);
          setRunning(false);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [polling]);

  const start = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setLogs([]);

    addLog("init", "Starting autonomous agent...");

    try {
      const h: HeadersInit = { "Content-Type": "application/json" };
      if (apiKey) h["x-api-key"] = apiKey;

      let body: any;

      if (mode === "bounty") {
        // One-click: use top 3 known protocols
        const topTargets = KNOWN_TARGETS.slice(0, 3).map(
          (t) => `https://github.com/${t.name}`
        );
        body = { mode: "audit", repos: topTargets, submitPRs };
        addLog("targets", topTargets.map((t) => t.split("/").slice(-2).join("/")).join(", "));
      } else if (mode === "discover") {
        body = { mode: "discover", maxRepos, submitPRs };
        addLog("discover", `Searching for top ${maxRepos} Solana repos...`);
      } else {
        body = {
          mode: "audit",
          repos: selected.map((r) =>
            r.startsWith("http") ? r : `https://github.com/${r}`
          ),
          submitPRs,
        };
        addLog("targets", `${selected.length} repo(s) selected`);
      }

      addLog("queue", "Submitting to job queue...");

      const res = await fetch("/api/agent", {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult(data);

      addLog("queued", "Jobs created successfully");

      // Start polling first job
      const firstJobId = data.jobId || data.jobs?.[0]?.jobId;
      if (firstJobId) {
        addLog("polling", `Tracking job: ${firstJobId}`);
        setPolling(firstJobId);
      }
    } catch (e: any) {
      setError(e.message);
      addLog("error", e.message);
      setRunning(false);
    }
  };

  const stepColors: Record<string, string> = {
    init: "text-blue-400",
    targets: "text-cyan-400",
    discover: "text-cyan-400",
    queue: "text-yellow-400",
    queued: "text-green-400",
    polling: "text-purple-400",
    completed: "text-green-400",
    failed: "text-red-400",
    error: "text-red-400",
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-lg font-semibold">Agent Mode</h1>
        <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-green-900/50 text-green-400 border border-green-800/50">
          autonomous
        </span>
      </div>

      <p className="text-xs text-[var(--fg-muted)] mb-6">
        Pick repo → audit → LLM write-up → generate patches → open PR → security advisory. Fully autonomous.
      </p>

      {/* Mode tabs */}
      <div className="flex gap-1 mb-4 p-1 bg-[var(--bg-dim)] rounded-lg">
        {(
          [
            ["bounty", "One-Click Bounty", "Top protocols, auto PR"],
            ["targeted", "Targeted", "Pick specific repos"],
            ["discover", "Discover", "AI finds targets"],
          ] as const
        ).map(([m, label, desc]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 px-3 py-2 rounded text-xs transition-all ${
              mode === m
                ? "bg-[var(--accent)] text-black font-semibold"
                : "text-[var(--fg-dim)] hover:text-[var(--fg)]"
            }`}
          >
            {label}
            <br />
            <span className={`text-[9px] ${mode === m ? "text-black/60" : "opacity-50"}`}>
              {desc}
            </span>
          </button>
        ))}
      </div>

      {/* Bounty mode info */}
      {mode === "bounty" && (
        <div className="mb-4 p-4 rounded-lg border border-green-800/30 bg-green-900/10">
          <p className="text-xs text-green-400 font-semibold mb-2">One-Click Bounty Submission</p>
          <p className="text-[11px] text-[var(--fg-muted)] leading-relaxed">
            Audits the top 3 Solana protocols (Orca Whirlpools, Raydium AMM, Drift v2),
            generates LLM-powered vulnerability analysis, creates code patches,
            and opens pull requests — all automatically. Each PR includes a full security advisory document.
          </p>
          <div className="mt-3 flex gap-2">
            {KNOWN_TARGETS.slice(0, 3).map((t) => (
              <span
                key={t.name}
                className="px-2 py-1 rounded text-[10px] font-mono bg-[var(--bg)] border border-[var(--border)] text-[var(--fg-muted)]"
              >
                {t.name.split("/")[1]} ({t.cat})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Targeted mode */}
      {mode === "targeted" && (
        <div className="mb-4 p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <label className="block text-xs font-medium text-[var(--fg-muted)] mb-3 font-mono">
            select targets
          </label>
          <div className="grid grid-cols-2 gap-1.5 mb-3">
            {KNOWN_TARGETS.map((t) => (
              <button
                key={t.name}
                onClick={() => toggle(t.name)}
                className={`px-3 py-2 rounded border text-left transition-all ${
                  selected.includes(t.name)
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] hover:border-[var(--border-hover)]"
                }`}
              >
                <p className="text-xs text-[var(--fg)] truncate">{t.name}</p>
                <div className="flex gap-2 mt-0.5">
                  <span className="text-[10px] font-mono text-[var(--fg-dim)]">★{t.stars}</span>
                  <span className="text-[10px] font-mono text-[var(--fg-dim)]">{t.cat}</span>
                  <span className={`text-[10px] font-mono ${t.tvl === "High" ? "text-green-400" : "text-yellow-400"}`}>
                    {t.tvl} TVL
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
              className="flex-1 px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded text-sm font-mono text-[var(--fg)] placeholder-[var(--fg-dim)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={addUrl}
              className="px-3 py-2 border border-[var(--border)] rounded text-xs font-mono hover:border-[var(--border-hover)]"
            >
              + add
            </button>
          </div>
        </div>
      )}

      {/* Discover mode */}
      {mode === "discover" && (
        <div className="mb-4 p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
          <label className="block text-xs font-medium text-[var(--fg-muted)] mb-3 font-mono">
            max repos to audit
          </label>
          <div className="flex gap-2">
            {[1, 3, 5, 10].map((n) => (
              <button
                key={n}
                onClick={() => setMaxRepos(n)}
                className={`px-4 py-2 rounded border text-xs font-mono ${
                  maxRepos === n
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--fg-dim)]"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Options */}
      <div className="mb-4 p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={submitPRs}
            onChange={(e) => setSubmitPRs(e.target.checked)}
            className="accent-[var(--accent)] w-4 h-4"
          />
          <div>
            <p className="text-xs font-medium text-[var(--fg)]">Auto-submit pull requests</p>
            <p className="text-[10px] text-[var(--fg-dim)] font-mono mt-0.5">
              Fork repos, commit patches, open PRs with full advisory. Requires GITHUB_TOKEN.
            </p>
          </div>
        </label>
      </div>

      {/* Start button */}
      <button
        onClick={start}
        disabled={running || (mode === "targeted" && selected.length === 0)}
        className="w-full px-4 py-3 bg-[var(--accent)] text-black text-sm font-bold rounded-lg hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all mb-4"
      >
        {running ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
            Agent running...
          </span>
        ) : mode === "bounty" ? (
          "Launch Bounty Agent"
        ) : mode === "discover" ? (
          "Discover & Audit"
        ) : (
          `Audit ${selected.length} repo${selected.length !== 1 ? "s" : ""}`
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-800/50 bg-red-900/20">
          <p className="text-red-400 text-xs font-mono">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mb-4 p-4 rounded-lg border border-[var(--accent)]/20 bg-[var(--accent)]/5">
          <p className="text-[var(--accent)] text-xs font-mono font-semibold mb-2">Jobs Created</p>
          {result.jobId && (
            <Link
              href={`/audit/${result.jobId}`}
              className="block text-xs font-mono text-[var(--accent)] hover:brightness-110 underline"
            >
              {result.jobId}
            </Link>
          )}
          {result.jobs?.map((j: any) => (
            <Link
              key={j.jobId}
              href={`/audit/${j.jobId}`}
              className="block text-xs font-mono text-[var(--accent)] hover:brightness-110 underline mt-1"
            >
              {j.repoUrl.replace("https://github.com/", "")} → {j.jobId}
            </Link>
          ))}
        </div>
      )}

      {/* Live logs */}
      {logs.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-black/50 overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-dim)]">
            <span className="text-[10px] font-mono text-[var(--fg-dim)]">agent log</span>
          </div>
          <div className="p-3 max-h-64 overflow-y-auto font-mono text-[11px] space-y-1">
            {logs.map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-[var(--fg-dim)] shrink-0">{l.time}</span>
                <span className={`shrink-0 ${stepColors[l.step] || "text-[var(--fg-muted)]"}`}>
                  [{l.step}]
                </span>
                <span className="text-[var(--fg)]">{l.detail}</span>
              </div>
            ))}
            <div ref={logsEnd} />
          </div>
        </div>
      )}
    </div>
  );
}
