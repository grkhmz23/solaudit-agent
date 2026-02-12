"use client";
export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import { getApiKey, setApiKey, fetchQueueHealth, fetchQueueStats } from "@/lib/hooks";
import { Card } from "@/components/ui";

export default function SettingsPage() {
  const [key, setKeyState] = useState("");
  const [saved, setSaved] = useState(false);
  const [health, setHealth] = useState<{ redis: string; database: string; timestamp: string } | null>(null);
  const [stats, setStats] = useState<{ waiting: number; active: number; completed: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setKeyState(getApiKey());
    refresh();
  }, []);

  const refresh = async () => {
    setErr(null);
    try {
      const [h, q] = await Promise.all([fetchQueueHealth(), fetchQueueStats()]);
      setHealth(h);
      setStats(q);
    } catch (e: any) { setErr(e.message); }
  };

  const save = () => {
    setApiKey(key);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <h1 className="text-lg font-semibold">Configuration</h1>

      <Card>
        <label className="block text-xs font-medium text-[var(--fg-muted)] mb-2 mono">api key</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKeyState(e.target.value)}
            placeholder="enter api key..."
            className="flex-1 px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded text-sm mono text-[var(--fg)] placeholder-[var(--fg-dim)] focus:outline-none focus:border-[var(--accent)] transition-colors"
          />
          <button onClick={save} className="px-3 py-2 bg-[var(--accent)] text-black text-xs font-semibold rounded hover:brightness-110 transition-all">
            {saved ? "saved" : "save"}
          </button>
        </div>
        <p className="text-[10px] text-[var(--fg-dim)] mt-2 mono">stored in browser localStorage</p>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium text-[var(--fg-muted)] mono">system health</span>
          <button onClick={refresh} className="text-[10px] mono text-[var(--accent)] hover:brightness-110">refresh</button>
        </div>
        {err ? (
          <p className="text-xs mono text-red-400">{err}</p>
        ) : health ? (
          <div className="space-y-2">
            <HealthRow label="database" status={health.database} />
            <HealthRow label="redis" status={health.redis} />
            <p className="text-[10px] mono text-[var(--fg-dim)] mt-2">
              checked {new Date(health.timestamp).toLocaleTimeString()}
            </p>
          </div>
        ) : (
          <Spinner />
        )}
      </Card>

      <Card>
        <span className="text-xs font-medium text-[var(--fg-muted)] mono block mb-3">queue</span>
        {stats ? (
          <div className="grid grid-cols-4 gap-2">
            <Stat label="waiting" value={stats.waiting} color="text-[var(--fg-muted)]" />
            <Stat label="active" value={stats.active} color="text-blue-400" />
            <Stat label="done" value={stats.completed} color="text-[var(--accent)]" />
            <Stat label="failed" value={stats.failed} color="text-red-400" />
          </div>
        ) : (
          <Spinner />
        )}
      </Card>

      <Card>
        <span className="text-xs font-medium text-[var(--fg-muted)] mono block mb-3">env vars</span>
        <div className="space-y-1 text-[11px] mono text-[var(--fg-dim)]">
          {["DATABASE_URL", "REDIS_URL", "API_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "GITHUB_TOKEN"].map(v => (
            <p key={v}>{v}</p>
          ))}
        </div>
      </Card>
    </div>
  );
}

function HealthRow({ label, status }: { label: string; status: string }) {
  const ok = status === "ok" || status === "connected";
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs mono text-[var(--fg-muted)]">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-[var(--accent)]" : "bg-red-400"}`} />
        <span className={`text-[11px] mono ${ok ? "text-[var(--accent)]" : "text-red-400"}`}>{status}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center p-2.5 bg-[var(--bg)] rounded border border-[var(--border)]">
      <p className={`text-xl font-bold mono ${color}`}>{value}</p>
      <p className="text-[10px] mono text-[var(--fg-dim)] mt-0.5">{label}</p>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-4">
      <div className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
