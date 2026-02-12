"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAudit } from "@/lib/hooks";
import { Card } from "@/components/ui";

const modes = [
  { value: "SCAN", label: "Scan", desc: "Static analysis + graph mining + 15 detectors" },
  { value: "PROVE", label: "Prove", desc: "Scan + proof-of-concept harness generation" },
  { value: "FIX_PLAN", label: "Fix Plan", desc: "Full scan + remediation with code patches" },
];

export default function NewAuditPage() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [mode, setMode] = useState("SCAN");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!repoUrl.trim()) {
      setError("Enter a repository URL.");
      return;
    }

    try { new URL(repoUrl); } catch {
      setError("Invalid URL format.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await createAudit({ repoUrl: repoUrl.trim(), mode });
      router.push(`/audit/${result.audit.id}`);
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-lg font-semibold mb-6">New Audit</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <label className="block text-xs font-medium text-[var(--fg-muted)] mb-2 mono">
            repository url
          </label>
          <input
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/program.git"
            className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded text-sm mono text-[var(--fg)] placeholder-[var(--fg-dim)] focus:outline-none focus:border-[var(--accent)] transition-colors"
            disabled={submitting}
          />
          <p className="text-[10px] text-[var(--fg-dim)] mt-2 mono">
            HTTPS only. Private repos require GITHUB_TOKEN on the worker.
          </p>
        </Card>

        <Card>
          <label className="block text-xs font-medium text-[var(--fg-muted)] mb-3 mono">
            mode
          </label>
          <div className="space-y-1.5">
            {modes.map((m) => (
              <label
                key={m.value}
                className={`flex items-start gap-3 px-3 py-2.5 rounded border cursor-pointer transition-all ${
                  mode === m.value
                    ? "border-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)] hover:border-[var(--border-hover)]"
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={mode === m.value}
                  onChange={() => setMode(m.value)}
                  className="mt-0.5 accent-[var(--accent)]"
                  disabled={submitting}
                />
                <div>
                  <p className="text-xs font-medium text-[var(--fg)]">{m.label}</p>
                  <p className="text-[10px] text-[var(--fg-dim)] mt-0.5 mono">{m.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </Card>

        {error && (
          <Card className="border-red-900/50">
            <p className="text-red-400 text-xs mono">{error}</p>
          </Card>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full px-4 py-2.5 bg-[var(--accent)] text-black text-sm font-semibold rounded hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
              queuing...
            </span>
          ) : (
            "Start audit"
          )}
        </button>
      </form>
    </div>
  );
}
