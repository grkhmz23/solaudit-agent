"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";

const KNOWN_TARGETS = [
  { name: "orca-so/whirlpools", stars: "512", cat: "DEX", tvl: "High" },
  { name: "raydium-io/raydium-amm", stars: "344", cat: "DEX", tvl: "High" },
  { name: "drift-labs/protocol-v2", stars: "378", cat: "Perps", tvl: "High" },
  { name: "marinade-finance/liquid-staking-program", stars: "900", cat: "LST", tvl: "High" },
  { name: "openbook-dex/openbook-v2", stars: "800", cat: "DEX", tvl: "High" },
  { name: "jito-foundation/jito-programs", stars: "450", cat: "MEV", tvl: "High" },
  { name: "squads-protocol/v4", stars: "600", cat: "Multisig", tvl: "Med" },
  { name: "switchboard-xyz/switchboard-v2", stars: "500", cat: "Oracle", tvl: "Med" },
];

// ─── Stage metadata for human-readable logs ──────────────────
const STAGE_META: Record<string, { icon: string; label: string; color: string }> = {
  "agent:start":     { icon: "▶", label: "Starting", color: "text-blue-400" },
  "agent:clone":     { icon: "📦", label: "Cloning repo", color: "text-blue-400" },
  "agent:audit":     { icon: "🔍", label: "Audit pipeline", color: "text-cyan-400" },
  "agent:pipeline":  { icon: "⚙", label: "Pipeline", color: "text-cyan-400" },
  "agent:found":     { icon: "🎯", label: "Findings", color: "text-yellow-400" },
  "agent:patch":     { icon: "🔧", label: "Patching", color: "text-orange-400" },
  "agent:poc":       { icon: "🧪", label: "PoC tests", color: "text-purple-400" },
  "agent:llm":       { icon: "🧠", label: "LLM analysis", color: "text-pink-400" },
  "agent:llm_error": { icon: "⚠", label: "LLM warning", color: "text-yellow-500" },
  "agent:advisory":  { icon: "📄", label: "Advisory", color: "text-indigo-400" },
  "agent:pr":        { icon: "🚀", label: "Pull request", color: "text-green-400" },
  "agent:pr_error":  { icon: "⚠", label: "PR warning", color: "text-yellow-500" },
  "agent:done":      { icon: "✅", label: "Complete", color: "text-green-400" },
  "agent:error":     { icon: "❌", label: "Error", color: "text-red-400" },
  "agent:skip":      { icon: "⏭", label: "Skipped", color: "text-gray-400" },
  "agent_starting":  { icon: "▶", label: "Initializing", color: "text-blue-400" },
  "discovering":     { icon: "🔎", label: "Discovering", color: "text-cyan-400" },
  "completed":       { icon: "✅", label: "Done", color: "text-green-400" },
};

function getStageMeta(stage: string) {
  return STAGE_META[stage] || { icon: "○", label: stage, color: "text-gray-400" };
}

type LogEntry = { time: string; stage: string; detail: string; progress: number };

interface JobTracker {
  jobId: string;
  repoUrl: string;
  repoShort: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  progress: number;
  lastStage: string;
  lastDetail: string;
  startedAt: number;
  logs: LogEntry[];
}

export default function AgentPage() {
  const [mode, setMode] = useState<"bounty" | "targeted" | "discover">("bounty");
  const [selected, setSelected] = useState<string[]>([]);
  const [customUrl, setCustomUrl] = useState("");
  const [submitPRs, setSubmitPRs] = useState(true);
  const [maxRepos, setMaxRepos] = useState(3);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobTracker[]>([]);
  const [activeJobIdx, setActiveJobIdx] = useState(0);
  const logsEnd = useRef<HTMLDivElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

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

  // Auto-scroll logs
  useEffect(() => {
    logsEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [jobs, activeJobIdx]);

  // ─── Polling logic ─────────────────────────────────────────
  const pollJobs = useCallback(async () => {
    setJobs((prevJobs) => {
      // We can't do async inside setState, so we trigger fetches outside
      return prevJobs;
    });

    // Fetch all active jobs
    const currentJobs = jobs;
    let anyActive = false;
    const updates: JobTracker[] = [...currentJobs];

    for (let i = 0; i < updates.length; i++) {
      const job = updates[i];
      if (job.status === "SUCCEEDED" || job.status === "FAILED") continue;
      anyActive = true;

      try {
        const headers: HeadersInit = {};
        if (apiKey) headers["x-api-key"] = apiKey;
        const res = await fetch(`/api/audits/${job.jobId}`, { headers });
        if (!res.ok) continue;
        const data = await res.json();

        const newStage = data.stageName || "";
        const newProgress = data.progress || 0;

        // Only add log if stage changed
        if (newStage && newStage !== job.lastStage) {
          const time = new Date().toLocaleTimeString("en-US", { hour12: false });
          const meta = getStageMeta(newStage);

          // Build a descriptive detail
          let detail = "";
          if (newStage.includes("pipeline")) {
            const pipelineStages: Record<number, string> = {
              5: "Parsing source code...",
              15: "Building dependency graphs...",
              30: "Running vulnerability detectors...",
              45: "Checking constraints...",
              50: "Adversarial synthesis...",
              65: "Constructing proofs...",
              80: "Planning remediations...",
              90: "Finalizing analysis...",
              95: "Generating report...",
              100: "Pipeline complete",
            };
            detail = pipelineStages[newProgress] || `Stage ${newProgress}%`;
          } else if (newStage.includes("clone")) {
            detail = `Cloning ${job.repoShort}...`;
          } else if (newStage.includes("found")) {
            detail = `Actionable findings detected`;
          } else if (newStage.includes("patch")) {
            detail = `Generating code patches...`;
          } else if (newStage.includes("llm") && !newStage.includes("error")) {
            detail = "Dedupe → Select → Deep dive (Kimi K2)";
          } else if (newStage.includes("advisory")) {
            detail = "Generating security advisory...";
          } else if (newStage.includes("pr") && !newStage.includes("error")) {
            detail = "Forking repo & opening pull request...";
          } else if (newStage.includes("done")) {
            detail = "All steps completed successfully";
          } else {
            detail = meta.label;
          }

          job.logs.push({ time, stage: newStage, detail, progress: newProgress });
          job.lastStage = newStage;
          job.lastDetail = detail;
        }

        job.progress = newProgress;

        if (data.status === "SUCCEEDED") {
          job.status = "SUCCEEDED";
          job.progress = 100;
          if (job.logs[job.logs.length - 1]?.stage !== "completed") {
            const time = new Date().toLocaleTimeString("en-US", { hour12: false });
            job.logs.push({ time, stage: "completed", detail: "Agent run finished", progress: 100 });
          }
        } else if (data.status === "FAILED") {
          job.status = "FAILED";
          const time = new Date().toLocaleTimeString("en-US", { hour12: false });
          job.logs.push({ time, stage: "agent:error", detail: data.error || "Job failed", progress: job.progress });
        } else {
          job.status = "RUNNING";
        }
      } catch {}
    }

    setJobs([...updates]);

    if (!anyActive) {
      setRunning(false);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
  }, [jobs, apiKey]);

  // Start/stop polling
  useEffect(() => {
    if (running && jobs.length > 0 && !pollRef.current) {
      pollRef.current = setInterval(pollJobs, 5000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [running, jobs.length, pollJobs]);

  // ─── Launch ────────────────────────────────────────────────
  const start = async () => {
    setRunning(true);
    setError(null);
    setJobs([]);
    setActiveJobIdx(0);

    try {
      const h: HeadersInit = { "Content-Type": "application/json" };
      if (apiKey) h["x-api-key"] = apiKey;

      let body: any;
      if (mode === "bounty") {
        const topTargets = KNOWN_TARGETS.slice(0, 3).map(
          (t) => `https://github.com/${t.name}`
        );
        body = { mode: "audit", repos: topTargets, submitPRs };
      } else if (mode === "discover") {
        body = { mode: "discover", maxRepos, submitPRs };
      } else {
        body = {
          mode: "audit",
          repos: selected.map((r) =>
            r.startsWith("http") ? r : `https://github.com/${r}`
          ),
          submitPRs,
        };
      }

      const res = await fetch("/api/agent", {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");

      // Build job trackers
      const newJobs: JobTracker[] = [];
      const now = Date.now();
      const nowTime = new Date().toLocaleTimeString("en-US", { hour12: false });

      if (data.jobs) {
        for (const j of data.jobs) {
          const short = j.repoUrl.replace("https://github.com/", "");
          newJobs.push({
            jobId: j.jobId,
            repoUrl: j.repoUrl,
            repoShort: short,
            status: "QUEUED",
            progress: 0,
            lastStage: "",
            lastDetail: "",
            startedAt: now,
            logs: [{ time: nowTime, stage: "agent:start", detail: `Queued audit for ${short}`, progress: 0 }],
          });
        }
      } else if (data.jobId) {
        const short = body.repos?.[0]?.replace("https://github.com/", "") || "repo";
        newJobs.push({
          jobId: data.jobId,
          repoUrl: body.repos?.[0] || "",
          repoShort: short,
          status: "QUEUED",
          progress: 0,
          lastStage: "",
          lastDetail: "",
          startedAt: now,
          logs: [{ time: nowTime, stage: "agent:start", detail: `Queued audit for ${short}`, progress: 0 }],
        });
      }

      setJobs(newJobs);
    } catch (e: any) {
      setError(e.message);
      setRunning(false);
    }
  };

  // ─── Elapsed time formatter ────────────────────────────────
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((p) => p + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  function elapsed(startedAt: number): string {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  // ─── Current active job ────────────────────────────────────
  const activeJob = jobs[activeJobIdx];

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
            disabled={running}
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
      {mode === "bounty" && !running && (
        <div className="mb-4 p-4 rounded-lg border border-green-800/30 bg-green-900/10">
          <p className="text-xs text-green-400 font-semibold mb-2">One-Click Bounty Submission</p>
          <p className="text-[11px] text-[var(--fg-muted)] leading-relaxed">
            Audits the top 3 Solana protocols, generates LLM-powered vulnerability analysis,
            creates code patches, and opens pull requests — all automatically.
          </p>
          <div className="mt-3 flex gap-2 flex-wrap">
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
      {mode === "targeted" && !running && (
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
      {mode === "discover" && !running && (
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
      {!running && (
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
                Fork repos, commit patches, open PRs with full advisory.
              </p>
            </div>
          </label>
        </div>
      )}

      {/* Start button */}
      {!running && (
        <button
          onClick={start}
          disabled={running || (mode === "targeted" && selected.length === 0)}
          className="w-full px-4 py-3 bg-[var(--accent)] text-black text-sm font-bold rounded-lg hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all mb-4"
        >
          {mode === "bounty"
            ? "Launch Bounty Agent"
            : mode === "discover"
            ? "Discover & Audit"
            : `Audit ${selected.length} repo${selected.length !== 1 ? "s" : ""}`}
        </button>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-800/50 bg-red-900/20">
          <p className="text-red-400 text-xs font-mono">{error}</p>
        </div>
      )}

      {/* ─── Live Progress Dashboard ─────────────────────────── */}
      {jobs.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden mb-4">
          {/* Job tabs (if multiple) */}
          {jobs.length > 1 && (
            <div className="flex border-b border-[var(--border)] bg-[var(--bg-dim)]">
              {jobs.map((j, i) => (
                <button
                  key={j.jobId}
                  onClick={() => setActiveJobIdx(i)}
                  className={`flex-1 px-3 py-2 text-[10px] font-mono transition-all border-b-2 ${
                    i === activeJobIdx
                      ? "border-[var(--accent)] text-[var(--fg)]"
                      : "border-transparent text-[var(--fg-dim)] hover:text-[var(--fg-muted)]"
                  }`}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    {j.status === "SUCCEEDED" ? (
                      <span className="text-green-400">✓</span>
                    ) : j.status === "FAILED" ? (
                      <span className="text-red-400">✗</span>
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
                    )}
                    {j.repoShort.split("/").pop()}
                  </span>
                </button>
              ))}
            </div>
          )}

          {activeJob && (
            <>
              {/* Status bar */}
              <div className="px-4 py-3 border-b border-[var(--border)]">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {activeJob.status === "SUCCEEDED" ? (
                      <span className="w-2 h-2 rounded-full bg-green-400" />
                    ) : activeJob.status === "FAILED" ? (
                      <span className="w-2 h-2 rounded-full bg-red-400" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
                    )}
                    <span className="text-xs font-mono text-[var(--fg)]">
                      {activeJob.repoShort}
                    </span>
                    <span className="text-[10px] text-[var(--fg-dim)]">
                      {activeJob.status === "SUCCEEDED"
                        ? "completed"
                        : activeJob.status === "FAILED"
                        ? "failed"
                        : getStageMeta(activeJob.lastStage).label}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-[var(--fg-dim)]">
                      {elapsed(activeJob.startedAt)}
                    </span>
                    <span className="text-[10px] font-mono text-[var(--fg-muted)]">
                      {activeJob.progress}%
                    </span>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="w-full h-1.5 bg-[var(--bg-dim)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-out"
                    style={{
                      width: `${activeJob.progress}%`,
                      backgroundColor:
                        activeJob.status === "SUCCEEDED"
                          ? "#22c55e"
                          : activeJob.status === "FAILED"
                          ? "#ef4444"
                          : "var(--accent)",
                    }}
                  />
                </div>
              </div>

              {/* Live log */}
              <div className="p-3 max-h-80 overflow-y-auto font-mono text-[11px] space-y-0.5 bg-black/30">
                {activeJob.logs.map((l, i) => {
                  const meta = getStageMeta(l.stage);
                  return (
                    <div key={i} className="flex gap-2 py-0.5">
                      <span className="text-[var(--fg-dim)] shrink-0 w-[52px] text-right">
                        {l.time.split(":").slice(1).join(":")}
                      </span>
                      <span className="shrink-0 w-4 text-center">{meta.icon}</span>
                      <span className={`shrink-0 ${meta.color}`}>
                        {meta.label}
                      </span>
                      <span className="text-[var(--fg-muted)] truncate">{l.detail}</span>
                    </div>
                  );
                })}

                {/* Current activity indicator */}
                {activeJob.status !== "SUCCEEDED" && activeJob.status !== "FAILED" && (
                  <div className="flex gap-2 py-0.5 opacity-60">
                    <span className="text-[var(--fg-dim)] shrink-0 w-[52px]" />
                    <span className="shrink-0 w-4 text-center">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                    </span>
                    <span className="text-[var(--fg-dim)] italic">working...</span>
                  </div>
                )}
                <div ref={logsEnd} />
              </div>

              {/* Job link */}
              <div className="px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-dim)]">
                <Link
                  href={`/audit/${activeJob.jobId}`} target="_blank"
                  className="text-[10px] font-mono text-[var(--accent)] hover:underline"
                >
                  View full audit → {activeJob.jobId.slice(0, 8)}...
                </Link>
              </div>
            </>
          )}
        </div>
      )}

      {/* Summary when all done */}
      {jobs.length > 0 && jobs.every((j) => j.status === "SUCCEEDED" || j.status === "FAILED") && (
        <div className="p-4 rounded-lg border border-green-800/30 bg-green-900/10 mb-4">
          <p className="text-xs font-semibold text-green-400 mb-2">Agent Run Complete</p>
          <div className="flex gap-4 text-[11px] font-mono">
            <span className="text-[var(--fg-muted)]">
              {jobs.filter((j) => j.status === "SUCCEEDED").length}/{jobs.length} succeeded
            </span>
            <span className="text-[var(--fg-muted)]">
              {elapsed(jobs[0]?.startedAt || Date.now())} total
            </span>
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            {jobs.map((j) => (
              <Link
                key={j.jobId}
                href={`/audit/${j.jobId}`}
                className={`px-2 py-1 rounded text-[10px] font-mono border ${
                  j.status === "SUCCEEDED"
                    ? "border-green-800/50 text-green-400 bg-green-900/20"
                    : "border-red-800/50 text-red-400 bg-red-900/20"
                } hover:brightness-110`}
              >
                {j.repoShort.split("/").pop()} {j.status === "SUCCEEDED" ? "✓" : "✗"}
              </Link>
            ))}
          </div>

          {/* Restart button */}
          <button
            onClick={() => { setJobs([]); setRunning(false); }}
            className="mt-3 px-4 py-2 border border-[var(--border)] rounded text-xs font-mono text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--border-hover)] transition-all"
          >
            ← Run again
          </button>
        </div>
      )}
    </div>
  );
}