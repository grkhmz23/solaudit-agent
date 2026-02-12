"use client";

import { useState, useEffect } from "react";
import { getApiKey, setApiKey, fetchQueueHealth, fetchQueueStats } from "@/lib/hooks";
import { Card } from "@/components/ui";

export default function SettingsPage() {
  const [apiKey, setApiKeyState] = useState("");
  const [saved, setSaved] = useState(false);
  const [health, setHealth] = useState<{
    redis: string;
    database: string;
    timestamp: string;
  } | null>(null);
  const [queueStats, setQueueStats] = useState<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  } | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    setApiKeyState(getApiKey());
    refreshHealth();
  }, []);

  const refreshHealth = async () => {
    setHealthError(null);
    try {
      const [h, q] = await Promise.all([fetchQueueHealth(), fetchQueueStats()]);
      setHealth(h);
      setQueueStats(q);
    } catch (err: any) {
      setHealthError(err.message);
    }
  };

  const handleSaveKey = () => {
    setApiKey(apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* API Key */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">API Key</h2>
        <p className="text-xs text-gray-500 mb-3">
          Set the API key used for authenticating requests. This is stored in
          your browser's localStorage.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKeyState(e.target.value)}
            placeholder="Enter API key..."
            className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-green-600"
          />
          <button
            onClick={handleSaveKey}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded transition-colors"
          >
            {saved ? "Saved!" : "Save"}
          </button>
        </div>
      </Card>

      {/* System Health */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">System Health</h2>
          <button
            onClick={refreshHealth}
            className="text-xs text-green-400 hover:text-green-300"
          >
            Refresh
          </button>
        </div>

        {healthError ? (
          <p className="text-sm text-red-400">{healthError}</p>
        ) : health ? (
          <div className="space-y-2">
            <HealthRow label="Database" status={health.database} />
            <HealthRow label="Redis" status={health.redis} />
            <p className="text-xs text-gray-600 mt-2">
              Last checked: {new Date(health.timestamp).toLocaleString()}
            </p>
          </div>
        ) : (
          <p className="text-sm text-gray-400">Loading...</p>
        )}
      </Card>

      {/* Queue Stats */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Queue Status
        </h2>
        {queueStats ? (
          <div className="grid grid-cols-4 gap-3">
            <QueueStat label="Waiting" value={queueStats.waiting} color="text-gray-300" />
            <QueueStat label="Active" value={queueStats.active} color="text-blue-400" />
            <QueueStat label="Completed" value={queueStats.completed} color="text-green-400" />
            <QueueStat label="Failed" value={queueStats.failed} color="text-red-400" />
          </div>
        ) : (
          <p className="text-sm text-gray-400">Loading...</p>
        )}
      </Card>

      {/* Environment Info */}
      <Card>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Configuration
        </h2>
        <p className="text-xs text-gray-500">
          Environment variables are configured on the server side. Ensure the
          worker process is running alongside Redis and PostgreSQL for full
          functionality. See the README for details.
        </p>
        <div className="mt-3 space-y-1 text-xs font-mono text-gray-400">
          <p>DATABASE_URL — PostgreSQL connection</p>
          <p>REDIS_URL — Redis / Upstash connection</p>
          <p>API_KEY — API authentication key</p>
          <p>STORAGE_DIR — Artifact storage directory</p>
          <p>WORKER_ENABLE_PROVE — Enable proof execution</p>
          <p>GITHUB_TOKEN — Private repo access (optional)</p>
        </div>
      </Card>
    </div>
  );
}

function HealthRow({ label, status }: { label: string; status: string }) {
  const isOk = status === "ok" || status === "connected";
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm text-gray-400">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            isOk ? "bg-green-500" : "bg-red-500"
          }`}
        />
        <span
          className={`text-sm ${isOk ? "text-green-400" : "text-red-400"}`}
        >
          {status}
        </span>
      </div>
    </div>
  );
}

function QueueStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="text-center p-3 bg-gray-900 rounded border border-gray-800">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}
