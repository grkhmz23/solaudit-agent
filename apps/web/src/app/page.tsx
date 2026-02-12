"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

const CLASSES = [
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

const PIPELINE = [
  { id: "parse", label: "Parse & AST", time: "~2s" },
  { id: "detect", label: "15 Detectors", time: "~8s" },
  { id: "graph", label: "Graph Mining", time: "~3s" },
  { id: "adversarial", label: "Adversarial Synth", time: "~4s" },
  { id: "proof", label: "Proof Plans", time: "~5s" },
  { id: "fix", label: "Remediation", time: "~3s" },
  { id: "report", label: "Report Gen", time: "~1s" },
];

function TerminalBlock() {
  const [lines, setLines] = useState<string[]>([]);
  const allLines = [
    "$ solaudit scan --repo anchor-escrow",
    "[parse] anchor framework detected",
    "[parse] 4 instructions, 6 account structs",
    "[detect] running 15 vulnerability detectors...",
    "[detect] CRITICAL: missing signer check @ initialize:L42",
    "[detect] HIGH: PDA seed mismatch @ withdraw:L87",
    "[detect] MEDIUM: unchecked CPI return @ transfer:L63",
    "[graph] authority-flow: 8 nodes, 12 edges",
    "[graph] token-flow: 5 nodes, 7 edges",
    "[proof] generating exploit harness for 3 findings",
    "[fix] remediation plan: 3 patches, 5 regression tests",
    "[report] audit complete. verdict: DO NOT SHIP",
  ];

  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      if (i < allLines.length) {
        setLines(prev => [...prev, allLines[i]]);
        i++;
      } else {
        clearInterval(timer);
      }
    }, 400);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="bg-[var(--bg)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border)]">
        <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
        <div className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
        <div className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
        <span className="ml-2 text-[10px] mono text-[var(--fg-dim)]">solaudit-agent</span>
      </div>
      <div className="p-4 h-[320px] overflow-hidden">
        {lines.map((line, i) => (
          <div key={i} className="mono text-xs leading-relaxed count-in" style={{animationDelay: `${i * 50}ms`}}>
            {line.startsWith("$") ? (
              <span className="text-[var(--fg)]">{line}</span>
            ) : line.includes("CRITICAL") ? (
              <span className="text-red-400">{line}</span>
            ) : line.includes("HIGH") ? (
              <span className="text-orange-400">{line}</span>
            ) : line.includes("MEDIUM") ? (
              <span className="text-yellow-400">{line}</span>
            ) : line.includes("DO NOT SHIP") ? (
              <span className="text-red-400 font-semibold">{line}</span>
            ) : line.includes("complete") ? (
              <span className="text-[var(--accent)]">{line}</span>
            ) : (
              <span className="text-[var(--fg-muted)]">{line}</span>
            )}
          </div>
        ))}
        {lines.length < allLines.length && (
          <span className="mono text-xs text-[var(--accent)] cursor-blink" />
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="grid-bg min-h-[calc(100vh-48px)]">
      {/* Hero */}
      <section className="pt-16 pb-12 fade-up">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--border)] bg-[var(--bg-surface)] mb-6">
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            <span className="mono text-[11px] text-[var(--fg-muted)]">automated security analysis for solana programs</span>
          </div>
          
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight">
            Audit Solana programs<br />
            <span className="text-[var(--accent)]">before they ship.</span>
          </h1>
          
          <p className="mt-4 text-[var(--fg-muted)] text-sm max-w-lg mx-auto leading-relaxed">
            Static analysis, semantic graph mining, adversarial account synthesis,
            proof-of-concept generation, and automated remediation planning.
            15 vulnerability classes. One pipeline.
          </p>

          <div className="flex gap-3 justify-center mt-8">
            <Link
              href="/audit/new"
              className="px-5 py-2 bg-[var(--accent)] text-black text-sm font-semibold rounded hover:brightness-110 transition-all"
            >
              Start audit
            </Link>
            <Link
              href="/dashboard"
              className="px-5 py-2 border border-[var(--border)] text-[var(--fg-muted)] text-sm rounded hover:border-[var(--border-hover)] hover:text-[var(--fg)] transition-all"
            >
              View dashboard
            </Link>
          </div>
        </div>
      </section>

      <div className="glow-line max-w-xl mx-auto" />

      {/* Terminal demo */}
      <section className="max-w-2xl mx-auto py-12 fade-up-d1">
        <TerminalBlock />
      </section>

      {/* Pipeline */}
      <section className="py-12 fade-up-d2">
        <div className="text-center mb-8">
          <h2 className="text-lg font-semibold">Pipeline</h2>
          <p className="text-xs text-[var(--fg-dim)] mt-1 mono">7-stage sequential analysis</p>
        </div>
        <div className="max-w-3xl mx-auto flex flex-wrap justify-center gap-px">
          {PIPELINE.map((stage, i) => (
            <div
              key={stage.id}
              className="flex items-center gap-3 px-4 py-3 border border-[var(--border)] bg-[var(--bg-surface)] first:rounded-l-lg last:rounded-r-lg"
            >
              <span className="mono text-[10px] text-[var(--fg-dim)]">{String(i+1).padStart(2,"0")}</span>
              <div>
                <p className="text-xs font-medium text-[var(--fg)]">{stage.label}</p>
                <p className="mono text-[10px] text-[var(--fg-dim)]">{stage.time}</p>
              </div>
              {i < PIPELINE.length - 1 && (
                <span className="text-[var(--fg-dim)] text-xs ml-1">&#8594;</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Detectors grid */}
      <section className="py-12 fade-up-d3">
        <div className="text-center mb-8">
          <h2 className="text-lg font-semibold">Vulnerability Classes</h2>
          <p className="text-xs text-[var(--fg-dim)] mt-1 mono">15 detectors</p>
        </div>
        <div className="max-w-3xl mx-auto grid grid-cols-3 sm:grid-cols-5 gap-px bg-[var(--border)] rounded-lg overflow-hidden">
          {CLASSES.map((cls, i) => (
            <div
              key={i}
              className="bg-[var(--bg-surface)] p-3 group hover:bg-[var(--bg-elevated)] transition-colors"
            >
              <span className="mono text-[10px] text-[var(--accent)] opacity-50 group-hover:opacity-100 transition-opacity">
                {String(i + 1).padStart(2, "0")}
              </span>
              <p className="text-[11px] text-[var(--fg-muted)] mt-1 leading-tight group-hover:text-[var(--fg)] transition-colors">
                {cls}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Graphs section */}
      <section className="py-12 pb-20 fade-up-d4">
        <div className="text-center mb-8">
          <h2 className="text-lg font-semibold">Semantic Graphs</h2>
          <p className="text-xs text-[var(--fg-dim)] mt-1 mono">program structure analysis</p>
        </div>
        <div className="max-w-2xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { name: "Authority Flow", desc: "Signer propagation paths" },
            { name: "Token Flow", desc: "SPL token account edges" },
            { name: "State Machine", desc: "State transition graph" },
            { name: "PDA Graph", desc: "Derived address mapping" },
          ].map((g) => (
            <div
              key={g.name}
              className="border border-[var(--border)] rounded-lg p-4 bg-[var(--bg-surface)] card-hover text-center"
            >
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="mx-auto mb-2 text-[var(--accent)] opacity-40">
                <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1" />
                <circle cx="24" cy="8" r="3" stroke="currentColor" strokeWidth="1" />
                <circle cx="16" cy="24" r="3" stroke="currentColor" strokeWidth="1" />
                <line x1="10.5" y1="9.5" x2="14" y2="22" stroke="currentColor" strokeWidth="0.75" />
                <line x1="21.5" y1="9.5" x2="18" y2="22" stroke="currentColor" strokeWidth="0.75" />
                <line x1="11" y1="8" x2="21" y2="8" stroke="currentColor" strokeWidth="0.75" />
              </svg>
              <p className="text-xs font-medium text-[var(--fg)]">{g.name}</p>
              <p className="mono text-[10px] text-[var(--fg-dim)] mt-0.5">{g.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
