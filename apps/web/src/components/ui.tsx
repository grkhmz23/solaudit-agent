"use client";

const severityColors: Record<string, string> = {
  CRITICAL: "bg-red-900/50 text-red-300 border-red-800",
  HIGH: "bg-orange-900/50 text-orange-300 border-orange-800",
  MEDIUM: "bg-yellow-900/50 text-yellow-300 border-yellow-800",
  LOW: "bg-blue-900/50 text-blue-300 border-blue-800",
  INFO: "bg-gray-800/50 text-gray-300 border-gray-700",
};

const statusColors: Record<string, string> = {
  QUEUED: "bg-gray-800/50 text-gray-300 border-gray-700",
  RUNNING: "bg-blue-900/50 text-blue-300 border-blue-800",
  SUCCEEDED: "bg-green-900/50 text-green-300 border-green-800",
  FAILED: "bg-red-900/50 text-red-300 border-red-800",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
        severityColors[severity] ?? severityColors.INFO
      }`}
    >
      {severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
        statusColors[status] ?? statusColors.QUEUED
      }`}
    >
      {status === "RUNNING" && (
        <span className="w-1.5 h-1.5 bg-blue-400 rounded-full mr-1.5 animate-pulse" />
      )}
      {status}
    </span>
  );
}

export function ProgressBar({ value, stage }: { value: number; stage?: string | null }) {
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{stage ?? "..."}</span>
        <span>{value}%</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-1.5">
        <div
          className="bg-green-500 h-1.5 rounded-full transition-all duration-500"
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
    <div className={`bg-[var(--card)] border border-[var(--border)] rounded-lg p-5 ${className}`}>
      {children}
    </div>
  );
}

export function repoShortName(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return url.length > 60 ? url.slice(0, 57) + "..." : url;
  }
}

export function timeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
