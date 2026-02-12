"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useAudit, getArtifactUrl, type Finding, type Artifact } from "@/lib/hooks";
import { StatusBadge, SeverityBadge, ProgressBar, Card, repoShortName } from "@/components/ui";
import { FindingDetail } from "@/components/finding-detail";
import { GraphViewer } from "@/components/graph-viewer";

type Tab = "summary" | "findings" | "graphs" | "artifacts";

export default function AuditDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { audit, loading, error } = useAudit(id);
  const [tab, setTab] = useState<Tab>("summary");
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);

  if (loading) {
    return (
      <div className="text-center py-20">
        <div className="inline-block w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        <p className="text-[var(--fg-dim)] text-xs mt-3 mono">loading audit...</p>
      </div>
    );
  }

  if (error || !audit) {
    return (
      <Card className="border-red-900/50">
        <p className="text-red-400 text-xs mono">{error ?? "Audit not found"}</p>
      </Card>
    );
  }

  const isRunning = audit.status === "RUNNING";
  const graphArtifacts = audit.artifacts.filter((a) => a.type === "GRAPH");
  const reportArtifacts = audit.artifacts.filter((a) => a.type === "REPORT");

  const severityCounts: Record<string, number> = {};
  for (const f of audit.findings) {
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "summary", label: "summary" },
    { id: "findings", label: "findings", count: audit.findings.length },
    { id: "graphs", label: "graphs", count: graphArtifacts.length },
    { id: "artifacts", label: "artifacts", count: audit.artifacts.length },
  ];

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <StatusBadge status={audit.status} />
          <span className="badge badge-info">{audit.mode}</span>
        </div>
        <h1 className="text-lg font-semibold mono">
          {audit.repoSource === "url" ? repoShortName(audit.repoUrl) : "uploaded archive"}
        </h1>
        <p className="mono text-[10px] text-[var(--fg-dim)] mt-1">{audit.id}</p>

        {isRunning && audit.progress != null && (
          <div className="mt-4 max-w-md">
            <ProgressBar value={audit.progress} stage={audit.stageName} />
          </div>
        )}

        {audit.status === "FAILED" && audit.error && (
          <Card className="mt-4 border-red-900/50">
            <p className="text-red-400 text-xs mono">{audit.error}</p>
          </Card>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-px border-b border-[var(--border)] mb-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setSelectedFinding(null); }}
            className={`px-3 py-2 text-xs mono transition-colors border-b -mb-px ${
              tab === t.id
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--fg-dim)] hover:text-[var(--fg-muted)]"
            }`}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg)] text-[var(--fg-dim)]">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "summary" && <SummaryTab audit={audit} counts={severityCounts} />}
      {tab === "findings" && <FindingsTab findings={audit.findings} selected={selectedFinding} onSelect={setSelectedFinding} />}
      {tab === "graphs" && <GraphsTab artifacts={graphArtifacts} />}
      {tab === "artifacts" && <ArtifactsTab artifacts={audit.artifacts} />}
    </div>
  );
}

function SummaryTab({ audit, counts }: { audit: any; counts: Record<string, number> }) {
  const s = audit.summary;
  return (
    <div className="space-y-4">
      {s && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <div className={`w-2 h-2 rounded-full ${s.shipReady ? "bg-[var(--accent)]" : "bg-red-400"}`} />
            <span className="text-sm font-semibold mono">
              {s.shipReady ? "SHIP" : "DO NOT SHIP"}
            </span>
          </div>
          <p className="text-xs text-[var(--fg-muted)] mb-4">{s.recommendation}</p>
          <div className="grid grid-cols-5 gap-1.5">
            {(["CRITICAL","HIGH","MEDIUM","LOW","INFO"] as const).map((sev) => (
              <div key={sev} className="text-center p-2 rounded bg-[var(--bg)] border border-[var(--border)]">
                <p className="text-lg font-bold mono">{counts[sev] ?? 0}</p>
                <SeverityBadge severity={sev} />
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <span className="text-xs mono text-[var(--fg-muted)] block mb-3">details</span>
        <dl className="grid grid-cols-2 gap-y-2 text-xs">
          <dt className="text-[var(--fg-dim)] mono">status</dt>
          <dd><StatusBadge status={audit.status} /></dd>
          <dt className="text-[var(--fg-dim)] mono">mode</dt>
          <dd className="text-[var(--fg-muted)]">{audit.mode}</dd>
          <dt className="text-[var(--fg-dim)] mono">created</dt>
          <dd className="text-[var(--fg-muted)] mono">{new Date(audit.createdAt).toLocaleString()}</dd>
          {audit.startedAt && (<><dt className="text-[var(--fg-dim)] mono">started</dt><dd className="text-[var(--fg-muted)] mono">{new Date(audit.startedAt).toLocaleString()}</dd></>)}
          {audit.finishedAt && (<><dt className="text-[var(--fg-dim)] mono">finished</dt><dd className="text-[var(--fg-muted)] mono">{new Date(audit.finishedAt).toLocaleString()}</dd></>)}
          {s && (<>
            <dt className="text-[var(--fg-dim)] mono">framework</dt><dd className="text-[var(--fg-muted)]">{s.framework}</dd>
            <dt className="text-[var(--fg-dim)] mono">instructions</dt><dd className="text-[var(--fg-muted)]">{s.instructionCount}</dd>
            <dt className="text-[var(--fg-dim)] mono">account structs</dt><dd className="text-[var(--fg-muted)]">{s.accountStructCount}</dd>
          </>)}
          <dt className="text-[var(--fg-dim)] mono">artifacts</dt>
          <dd className="text-[var(--fg-muted)]">{audit.artifacts.length}</dd>
        </dl>
      </Card>
    </div>
  );
}

function FindingsTab({ findings, selected, onSelect }: { findings: Finding[]; selected: Finding | null; onSelect: (f: Finding | null) => void }) {
  const [filter, setFilter] = useState("ALL");
  const filtered = filter === "ALL" ? findings : findings.filter((f) => f.severity === filter);

  if (selected) {
    return (
      <div>
        <button onClick={() => onSelect(null)} className="text-xs mono text-[var(--accent)] hover:brightness-110 mb-4 flex items-center gap-1">
          &#8592; back
        </button>
        <FindingDetail finding={selected} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {["ALL","CRITICAL","HIGH","MEDIUM","LOW","INFO"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-2.5 py-1 text-[11px] mono rounded border transition-colors ${
              filter === s
                ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--fg-dim)] hover:text-[var(--fg-muted)]"
            }`}
          >
            {s}{s !== "ALL" && ` (${findings.filter((f) => f.severity === s).length})`}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <Card><p className="text-[var(--fg-dim)] text-center text-xs mono py-8">no findings match filter</p></Card>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((f) => (
            <div
              key={f.id}
              onClick={() => onSelect(f)}
              className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg px-4 py-3 card-hover cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-1">
                <SeverityBadge severity={f.severity} />
                <span className="mono text-[10px] text-[var(--fg-dim)]">#{f.classId}</span>
                <span className="mono text-[10px] text-[var(--fg-dim)]">{(f.confidence * 100).toFixed(0)}%</span>
              </div>
              <p className="text-xs text-[var(--fg)]">{f.title}</p>
              <p className="mono text-[10px] text-[var(--fg-dim)] mt-1">
                {f.location.file}:{f.location.line}
                {f.location.instruction ? ` @ ${f.location.instruction}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GraphsTab({ artifacts }: { artifacts: Artifact[] }) {
  const [sel, setSel] = useState<string | null>(null);

  if (artifacts.length === 0) {
    return <Card><p className="text-[var(--fg-dim)] text-center text-xs mono py-8">no graphs available</p></Card>;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 flex-wrap">
        {artifacts.map((a) => (
          <button
            key={a.id}
            onClick={() => setSel(sel === a.id ? null : a.id)}
            className={`px-2.5 py-1 text-[11px] mono rounded border transition-colors ${
              sel === a.id
                ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--fg-dim)] hover:text-[var(--fg-muted)]"
            }`}
          >
            {a.name}
          </button>
        ))}
      </div>
      {sel && <GraphViewer artifact={artifacts.find((a) => a.id === sel)!} />}
    </div>
  );
}

function ArtifactsTab({ artifacts }: { artifacts: Artifact[] }) {
  const [downloading, setDownloading] = useState<string | null>(null);

  const download = async (id: string) => {
    setDownloading(id);
    try {
      const data = await getArtifactUrl(id);
      window.open(data.url, "_blank");
    } catch (e) {
      console.error(e);
    } finally {
      setDownloading(null);
    }
  };

  if (artifacts.length === 0) {
    return <Card><p className="text-[var(--fg-dim)] text-center text-xs mono py-8">no artifacts</p></Card>;
  }

  return (
    <div className="space-y-1.5">
      {artifacts.map((a) => (
        <div key={a.id} className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-xs text-[var(--fg)]">{a.name}</p>
            <p className="mono text-[10px] text-[var(--fg-dim)] mt-0.5">
              {a.type} / {a.contentType} / {a.sizeBytes ? `${(a.sizeBytes / 1024).toFixed(1)}KB` : "?"}
            </p>
          </div>
          <button
            onClick={() => download(a.id)}
            disabled={downloading === a.id}
            className="px-2.5 py-1 text-[11px] mono border border-[var(--border)] rounded text-[var(--fg-muted)] hover:text-[var(--fg)] hover:border-[var(--border-hover)] transition-colors disabled:opacity-40"
          >
            {downloading === a.id ? "..." : "download"}
          </button>
        </div>
      ))}
    </div>
  );
}
