"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useAudit, type Finding, type Artifact } from "@/lib/hooks";
import {
  StatusBadge,
  SeverityBadge,
  ProgressBar,
  Card,
  repoShortName,
} from "@/components/ui";
import { GraphViewer } from "@/components/graph-viewer";
import { FindingDetail } from "@/components/finding-detail";

const tabs = ["Summary", "Findings", "Graphs"] as const;
type Tab = (typeof tabs)[number];

export default function AuditDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { audit, loading, error } = useAudit(id);
  const [activeTab, setActiveTab] = useState<Tab>("Summary");
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);

  if (loading) {
    return (
      <Card>
        <p className="text-gray-400 text-center py-16">Loading audit...</p>
      </Card>
    );
  }

  if (error || !audit) {
    return (
      <Card className="border-red-800 bg-red-900/20">
        <p className="text-red-300">{error ?? "Audit not found"}</p>
      </Card>
    );
  }

  const isRunning = audit.status === "RUNNING";
  const graphArtifacts = audit.artifacts.filter((a) => a.type === "GRAPH");

  const severityCounts: Record<string, number> = {};
  for (const f of audit.findings) {
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <StatusBadge status={audit.status} />
          <span className="text-xs px-2 py-0.5 bg-gray-800 rounded text-gray-300">
            {audit.mode}
          </span>
        </div>
        <h1 className="text-xl font-bold font-mono">
          {audit.repoSource === "url"
            ? repoShortName(audit.repoUrl)
            : "Uploaded archive"}
        </h1>
        <p className="text-xs text-gray-500 mt-1">ID: {audit.id}</p>

        {isRunning && audit.progress != null && (
          <div className="mt-4 max-w-lg">
            <ProgressBar value={audit.progress} stage={audit.stageName} />
          </div>
        )}

        {audit.status === "FAILED" && audit.error && (
          <Card className="mt-4 border-red-800 bg-red-900/20">
            <p className="text-red-300 text-sm">{audit.error}</p>
          </Card>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)] mb-6">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setActiveTab(tab);
              setSelectedFinding(null);
            }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-green-500 text-green-300"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab}
            {tab === "Findings" && audit.findings.length > 0 && (
              <span className="ml-1.5 text-xs bg-gray-800 px-1.5 py-0.5 rounded">
                {audit.findings.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "Summary" && (
        <SummaryTab audit={audit} severityCounts={severityCounts} />
      )}
      {activeTab === "Findings" && (
        <FindingsTab
          findings={audit.findings}
          selected={selectedFinding}
          onSelect={setSelectedFinding}
        />
      )}
      {activeTab === "Graphs" && <GraphsTab artifacts={graphArtifacts} />}
    </div>
  );
}

// ── Summary Tab ──
function SummaryTab({
  audit,
  severityCounts,
}: {
  audit: any;
  severityCounts: Record<string, number>;
}) {
  const summary = audit.summary;

  return (
    <div className="space-y-4">
      {summary && (
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div
              className={`w-3 h-3 rounded-full ${
                summary.shipReady ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <h2 className="text-lg font-bold">
              {summary.shipReady ? "SHIP READY" : "DO NOT SHIP"}
            </h2>
          </div>
          <p className="text-gray-300 text-sm mb-4">
            {summary.recommendation}
          </p>

          <div className="grid grid-cols-5 gap-2">
            {(
              ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const
            ).map((sev) => (
              <div
                key={sev}
                className="text-center p-3 rounded bg-gray-900 border border-gray-800"
              >
                <p className="text-2xl font-bold">
                  {severityCounts[sev] ?? 0}
                </p>
                <SeverityBadge severity={sev} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <h3 className="text-sm font-medium text-gray-300 mb-3">Details</h3>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-gray-500">Status</dt>
          <dd>
            <StatusBadge status={audit.status} />
          </dd>
          <dt className="text-gray-500">Mode</dt>
          <dd className="text-gray-300">{audit.mode}</dd>
          <dt className="text-gray-500">Created</dt>
          <dd className="text-gray-300">
            {new Date(audit.createdAt).toLocaleString()}
          </dd>
          {audit.startedAt && (
            <>
              <dt className="text-gray-500">Started</dt>
              <dd className="text-gray-300">
                {new Date(audit.startedAt).toLocaleString()}
              </dd>
            </>
          )}
          {audit.finishedAt && (
            <>
              <dt className="text-gray-500">Finished</dt>
              <dd className="text-gray-300">
                {new Date(audit.finishedAt).toLocaleString()}
              </dd>
            </>
          )}
          {summary && (
            <>
              <dt className="text-gray-500">Framework</dt>
              <dd className="text-gray-300">{summary.framework}</dd>
              <dt className="text-gray-500">Instructions</dt>
              <dd className="text-gray-300">{summary.instructionCount}</dd>
              <dt className="text-gray-500">Account Structs</dt>
              <dd className="text-gray-300">{summary.accountStructCount}</dd>
            </>
          )}
          <dt className="text-gray-500">Artifacts</dt>
          <dd className="text-gray-300">{audit.artifacts.length}</dd>
        </dl>
      </Card>
    </div>
  );
}

// ── Findings Tab ──
function FindingsTab({
  findings,
  selected,
  onSelect,
}: {
  findings: Finding[];
  selected: Finding | null;
  onSelect: (f: Finding | null) => void;
}) {
  const [filterSeverity, setFilterSeverity] = useState<string>("ALL");
  const filtered =
    filterSeverity === "ALL"
      ? findings
      : findings.filter((f) => f.severity === filterSeverity);

  if (selected) {
    return (
      <div>
        <button
          onClick={() => onSelect(null)}
          className="text-sm text-green-400 hover:text-green-300 mb-4 flex items-center gap-1"
        >
          &#8592; Back to findings
        </button>
        <FindingDetail finding={selected} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => (
          <button
            key={s}
            onClick={() => setFilterSeverity(s)}
            className={`px-3 py-1 text-xs rounded border transition-colors ${
              filterSeverity === s
                ? "border-green-700 bg-green-900/30 text-green-300"
                : "border-gray-700 text-gray-400 hover:border-gray-500"
            }`}
          >
            {s}
            {s !== "ALL" && (
              <span className="ml-1">
                ({findings.filter((f) => f.severity === s).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <p className="text-gray-400 text-center py-8">
            No findings match the current filter.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((f) => (
            <Card
              key={f.id}
              className="cursor-pointer hover:border-green-800/50 transition-colors"
            >
              <button
                className="w-full text-left"
                onClick={() => onSelect(f)}
              >
                <div className="flex items-center gap-3 mb-1">
                  <SeverityBadge severity={f.severity} />
                  <span className="text-xs text-gray-500 font-mono">
                    Class {f.classId}
                  </span>
                  <span className="text-xs text-gray-500">
                    {(f.confidence * 100).toFixed(0)}% confidence
                  </span>
                </div>
                <p className="text-sm font-medium text-gray-200">{f.title}</p>
                <p className="text-xs text-gray-500 font-mono mt-1">
                  {f.location.file}:{f.location.line}
                  {f.location.instruction
                    ? ` @ ${f.location.instruction}`
                    : ""}
                </p>
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Graphs Tab ──
function GraphsTab({ artifacts }: { artifacts: Artifact[] }) {
  const [selectedGraph, setSelectedGraph] = useState<string | null>(null);

  if (artifacts.length === 0) {
    return (
      <Card>
        <p className="text-gray-400 text-center py-8">
          No graph data available. Graphs are generated when the audit
          completes.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {artifacts.map((a) => (
          <button
            key={a.id}
            onClick={() =>
              setSelectedGraph(selectedGraph === a.id ? null : a.id)
            }
            className={`px-3 py-1.5 text-sm rounded border transition-colors ${
              selectedGraph === a.id
                ? "border-green-700 bg-green-900/30 text-green-300"
                : "border-gray-700 text-gray-400 hover:border-gray-500"
            }`}
          >
            {a.name}
            <span className="ml-2 text-xs opacity-60">
              {a.metadata?.nodeCount}n / {a.metadata?.edgeCount}e
            </span>
          </button>
        ))}
      </div>

      {selectedGraph && (
        <GraphViewer
          artifact={artifacts.find((a) => a.id === selectedGraph)!}
        />
      )}
    </div>
  );
}
