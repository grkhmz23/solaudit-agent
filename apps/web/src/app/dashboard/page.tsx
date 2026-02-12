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
        <div>
          <h1 className="text-2xl font-bold">Audits</h1>
          <p className="text-sm text-gray-400 mt-1">
            {total} total audit{total !== 1 ? "s" : ""}
          </p>
        </div>
        <Link
          href="/audit/new"
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded transition-colors"
        >
          + New Audit
        </Link>
      </div>

      {error && (
        <Card className="mb-4 border-red-800 bg-red-900/20">
          <p className="text-red-300 text-sm">{error}</p>
        </Card>
      )}

      {loading && audits.length === 0 ? (
        <Card>
          <p className="text-gray-400 text-center py-12">Loading audits...</p>
        </Card>
      ) : audits.length === 0 ? (
        <Card>
          <div className="text-center py-16">
            <div className="text-4xl mb-3 opacity-40">&#128270;</div>
            <p className="text-gray-400 mb-4">No audits yet</p>
            <Link
              href="/audit/new"
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded transition-colors"
            >
              Run Your First Audit
            </Link>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {audits.map((audit) => (
            <Link key={audit.id} href={`/audit/${audit.id}`}>
              <Card className="hover:border-green-800/50 transition-colors cursor-pointer">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <StatusBadge status={audit.status} />
                      <span className="text-xs px-2 py-0.5 bg-gray-800 rounded text-gray-300">
                        {audit.mode}
                      </span>
                      <span className="text-xs text-gray-500">
                        {timeAgo(audit.createdAt)}
                      </span>
                    </div>
                    <p className="font-mono text-sm text-gray-200 truncate">
                      {audit.repoSource === "url"
                        ? repoShortName(audit.repoUrl)
                        : "Uploaded archive"}
                    </p>

                    {audit.status === "RUNNING" &&
                      audit.progress != null && (
                        <div className="mt-3 max-w-md">
                          <ProgressBar
                            value={audit.progress}
                            stage={audit.stageName}
                          />
                        </div>
                      )}

                    {audit.status === "SUCCEEDED" && audit.summary && (
                      <p className="text-xs text-gray-400 mt-2">
                        {audit.summary.shipReady ? (
                          <span className="text-green-400">SHIP READY</span>
                        ) : (
                          <span className="text-red-400">DO NOT SHIP</span>
                        )}
                        {" — "}
                        {audit._count.findings} finding
                        {audit._count.findings !== 1 ? "s" : ""}
                      </p>
                    )}

                    {audit.status === "FAILED" && (
                      <p className="text-xs text-red-400 mt-2 truncate">
                        {(audit as any).error ?? "Audit failed"}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5 items-start">
                    {audit.findings
                      .filter((f) =>
                        ["CRITICAL", "HIGH"].includes(f.severity)
                      )
                      .slice(0, 5)
                      .map((f) => (
                        <SeverityBadge key={f.id} severity={f.severity} />
                      ))}
                    {audit._count.findings > 0 && (
                      <span className="text-xs text-gray-500 self-center ml-1">
                        {audit._count.findings} total
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
