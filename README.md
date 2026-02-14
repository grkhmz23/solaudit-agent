# SolAudit Agent

**Autonomous Solana smart contract security auditor.** Tree-sitter AST parsing, LLM-powered confirmation, automated patch generation, and bounty-grade advisory reports.

**Live demo:** [solaudit.fun](https://solaudit.fun) — paste any public Solana repo, get a full security audit.

## How It Works

SolAudit ingests a Solana program repository, parses every Rust file into an AST, identifies dangerous operations (token transfers, account closes, CPI calls, PDA derivations), traces backward to check whether proper guards exist, and uses an LLM to confirm or reject each candidate vulnerability.
```
Repo URL → Clone → tree-sitter Parse → Sink Extraction → Guard Tracing
  → Candidate Generation → LLM Confirmation → Finding Assembly
  → Patch Generation → Security Advisory → R2 Upload
```

## V2 Engine (6-Phase Pipeline)

**Phase 1 — Parse:** tree-sitter AST extraction of instructions, account structs, constraints, sinks, CPI calls, PDA derivations.

**Phase 2 — Candidates:** Sink-first analysis with 7 scanners (token/SOL transfers, closes, authority, CPI, PDA, overflow).

**Phase 3 — LLM Confirmation:** Two-stage Kimi K2.5 loop: triage → deep investigation. Confirms, rejects, or marks uncertain.

**Phase 4 — PoC Validation:** Generates Anchor test code with compile checking and resource limits.

**Phase 5 — Reports:** DB-safe summary, full JSON for R2, markdown advisory (PROVEN/LIKELY/NEEDS_HUMAN).

**Phase 6 — Hybrid Mode:** Runs V1+V2 in parallel to measure false positive reduction.

| | V1 | V2 |
|---|---|---|
| Parser | Regex | tree-sitter AST |
| Detection | Pattern match | Sink → trace guards |
| LLM role | Enrich after | Confirm/reject before |
| jito-programs | 91 findings | 4 actionable (96% reduction) |

## Quick Start (GitHub Codespaces)

1. **Code** → **Codespaces** → **Create codespace on main**
2. In terminal:
```bash
pnpm install
docker run -d --name pg -e POSTGRES_USER=solaudit -e POSTGRES_PASSWORD=solaudit -e POSTGRES_DB=solaudit -p 5432:5432 postgres:16-alpine
docker run -d --name redis -p 6379:6379 redis:7-alpine

cat > .env << 'EOF'
DATABASE_URL=postgresql://solaudit:solaudit@localhost:5432/solaudit
REDIS_URL=redis://localhost:6379
AUDIT_ENGINE_VERSION=v2
V2_LLM_CONFIRM=true
MOONSHOT_API_KEY=your-key-here
STORAGE_DIR=/tmp/solaudit-storage
EOF

pnpm --filter @solaudit/db exec prisma generate
pnpm --filter @solaudit/db exec prisma migrate dev --name init
cd packages/engine && pnpm exec tsup src/index.ts --format esm --dts --clean --out-dir dist && cd ../..
pnpm --filter @solaudit/web dev    # terminal 1
pnpm --filter @solaudit/worker dev # terminal 2
```

3. Open port 3000 → paste a repo URL → audit.

## Tech Stack

Next.js 14 · tree-sitter (WASM) · Kimi K2.5 LLM · BullMQ · Prisma/PostgreSQL · Cloudflare R2 · Replit

## License

Private — All rights reserved.
