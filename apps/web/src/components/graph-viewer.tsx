"use client";

import { useState, useEffect, useMemo } from "react";
import type { Artifact } from "@/lib/hooks";
import { Card } from "@/components/ui";

interface GraphNode {
  id: string;
  label: string;
  type: string;
  metadata?: Record<string, any>;
}

interface GraphEdge {
  source: string;
  target: string;
  label: string;
  metadata?: Record<string, any>;
}

interface GraphData {
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Simple force-directed layout (very lightweight)
function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  const W = 800;
  const H = 500;
  const PADDING = 60;

  // Arrange in a circle or grid depending on count
  const positions: Record<string, { x: number; y: number }> = {};

  if (nodes.length <= 12) {
    // Circle layout
    const cx = W / 2;
    const cy = H / 2;
    const radius = Math.min(W, H) / 2 - PADDING;
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
      positions[n.id] = {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    });
  } else {
    // Grid layout
    const cols = Math.ceil(Math.sqrt(nodes.length));
    const cellW = (W - PADDING * 2) / cols;
    const rows = Math.ceil(nodes.length / cols);
    const cellH = (H - PADDING * 2) / Math.max(rows, 1);
    nodes.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions[n.id] = {
        x: PADDING + col * cellW + cellW / 2,
        y: PADDING + row * cellH + cellH / 2,
      };
    });
  }

  return { positions, width: W, height: H };
}

const nodeColors: Record<string, string> = {
  signer: "#22c55e",
  account: "#3b82f6",
  program: "#a855f7",
  instruction: "#f59e0b",
  state: "#ec4899",
  pda: "#14b8a6",
  token: "#f97316",
  default: "#6b7280",
};

export function GraphViewer({ artifact }: { artifact: Artifact }) {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"svg" | "list">("svg");
  const [filterType, setFilterType] = useState<string>("ALL");

  useEffect(() => {
    if (artifact.metadata?.nodes && artifact.metadata?.edges) {
      setGraph({
        name: artifact.name,
        nodes: artifact.metadata.nodes as GraphNode[],
        edges: artifact.metadata.edges as GraphEdge[],
      });
      setLoading(false);
    } else {
      setGraph({ name: artifact.name, nodes: [], edges: [] });
      setLoading(false);
    }
  }, [artifact]);

  const nodeTypes = useMemo(() => {
    if (!graph) return [];
    const types = new Set(graph.nodes.map((n) => n.type));
    return ["ALL", ...Array.from(types)];
  }, [graph]);

  const filteredNodes = useMemo(() => {
    if (!graph) return [];
    return filterType === "ALL"
      ? graph.nodes
      : graph.nodes.filter((n) => n.type === filterType);
  }, [graph, filterType]);

  const filteredEdges = useMemo(() => {
    if (!graph) return [];
    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    return graph.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
    );
  }, [graph, filteredNodes]);

  if (loading) {
    return (
      <Card>
        <p className="text-gray-400 text-center py-8">Loading graph...</p>
      </Card>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <Card>
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          {artifact.name}
        </h3>
        <p className="text-gray-500 text-sm">
          {artifact.metadata?.nodeCount ?? 0} nodes,{" "}
          {artifact.metadata?.edgeCount ?? 0} edges
        </p>
        <p className="text-gray-500 text-xs mt-2">
          Graph visualization available when viewing full artifact data.
        </p>
      </Card>
    );
  }

  const layout = layoutGraph(filteredNodes, filteredEdges);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-300">{graph.name}</h3>
        <div className="flex gap-2">
          <div className="flex gap-1">
            {nodeTypes.map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                  filterType === t
                    ? "border-green-700 bg-green-900/30 text-green-300"
                    : "border-gray-700 text-gray-500 hover:text-gray-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex border border-gray-700 rounded overflow-hidden">
            <button
              onClick={() => setView("svg")}
              className={`px-2 py-0.5 text-xs ${
                view === "svg"
                  ? "bg-gray-700 text-gray-200"
                  : "text-gray-500"
              }`}
            >
              Graph
            </button>
            <button
              onClick={() => setView("list")}
              className={`px-2 py-0.5 text-xs ${
                view === "list"
                  ? "bg-gray-700 text-gray-200"
                  : "text-gray-500"
              }`}
            >
              List
            </button>
          </div>
        </div>
      </div>

      {view === "svg" ? (
        <div className="bg-gray-900 rounded border border-gray-800 overflow-auto">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="w-full"
            style={{ minHeight: 300, maxHeight: 500 }}
          >
            {/* Edges */}
            {filteredEdges.map((e, i) => {
              const from = layout.positions[e.source];
              const to = layout.positions[e.target];
              if (!from || !to) return null;
              return (
                <g key={`e-${i}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="#374151"
                    strokeWidth={1.5}
                    markerEnd="url(#arrowhead)"
                  />
                  <text
                    x={(from.x + to.x) / 2}
                    y={(from.y + to.y) / 2 - 6}
                    textAnchor="middle"
                    fill="#6b7280"
                    fontSize={9}
                  >
                    {e.label}
                  </text>
                </g>
              );
            })}

            {/* Arrow marker */}
            <defs>
              <marker
                id="arrowhead"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#374151" />
              </marker>
            </defs>

            {/* Nodes */}
            {filteredNodes.map((n) => {
              const pos = layout.positions[n.id];
              if (!pos) return null;
              const color = nodeColors[n.type] ?? nodeColors.default;
              return (
                <g key={n.id}>
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={16}
                    fill={color + "33"}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                  <text
                    x={pos.x}
                    y={pos.y + 28}
                    textAnchor="middle"
                    fill="#d1d5db"
                    fontSize={10}
                  >
                    {n.label.length > 18
                      ? n.label.slice(0, 15) + "..."
                      : n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <h4 className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
              Nodes ({filteredNodes.length})
            </h4>
            <div className="grid gap-1">
              {filteredNodes.map((n) => (
                <div
                  key={n.id}
                  className="flex items-center gap-2 text-xs py-1"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{
                      backgroundColor:
                        nodeColors[n.type] ?? nodeColors.default,
                    }}
                  />
                  <span className="text-gray-400 font-mono">{n.type}</span>
                  <span className="text-gray-200">{n.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
              Edges ({filteredEdges.length})
            </h4>
            <div className="grid gap-1">
              {filteredEdges.map((e, i) => (
                <div key={i} className="text-xs py-1 text-gray-400">
                  <span className="font-mono text-gray-300">{e.source}</span>
                  <span className="mx-2 text-gray-600">→</span>
                  <span className="font-mono text-gray-300">{e.target}</span>
                  <span className="ml-2 text-gray-500">[{e.label}]</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
