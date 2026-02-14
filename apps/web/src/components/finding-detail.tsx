"use client";

import type { Finding } from "@/lib/hooks";
import { SeverityBadge, Card } from "@/components/ui";

function ProofBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    PROVEN: { cls: "bg-emerald-950/80 text-emerald-400 border-emerald-900", label: "PROVEN" },
    LIKELY: { cls: "bg-yellow-950/80 text-yellow-400 border-yellow-900", label: "LIKELY" },
    NEEDS_HUMAN: { cls: "bg-orange-950/80 text-orange-400 border-orange-900", label: "NEEDS REVIEW" },
    REJECTED: { cls: "bg-zinc-900 text-zinc-500 border-zinc-800", label: "REJECTED" },
  };
  const s = map[status] ?? { cls: "bg-zinc-900 text-zinc-400 border-zinc-800", label: status };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

function ExploitabilityBadge({ level }: { level: string }) {
  const map: Record<string, string> = {
    easy: "text-red-400",
    moderate: "text-orange-400",
    hard: "text-yellow-400",
    unknown: "text-zinc-500",
  };
  return (
    <span className={`mono text-[11px] ${map[level] ?? "text-zinc-500"}`}>
      {level}
    </span>
  );
}

export function FindingDetail({ finding }: { finding: Finding }) {
  return (
    <div className="space-y-3">
      {/* Header */}
      <Card>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <SeverityBadge severity={finding.severity} />
          <ProofBadge status={finding.proofStatus} />
          <span className="mono text-[10px] text-[var(--fg-dim)]">
            #{finding.classId} {finding.className}
          </span>
        </div>
        <h2 className="text-sm font-semibold text-[var(--fg)] mb-1">{finding.title}</h2>
        <p className="mono text-[10px] text-[var(--fg-dim)]">
          {finding.location.file}:{finding.location.line}
          {finding.location.instruction ? ` @ ${finding.location.instruction}` : ""}
        </p>
        <div className="mt-3 flex items-center gap-4 text-[11px] mono flex-wrap">
          <span className="text-[var(--fg-dim)]">
            confidence <span className="text-[var(--fg-muted)] font-semibold">{(finding.confidence * 100).toFixed(0)}%</span>
          </span>
          <span className="text-[var(--fg-dim)]">
            exploitability{" "}
            <ExploitabilityBadge level={(finding as any).exploitability ?? "unknown"} />
          </span>
        </div>
      </Card>

      {/* Hypothesis / Impact */}
      {finding.hypothesis && (
        <Card>
          <span className="text-[11px] mono text-[var(--fg-dim)] block mb-2">impact</span>
          <p className="text-xs text-[var(--fg-muted)] leading-relaxed">{finding.hypothesis}</p>
        </Card>
      )}

      {/* LLM Reasoning (V2) */}
      {(finding as any).reasoning && (
        <Card>
          <span className="text-[11px] mono text-[var(--fg-dim)] block mb-2">LLM analysis</span>
          <p className="text-xs text-[var(--fg-muted)] leading-relaxed whitespace-pre-wrap">{(finding as any).reasoning}</p>
        </Card>
      )}

      {/* Proof Plan */}
      {finding.proofPlan && (
        <Card>
          <span className="text-[11px] mono text-[var(--fg-dim)] block mb-3">proof plan</span>

          {finding.proofPlan.steps && (
            <ol className="list-decimal list-inside space-y-1.5 text-xs text-[var(--fg-muted)] mb-4">
              {finding.proofPlan.steps.map((step: string, i: number) => (
                <li key={i} className="leading-relaxed">{step}</li>
              ))}
            </ol>
          )}

          {finding.proofPlan.harnessType && (
            <p className="text-[10px] mono text-[var(--fg-dim)] mb-2">
              harness: <span className="text-[var(--fg-muted)]">{finding.proofPlan.harnessType}</span>
            </p>
          )}

          {finding.proofPlan.deltaSchema && (
            <div className="mt-3 p-3 bg-[var(--bg)] rounded border border-[var(--border)] text-[10px] mono">
              <p className="text-[var(--fg-dim)] mb-1">delta schema</p>
              <p className="text-[var(--fg-muted)]">pre: {JSON.stringify(finding.proofPlan.deltaSchema.preState)}</p>
              <p className="text-[var(--fg-muted)]">post: {JSON.stringify(finding.proofPlan.deltaSchema.postState)}</p>
              <p className="text-[var(--accent)] mt-1">assert: {finding.proofPlan.deltaSchema.assertion}</p>
            </div>
          )}

          {finding.proofPlan.harness && (
            <details className="mt-3">
              <summary className="text-[10px] mono text-[var(--accent)] cursor-pointer hover:brightness-110">
                view harness code
              </summary>
              <pre className="mt-2 p-3 bg-[var(--bg)] rounded border border-[var(--border)] text-[10px] mono text-[var(--fg-muted)] overflow-x-auto whitespace-pre-wrap">
                {finding.proofPlan.harness}
              </pre>
            </details>
          )}

          {finding.proofPlan.requiredCommands && finding.proofPlan.requiredCommands.length > 0 && (
            <div className="mt-3 text-[10px] mono text-[var(--fg-dim)]">
              <p>required commands:</p>
              <ul className="list-disc list-inside mt-1">
                {finding.proofPlan.requiredCommands.map((cmd: string, i: number) => (
                  <li key={i} className="text-[var(--fg-muted)]">{cmd}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {/* Fix Plan */}
      {finding.fixPlan && (
        <Card>
          <span className="text-[11px] mono text-[var(--fg-dim)] block mb-2">remediation</span>
          <p className="text-xs text-[var(--fg-muted)] mb-3 leading-relaxed">{finding.fixPlan.description}</p>

          {finding.fixPlan.code && (
            <pre className="p-3 bg-[var(--bg)] rounded border border-[var(--border)] text-[10px] mono text-[var(--fg-muted)] overflow-x-auto whitespace-pre-wrap">
              {finding.fixPlan.code}
            </pre>
          )}

          {finding.fixPlan.regressionTests && finding.fixPlan.regressionTests.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] mono text-[var(--fg-dim)] mb-1">regression tests:</p>
              <ul className="list-disc list-inside text-[10px] text-[var(--fg-muted)]">
                {finding.fixPlan.regressionTests.map((t: string, i: number) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {/* Blast Radius */}
      {finding.blastRadius && (
        <Card>
          <span className="text-[11px] mono text-[var(--fg-dim)] block mb-2">blast radius</span>
          {finding.blastRadius.affectedAccounts?.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] mono text-[var(--fg-dim)]">accounts:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {finding.blastRadius.affectedAccounts.map((a: string, i: number) => (
                  <span key={i} className="text-[10px] mono px-1.5 py-0.5 bg-[var(--bg)] rounded border border-[var(--border)] text-[var(--fg-muted)]">{a}</span>
                ))}
              </div>
            </div>
          )}
          {finding.blastRadius.affectedInstructions?.length > 0 && (
            <div>
              <p className="text-[10px] mono text-[var(--fg-dim)]">instructions:</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {finding.blastRadius.affectedInstructions.map((ix: string, i: number) => (
                  <span key={i} className="text-[10px] mono px-1.5 py-0.5 bg-[var(--bg)] rounded border border-[var(--border)] text-[var(--fg-muted)]">{ix}</span>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
