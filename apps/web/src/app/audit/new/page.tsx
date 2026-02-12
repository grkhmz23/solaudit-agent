"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAudit } from "@/lib/hooks";
import { Card } from "@/components/ui";

const modes = [
  {
    value: "SCAN",
    label: "Scan",
    desc: "Static analysis, graph mining, and vulnerability detection",
  },
  {
    value: "PROVE",
    label: "Prove",
    desc: "Generate proof-of-concept harnesses (requires toolchain on worker)",
  },
  {
    value: "FIX_PLAN",
    label: "Fix Plan",
    desc: "Full scan + remediation plan with code snippets and regression tests",
  },
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
      setError("Please enter a repository URL.");
      return;
    }

    try {
      new URL(repoUrl);
    } catch {
      setError("Please enter a valid URL.");
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
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">New Audit</h1>

      <form onSubmit={handleSubmit}>
        <Card className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Repository URL
          </label>
          <input
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/solana-program.git"
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-green-600 transition-colors"
            disabled={submitting}
          />
          <p className="text-xs text-gray-500 mt-2">
            Public HTTPS Git URL. Private repos require GITHUB_TOKEN on the
            worker.
          </p>
        </Card>

        <Card className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            Audit Mode
          </label>
          <div className="space-y-2">
            {modes.map((m) => (
              <label
                key={m.value}
                className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
                  mode === m.value
                    ? "border-green-700 bg-green-900/20"
                    : "border-gray-700 hover:border-gray-600"
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={mode === m.value}
                  onChange={() => setMode(m.value)}
                  className="mt-0.5 accent-green-500"
                  disabled={submitting}
                />
                <div>
                  <p className="text-sm font-medium text-gray-200">
                    {m.label}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{m.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </Card>

        {error && (
          <Card className="mb-4 border-red-800 bg-red-900/20">
            <p className="text-red-300 text-sm">{error}</p>
          </Card>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full px-4 py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-400 text-white font-medium rounded transition-colors"
        >
          {submitting ? "Queuing audit..." : "Start Audit"}
        </button>
      </form>
    </div>
  );
}
