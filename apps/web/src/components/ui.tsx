"use client";

const severityMap: Record<string, string> = {
  CRITICAL: "badge-critical",
  HIGH: "badge-high",
  MEDIUM: "badge-medium",
  LOW: "badge-low",
  INFO: "badge-info",
};

const statusMap: Record<string, { cls: string; dot?: string }> = {
  QUEUED: { cls: "bg-zinc-900 text-zinc-400 border-zinc-800" },
  RUNNING: { cls: "bg-blue-950/80 text-blue-400 border-blue-900", dot: "bg-blue-400" },
  SUCCEEDED: { cls: "bg-emerald-950/80 text-emerald-400 border-emerald-900" },
  FAILED: { cls: "bg-red-950/80 text-red-400 border-red-900" },
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`badge ${severityMap[severity] ?? "badge-info"}`}>
      {severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const s = statusMap[status] ?? statusMap.QUEUED;
  return (
    <span className={`badge ${s.cls}`}>
      {s.dot && <span className={`w-1.5 h-1.5 rounded-full ${s.dot} mr-1.5 animate-pulse`} />}
      {status}
    </span>
  );
}

export function ProgressBar({ value, stage }: { value: number; stage?: string | null }) {
  return (
    <div className="w-full">
      <div className="flex justify-between text-[10px] mono text-[var(--fg-dim)] mb-1">
        <span>{stage ?? "..."}</span>
        <span>{value}%</span>
      </div>
      <div className="w-full bg-[var(--border)] rounded-full h-1">
        <div
          className={`h-1 rounded-full transition-all duration-700 ${value < 100 ? "progress-shimmer" : "bg-[var(--accent)]"}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 ${className}`}>
      {children}
    </div>
  );
}

export function repoShortName(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return url && url.length > 60 ? url.slice(0, 57) + "..." : url || "unknown";
  }
}

export function timeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
