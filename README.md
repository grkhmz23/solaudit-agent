# SolAudit Agent

Production-ready Solana program security auditor with semantic graph mining, vulnerability detection (15 classes), adversarial account synthesis, proof-of-concept generation, and automated fix planning.

## Architecture

```
solaudit-agent/
├── apps/
│   ├── web/          # Next.js 14 App Router (frontend + API)
│   └── worker/       # BullMQ consumer (heavy audit execution)
├── packages/
│   ├── db/           # Prisma schema + client (PostgreSQL)
│   ├── queue/        # BullMQ setup (Redis)
│   └── engine/       # Core audit engine (detectors, graphs, pipeline)
├── docker-compose.yml
├── Dockerfile.web
└── Dockerfile.worker
```

## Quick Start (Docker)

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env — set a secure API_KEY

# 2. Start everything
docker-compose up -d

# 3. Run database migrations
docker-compose exec web npx prisma migrate deploy --schema=/app/packages/db/prisma/schema.prisma

# 4. Open the app
open http://localhost:3000
```

## Local Development (without Docker)

### Prerequisites
- Node.js 20+
- pnpm 8+
- PostgreSQL 16
- Redis 7

### Setup

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your local Postgres and Redis URLs

# Generate Prisma client
pnpm --filter @solaudit/db exec prisma generate

# Run migrations
pnpm --filter @solaudit/db exec prisma migrate dev --name init

# (Optional) Seed test data
pnpm --filter @solaudit/db exec tsx src/seed.ts

# Start web app (terminal 1)
pnpm --filter @solaudit/web dev

# Start worker (terminal 2)
pnpm --filter @solaudit/worker dev
```

The web app runs at `http://localhost:3000`.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://solaudit:solaudit@localhost:5432/solaudit` |
| `REDIS_URL` | Redis connection string (Upstash-compatible) | `redis://localhost:6379` |
| `API_KEY` | API authentication key | `change-me-to-a-secure-random-string` |
| `STORAGE_DIR` | Local artifact storage directory | `./storage` |
| `WORKER_ENABLE_PROVE` | Enable proof execution on worker | `false` |
| `GITHUB_TOKEN` | GitHub token for private repos | _(empty)_ |
| `NEXT_PUBLIC_APP_URL` | Public URL of the web app | `http://localhost:3000` |

## Audit Modes

- **Scan** — Static analysis, semantic graph mining, 15 vulnerability detectors, constraint checking, adversarial account synthesis
- **Prove** — All of Scan + proof-of-concept harness generation (requires Anchor/Solana toolchain on worker)
- **Fix Plan** — All of Scan + remediation planning with code snippets and regression test suggestions

## Vulnerability Classes (15 Detectors)

| # | Class | Severity |
|---|---|---|
| 1 | Missing signer check | CRITICAL |
| 2 | Missing owner check | CRITICAL |
| 3 | PDA derivation mistakes | HIGH |
| 4 | Arbitrary CPI target | CRITICAL |
| 5 | Type confusion / account substitution | HIGH |
| 6 | Reinitialization / double-init | HIGH |
| 7 | Close-then-revive / closure without zeroing | HIGH |
| 8 | Unchecked realloc / stale memory | MEDIUM |
| 9 | Integer overflow/underflow | HIGH |
| 10 | State machine violations | MEDIUM |
| 11 | Remaining accounts privilege injection | MEDIUM |
| 12 | Oracle validation failures | HIGH |
| 13 | Token account authority/mint mismatch | HIGH |
| 14 | Post-CPI stale reads | MEDIUM |
| 15 | Duplicate account injection / aliasing | MEDIUM |

## API Usage

All API routes require the `x-api-key` header (unless API_KEY is not set).

```bash
# Create an audit
curl -X POST http://localhost:3000/api/audits \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{"repoUrl":"https://github.com/org/program.git","mode":"SCAN"}'

# List audits
curl http://localhost:3000/api/audits -H "x-api-key: YOUR_KEY"

# Get audit details
curl http://localhost:3000/api/audits/AUDIT_ID -H "x-api-key: YOUR_KEY"

# Health check
curl http://localhost:3000/api/health

# Queue status
curl http://localhost:3000/api/queue -H "x-api-key: YOUR_KEY"
```

## Engine Architecture

The audit engine runs as a 7-stage pipeline:

1. **Ingestion & Normalization** — Parse Anchor and native Rust programs
2. **Structural Mapping & Graph Mining** — Build Authority Flow, Token Flow, State Machine, and PDA graphs
3. **Candidate Generation** — Rule engine (15 detectors) + constraint checker + adversarial account synthesis
4. **Proof Construction** — Generate proof plans, harnesses, and delta schemas
5. **Remediation Planning** — Map findings to fix patterns with code snippets
6. **Deduplication & Ranking** — By severity × confidence score
7. **Report Assembly** — Markdown and JSON reports

### Graph Builders

- **Authority Flow Graph** — Tracks signer privileges and authority delegation chains
- **Token Flow Graph** — Maps SOL and SPL token movements between accounts
- **State Machine Graph** — Reconstructs state transitions from enums and conditionals
- **PDA Graph** — Maps all PDAs, seeds, bump handling, and collision risks

### Constraint Checker

Lightweight formal reasoning with a plugin interface for future SMT solver integration:
- Authority chain integrity verification
- PDA consistency validation
- Balance conservation checking

## Testing

```bash
# Run engine unit tests
pnpm --filter @solaudit/engine test

# Run with watch mode
pnpm --filter @solaudit/engine test:watch
```

## Deployment

### Vercel (Frontend + API)

The web app deploys to Vercel. No long-running jobs run in API routes — all heavy work is queued to Redis and processed by the worker.

```bash
vercel deploy
```

Set environment variables in Vercel dashboard:
- `DATABASE_URL` (e.g., Neon, Supabase)
- `REDIS_URL` (e.g., Upstash)
- `API_KEY`

### Worker (Docker)

Run the worker separately on any Docker-capable host:

```bash
docker build -f Dockerfile.worker -t solaudit-worker .
docker run -d \
  -e DATABASE_URL=... \
  -e REDIS_URL=... \
  -e STORAGE_DIR=/data \
  -v /host/storage:/data \
  solaudit-worker
```

## How to Zip

```bash
cd /path/to/parent
tar -czf solaudit-agent.tar.gz --exclude=node_modules --exclude=.next --exclude=dist solaudit-agent/
# or
zip -r solaudit-agent.zip solaudit-agent/ -x "*/node_modules/*" "*/.next/*" "*/dist/*"
```

## License

Private — All rights reserved.
