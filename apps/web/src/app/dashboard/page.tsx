"use client";

import Link from "next/link";
import { useAudits } from "@/lib/hooks";
import {
  StatusBadge,
  SeverityBadge,
  ProgressBar,
  Card,
  repoShortName,
  timeAgo,
} from "@/components/ui";

export default function DashboardPage() {
  const { audits, total, loading, error } = useAudits(4000);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Audits</h1>
          <span className="mono text-[11px] text-[var(--fg-dim)]">{total} total</span>
        </div>
        <Link
          href="/audit/new"
          className="px-3 py-1.5 bg-[var(--accent)] text-black text-xs font-semibold rounded hover:brightness-110 transition-all"
        >
          + new audit
        </Link>
      </div>

      {error && (
        <Card className="mb-4 border-red-900/50">
          <p className="text-red-400 text-xs mono">{error}</p>
        </Card>
      )}

      {loading && audits.length === 0 ? (
        <div className="text-center py-20">
          <div className="inline-block w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          <p className="text-[var(--fg-dim)] text-xs mt-3 mono">loading audits...</p>
        </div>
      ) : audits.length === 0 ? (
        <Card className="text-center py-16">
          <p className="text-[var(--fg-muted)] text-sm mb-4">No audits yet.</p>
          <Link
            href="/audit/new"
            className="px-4 py-2 bg-[var(--accent)] text-black text-xs font-semibold rounded hover:brightness-110 transition-all"
          >
            Run first audit
          </Link>
        </Card>
      ) : (
        <div className="space-y-2">
          {audits.map((audit) => (
            <Link key={audit.id} href={`/audit/${audit.id}`} className="block">
              <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 card-hover cursor-pointer">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <StatusBadge status={audit.status} />
                      <span className="badge badge-info">{audit.mode}</span>
                      <span className="mono text-[10px] text-[var(--fg-dim)]">
                        {timeAgo(audit.createdAt)}
                      </span>
                    </div>
                    <p className="mono text-sm text-[var(--fg)] truncate">
                      {audit.repoSource === "url"
                        ? repoShortName(audit.repoUrl)
                        : "uploaded archive"}
                    </p>

                    {audit.status === "RUNNING" && audit.progress != null && (
                      <div className="mt-3 max-w-sm">
                        <ProgressBar value={audit.progress} stage={audit.stageName} />
                      </div>
                    )}

                    {audit.status === "SUCCEEDED" && audit.summary && (
                      <p className="mono text-[11px] mt-2">
                        {audit.summary.shipReady ? (
                          <span className="text-[var(--accent)]">SHIP</span>
                        ) : (
                          <span className="text-red-400">NO SHIP</span>
                        )}
                        <span className="text-[var(--fg-dim)] mx-1">/</span>
                        <span className="text-[var(--fg-muted)]">
                          {audit._count.findings} finding{audit._count.findings !== 1 ? "s" : ""}
                        </span>
                      </p>
                    )}

                    {audit.status === "FAILED" && (
                      <p className="mono text-[11px] text-red-400 mt-2 truncate">
                        {(audit as any).error ?? "failed"}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1 items-start shrink-0">
                    {audit.findings
                      .filter((f) => ["CRITICAL", "HIGH"].includes(f.severity))
                      .slice(0, 4)
                      .map((f) => (
                        <SeverityBadge key={f.id} severity={f.severity} />
                      ))}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
