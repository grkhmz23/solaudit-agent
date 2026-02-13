"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center">
      <h1 className="text-4xl font-bold mono text-red-400">Error</h1>
      <p className="text-sm text-[var(--fg-muted)] mt-2">Something went wrong</p>
      <button
        onClick={() => reset()}
        className="mt-6 px-4 py-2 bg-[var(--accent)] text-black text-xs font-semibold rounded hover:brightness-110 transition-all"
      >
        Try again
      </button>
    </div>
  );
}
