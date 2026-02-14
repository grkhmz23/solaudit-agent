"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard", label: "audits" },
  { href: "/audit/new", label: "new" },
  { href: "/settings", label: "config" },
  { href: "/agent", label: "agent" },
];

export function Nav() {
  const pathname = usePathname() ?? "";

  return (
    <header className="border-b border-[var(--border)] bg-[var(--bg)]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center h-12 gap-6">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="relative w-2 h-2 rounded-full bg-[var(--accent)] glow-dot" />
          <span className="mono text-sm font-semibold text-[var(--accent)] tracking-tight">
            solaudit
          </span>
        </Link>

        <div className="h-4 w-px bg-[var(--border)]" />

        <nav className="flex gap-1">
          {links.map((link) => {
            const active = pathname === link.href || 
              (link.href === "/dashboard" && pathname.startsWith("/audit/") && pathname !== "/audit/new");
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`px-2.5 py-1 rounded text-xs mono transition-colors ${
                  active
                    ? "text-[var(--fg)] bg-white/[0.04]"
                    : "text-[var(--fg-muted)] hover:text-[var(--fg-dim)] hover:text-[var(--fg)]"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="flex items-center gap-2 text-[10px] mono text-[var(--fg-dim)]">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] opacity-60" />
          v2.0
        </div>
      </div>
    </header>
  );
}
