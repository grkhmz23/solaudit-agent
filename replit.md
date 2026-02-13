# SolAudit Agent

## Overview

SolAudit Agent is a production-ready Solana program security auditor. It provides automated vulnerability detection across 15 vulnerability classes, semantic graph mining, adversarial account synthesis, proof-of-concept generation, and automated fix planning for Solana/Anchor smart contracts.

The system is a monorepo with a Next.js 14 web frontend, a BullMQ background worker for heavy audit processing, and several shared packages for the audit engine, database, queue, storage, and GitHub integration. Users submit a Solana program repository URL, the system clones it, parses Rust source files, runs 15 vulnerability detectors, builds semantic graphs (authority flow, token flow, state machine, PDA), generates exploit proofs, and produces remediation plans with code patches.

There is also an autonomous "agent" mode that can discover high-value Solana repos on GitHub, audit them, generate patches, and optionally open pull requests.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Monorepo Structure (pnpm workspaces)

The project uses a pnpm monorepo with two apps and five shared packages:

- **`apps/web`** — Next.js 14 App Router. Serves both the frontend UI and API routes. Uses Tailwind CSS with a dark hacker-aesthetic theme. Client components use SWR-style polling for real-time audit status updates.
- **`apps/worker`** — BullMQ consumer process. Picks up audit jobs from Redis, clones repos, runs the full audit pipeline, and stores results in PostgreSQL. Also handles autonomous "agent" mode jobs.
- **`packages/db`** — Prisma ORM schema and client for PostgreSQL. Exports a singleton `prisma` instance. Models include `AuditJob`, `Finding`, and `Artifact`.
- **`packages/queue`** — BullMQ queue setup with Redis (via ioredis). Defines the `audit-jobs` queue, job data schema (validated with Zod), and factory functions for queue/worker/events.
- **`packages/engine`** — Core audit engine. Contains the full pipeline: Rust file parser, 15 vulnerability detectors, 4 semantic graph builders, constraint checker, adversarial account synthesizer, proof constructor/executor, remediation planner/patcher, report generator, LLM integration (Moonshot/Kimi K2), repo discovery/scoring, and agent orchestrator.
- **`packages/github`** — GitHub API client (via Octokit). Handles repo info, forking, branch creation, file commits, and PR submission for the autonomous agent mode.
- **`packages/storage`** — S3-compatible storage (Cloudflare R2). Stores audit artifacts (reports, graphs) with presigned URL generation.

### Build System

All packages use `tsup` for building ESM output with declarations. The root `package.json` defines a build order: `db → queue → github → engine → web/worker`. TypeScript 5.4+ with strict mode throughout.

### Startup Process

The `start.js` file at the root handles production startup on Replit:
1. Starts an instant health check server on port 3000
2. Boots Next.js on port 3001
3. After 8 seconds, swaps to a proxy forwarding 3000 → 3001
4. Also boots the worker process in parallel

### API Architecture

All API routes live under `apps/web/src/app/api/`:
- `POST /api/audits` — Create a new audit job (validates URL with SSRF protection, enqueues to BullMQ)
- `GET /api/audits` — List audits with pagination
- `GET /api/audits/[id]` — Get audit detail with findings and artifacts
- `DELETE /api/audits/[id]` — Delete an audit
- `GET /api/artifacts/[id]/url` — Get presigned download URL for an artifact
- `GET /api/health` — Health check (database + Redis)
- `GET /api/queue` — Queue stats
- `POST /api/agent` — Start autonomous agent runs

API authentication uses a header-based API key (`x-api-key`). In production, it fails closed if `API_KEY` env var is missing. In development, auth is skipped if no key is configured.

### Audit Pipeline (packages/engine)

The pipeline runs in this order:
1. **Parse** — Recursively find `.rs` files, detect framework (Anchor vs native), extract instructions, account structs, CPI calls, PDA derivations, arithmetic ops
2. **Graph Building** — Build 4 semantic graphs: Authority Flow, Token Flow, State Machine, PDA Graph
3. **Detection** — Run 15 vulnerability detectors covering: missing signer/owner checks, PDA derivation mistakes, arbitrary CPI, type confusion, reinitialization, close-then-revive, unchecked realloc, integer overflow, state machine violations, remaining accounts injection, oracle validation, token account mismatch, post-CPI stale reads, duplicate account injection
4. **Constraint Checking** — Verify authority chains, PDA consistency, balance conservation
5. **Adversarial Synthesis** — Generate attack permutations (signer substitution, account aliasing, program substitution, uninitialized accounts)
6. **Proof Construction** — Generate proof plans and executable test harnesses
7. **Remediation** — Plan fixes with code patches and regression tests
8. **Report Generation** — Markdown and JSON reports

### LLM Integration

Optional Moonshot/Kimi K2 integration (`MOONSHOT_API_KEY` env var) enriches findings with professional descriptions, generates PR content, and creates security advisories. Falls back to template text when unavailable.

### Database

PostgreSQL with Prisma ORM. Key models:
- `AuditJob` — Tracks audit status, progress, repo metadata, summary
- `Finding` — Individual vulnerability findings with severity, location, confidence, proof status
- `Artifact` — Stored files (reports, graphs) with S3 object keys

The Prisma schema is in `packages/db/prisma/schema.prisma`. Run migrations with `pnpm db:migrate` or `pnpm db:migrate:deploy`.

### Frontend

Next.js 14 App Router with client components. Dark theme with green accent (`#00ff88`). Pages:
- `/` — Landing page with animated terminal demo
- `/dashboard` — List of audits with auto-polling
- `/audit/new` — Create new audit form
- `/audit/[id]` — Audit detail with tabs (summary, findings, graphs, artifacts)
- `/agent` — Autonomous agent control panel
- `/settings` — API key config, health/queue status

## External Dependencies

### Required Infrastructure
- **PostgreSQL** — Primary database (Prisma ORM). Set via `DATABASE_URL` env var.
- **Redis** — Job queue backend (BullMQ). Set via `REDIS_URL` env var (defaults to `redis://localhost:6379`).

### Optional Services
- **Cloudflare R2 / S3** — Artifact storage. Configured via `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`. Falls back to local filesystem storage if not configured.
- **Moonshot AI (Kimi K2)** — LLM for enriching findings and generating PR content. Set via `MOONSHOT_API_KEY`. Falls back to template text.
- **GitHub API** — For autonomous agent mode (repo discovery, forking, PR submission). Set via `GITHUB_TOKEN`.

### Key Environment Variables
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string
- `API_KEY` — API authentication key (minimum 16 chars in production)
- `MOONSHOT_API_KEY` — Optional LLM API key
- `MOONSHOT_MODEL` — LLM model name (defaults to `kimi-k2.5`)
- `GITHUB_TOKEN` — Optional GitHub personal access token
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` — Optional R2 storage config
- `STORAGE_DIR` — Local temp storage for cloned repos (defaults to `/tmp/solaudit-storage`)

### Key NPM Dependencies
- `next` 14.2.x — Web framework
- `@prisma/client` / `prisma` 5.x — Database ORM
- `bullmq` 5.x / `ioredis` 5.x — Job queue
- `@octokit/rest` 21.x — GitHub API
- `@aws-sdk/client-s3` — S3/R2 storage
- `zod` 3.x — Runtime validation
- `tailwindcss` 3.x — Styling
- `vitest` 1.x — Testing (engine package)
- `tsup` 8.x — Package bundling