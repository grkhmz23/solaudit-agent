import Link from "next/link";

const steps = [
  {
    num: "1",
    title: "Submit Repo",
    desc: "Paste a Git URL or upload a zip of any Solana program (Anchor or native Rust).",
  },
  {
    num: "2",
    title: "Automated Scan",
    desc: "15 vulnerability detectors, semantic graph mining, adversarial account synthesis, and constraint checking run in parallel.",
  },
  {
    num: "3",
    title: "Proof Artifacts",
    desc: "Each finding gets an exploit hypothesis, proof plan, delta-testing schema, and optional executable harness.",
  },
  {
    num: "4",
    title: "Fix Plan",
    desc: "Minimal remediation patterns with code snippets, blast-radius analysis, and regression test suggestions.",
  },
];

const detectors = [
  "Missing signer check",
  "Missing owner check",
  "PDA derivation mistakes",
  "Arbitrary CPI target",
  "Type confusion / account substitution",
  "Reinitialization / double-init",
  "Close-then-revive",
  "Unchecked realloc / stale memory",
  "Integer overflow/underflow",
  "State machine violations",
  "Remaining accounts injection",
  "Oracle validation failures",
  "Token account mismatch",
  "Post-CPI stale reads",
  "Duplicate account injection",
];

export default function HomePage() {
  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="text-center pt-12 space-y-6">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          <span className="text-green-400">Solana Audit Agent</span>
        </h1>
        <p className="text-lg text-gray-400 max-w-2xl mx-auto">
          Production-grade automated security auditing for Solana programs.
          Semantic graph mining, 15 vulnerability detectors, adversarial account synthesis,
          proof artifact generation, and fix planning — all in one tool.
        </p>
        <div className="flex gap-4 justify-center">
          <Link
            href="/audit/new"
            className="px-6 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
          >
            Start Audit
          </Link>
          <Link
            href="/dashboard"
            className="px-6 py-2.5 border border-gray-700 hover:border-gray-500 text-gray-300 rounded-lg font-medium transition-colors"
          >
            Dashboard
          </Link>
        </div>
      </section>

      {/* Pipeline Steps */}
      <section className="space-y-6">
        <h2 className="text-2xl font-semibold text-center">How It Works</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {steps.map((s) => (
            <div key={s.num} className="border border-[var(--border)] rounded-lg p-5 bg-[var(--card)]">
              <div className="text-green-400 font-mono text-sm mb-2">Stage {s.num}</div>
              <h3 className="font-semibold text-lg mb-1">{s.title}</h3>
              <p className="text-sm text-gray-400">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Detectors */}
      <section className="space-y-6">
        <h2 className="text-2xl font-semibold text-center">15 Vulnerability Detectors</h2>
        <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-2 max-w-4xl mx-auto">
          {detectors.map((d, i) => (
            <div key={i} className="text-sm border border-[var(--border)] rounded px-3 py-2 bg-[var(--card)] text-gray-300">
              <span className="text-green-500 font-mono mr-1.5">{String(i + 1).padStart(2, "0")}</span>
              {d}
            </div>
          ))}
        </div>
      </section>

      {/* Graphs */}
      <section className="space-y-6 pb-12">
        <h2 className="text-2xl font-semibold text-center">Semantic Graph Analysis</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
          {["Authority Flow", "Token Flow", "State Machine", "PDA Graph"].map((g) => (
            <div key={g} className="text-center border border-[var(--border)] rounded-lg p-4 bg-[var(--card)]">
              <div className="text-green-400 mb-1">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="mx-auto">
                  <circle cx="6" cy="6" r="3" stroke="currentColor" strokeWidth="1.5"/>
                  <circle cx="18" cy="6" r="3" stroke="currentColor" strokeWidth="1.5"/>
                  <circle cx="12" cy="18" r="3" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M8.5 7.5L10.5 16M15.5 7.5L13.5 16M9 6h6" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              </div>
              <div className="font-medium text-sm">{g}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
