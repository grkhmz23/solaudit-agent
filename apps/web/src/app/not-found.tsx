"use client";

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center">
      <h1 className="text-4xl font-bold mono text-[var(--fg)]">404</h1>
      <p className="text-sm text-[var(--fg-muted)] mt-2">Page not found</p>
      <Link
        href="/"
        className="mt-6 px-4 py-2 bg-[var(--accent)] text-black text-xs font-semibold rounded hover:brightness-110 transition-all"
      >
        Go home
      </Link>
    </div>
  );
}
