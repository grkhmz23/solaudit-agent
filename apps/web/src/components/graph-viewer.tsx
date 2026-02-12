"use client";

import { useState, useEffect, useMemo } from "react";
import type { Artifact } from "@/lib/hooks";
import { Card } from "@/components/ui";

interface GNode { id: string; label: string; type: string; metadata?: Record<string, any>; }
interface GEdge { source: string; target: string; label: string; metadata?: Record<string, any>; }
interface GraphData { name: string; nodes: GNode[]; edges: GEdge[]; }

const NODE_COLORS: Record<string, string> = {
  signer: "#00ff88", account: "#3388ff", program: "#aa66ff",
  instruction: "#ffaa00", state: "#ff66aa", pda: "#00ccaa",
  token: "#ff8833", default: "#555",
};

function layout(nodes: GNode[]) {
  const W = 800, H = 500, PAD = 60;
  const pos: Record<string, { x: number; y: number }> = {};
  if (nodes.length <= 12) {
    const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - PAD;
    nodes.forEach((n, i) => {
      const a = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      pos[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
  } else {
    const cols = Math.ceil(Math.sqrt(nodes.length));
    const cw = (W - PAD * 2) / cols;
    const ch = (H - PAD * 2) / Math.max(Math.ceil(nodes.length / cols), 1);
    nodes.forEach((n, i) => {
      pos[n.id] = { x: PAD + (i % cols) * cw + cw / 2, y: PAD + Math.floor(i / cols) * ch + ch / 2 };
    });
  }
  return { pos, W, H };
}

export function GraphViewer({ artifact }: { artifact: Artifact }) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [view, setView] = useState<"graph" | "list">("graph");
  const [filterType, setFilterType] = useState("ALL");

  useEffect(() => {
    const m = artifact.metadata;
    if (m?.nodes && m?.edges) {
      setGraph({ name: artifact.name, nodes: m.nodes as GNode[], edges: m.edges as GEdge[] });
    } else {
      setGraph({ name: artifact.name, nodes: [], edges: [] });
    }
  }, [artifact]);

  const types = useMemo(() => {
    if (!graph) return [];
    return ["ALL", ...new Set(graph.nodes.map((n) => n.type))];
  }, [graph]);

  const fNodes = useMemo(() => {
    if (!graph) return [];
    return filterType === "ALL" ? graph.nodes : graph.nodes.filter((n) => n.type === filterType);
  }, [graph, filterType]);

  const fEdges = useMemo(() => {
    if (!graph) return [];
    const ids = new Set(fNodes.map((n) => n.id));
    return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }, [graph, fNodes]);

  if (!graph || graph.nodes.length === 0) {
    return (
      <Card>
        <p className="mono text-[10px] text-[var(--fg-dim)]">{artifact.name}: no graph data</p>
      </Card>
    );
  }

  const { pos, W, H } = layout(fNodes);

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <span className="mono text-[11px] text-[var(--fg-muted)]">{graph.name}</span>
        <div className="flex gap-2">
          <div className="flex gap-1">
            {types.map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-1.5 py-0.5 text-[10px] mono rounded border transition-colors ${
                  filterType === t
                    ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--fg-dim)]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex border border-[var(--border)] rounded overflow-hidden">
            {(["graph", "list"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-1.5 py-0.5 text-[10px] mono ${view === v ? "bg-[var(--border)] text-[var(--fg)]" : "text-[var(--fg-dim)]"}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === "graph" ? (
        <div className="bg-[var(--bg)] rounded border border-[var(--border)] overflow-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: 300, maxHeight: 500 }}>
            <defs>
              <marker id="ah" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#333" />
              </marker>
            </defs>
            {fEdges.map((e, i) => {
              const a = pos[e.source], b = pos[e.target];
              if (!a || !b) return null;
              return (
                <g key={`e${i}`}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#222" strokeWidth={1} markerEnd="url(#ah)" />
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 5} textAnchor="middle" fill="#444" fontSize={8} fontFamily="monospace">
                    {e.label}
                  </text>
                </g>
              );
            })}
            {fNodes.map((n) => {
              const p = pos[n.id];
              if (!p) return null;
              const c = NODE_COLORS[n.type] ?? NODE_COLORS.default;
              return (
                <g key={n.id}>
                  <circle cx={p.x} cy={p.y} r={14} fill={c + "22"} stroke={c} strokeWidth={1} />
                  <text x={p.x} y={p.y + 24} textAnchor="middle" fill="#888" fontSize={9} fontFamily="monospace">
                    {n.label.length > 16 ? n.label.slice(0, 13) + "..." : n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="mono text-[10px] text-[var(--fg-dim)] mb-1.5 uppercase tracking-wider">nodes ({fNodes.length})</p>
            <div className="grid gap-0.5">
              {fNodes.map((n) => (
                <div key={n.id} className="flex items-center gap-2 text-[10px] py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[n.type] ?? NODE_COLORS.default }} />
                  <span className="mono text-[var(--fg-dim)]">{n.type}</span>
                  <span className="text-[var(--fg-muted)]">{n.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mono text-[10px] text-[var(--fg-dim)] mb-1.5 uppercase tracking-wider">edges ({fEdges.length})</p>
            <div className="grid gap-0.5">
              {fEdges.map((e, i) => (
                <div key={i} className="text-[10px] py-0.5 text-[var(--fg-muted)]">
                  <span className="mono text-[var(--fg)]">{e.source}</span>
                  <span className="mx-1.5 text-[var(--fg-dim)]">-&gt;</span>
                  <span className="mono text-[var(--fg)]">{e.target}</span>
                  <span className="ml-1.5 text-[var(--fg-dim)]">[{e.label}]</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
