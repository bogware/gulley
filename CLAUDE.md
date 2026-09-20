# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gulley is a self-hostable, enterprise LLM gateway: one container fronting every LLM provider
(Anthropic, OpenAI, Bedrock, Azure) that adds routing, cost/budget enforcement, caching,
guardrails/PII masking, RBAC, and a tamper-evident audit trail — drop-in behind a base-URL
change. The **Anthropic Messages schema is the canonical internal model**; other providers
translate to/from it. Single-tenant per deployment (`org_id`/`workspace_id`/`project_id`
columns exist for a future multi-tenant mode, but no isolation machinery in v1).

`docs/ARCHITECTURE.md` is the source of truth for the design and its non-negotiable
invariants; the [CHANGELOG](CHANGELOG.md) records what is actually built. The core gateway,
routing, cost/budget, caching, guardrails/DLP, RBAC, identity (OAuth/OIDC), compliance, and
the admin console are delivered. Note scope caveats documented in ARCHITECTURE.md (e.g.
"streaming output guardrails are audit-only by default unless the windowed enforcer is on").

## Commands

Node ≥ 22.9 via corepack; pnpm 9. Turborepo drives the workspace.

```bash
pnpm install                     # corepack enable first if pnpm is missing
docker compose up -d             # Postgres + 3 role-split Redis (see below)
pnpm dev                         # gateway (:8080) + control-api (:8081) + web (:3000), watch mode

pnpm lint                        # ESLint (flat config); NOTE: apps/web is excluded
pnpm typecheck                   # tsc --noEmit across the workspace
pnpm test                        # Vitest (unit + integration)
pnpm format:check                # Prettier (pnpm format to write)
pnpm build                       # effectively only `next build` for apps/web — see "no build step" below

bash ci/verify.sh                # the full local gate CI runs: format:check + lint + typecheck + test + build
```

> The full local gate is **`ci/verify.sh`** (and `ci/install.sh` for the
> frozen-lockfile install); `ci/hotpath-guard.sh` enforces the `Hotpath-Reviewed:`
> trailer on data-plane hot-path commits.

### Running a single package / test

Everything is a `@gulley/*` workspace package. Scope any task with `pnpm --filter`:

```bash
pnpm --filter @gulley/providers test            # one package's tests
pnpm --filter @gulley/providers test translate  # one file (positional = Vitest filename filter)
pnpm --filter @gulley/providers test -- -t "reassembles input_json_delta"   # by test name
```

### Database migrations (Drizzle)

Schema lives in `packages/storage/src/schema.ts`; config in `packages/storage/drizzle.config.ts`.

```bash
pnpm db:generate                             # generate SQL migration from the schema (root → storage)
pnpm --filter @gulley/storage db:migrate     # apply migrations
```

### Live / cloud smoke checks (cost real money)

Each app has `*-check.ts` / `live-check.ts` scripts run via package `pnpm` scripts. These are
**manual smoke tests against real provider or AWS APIs** (they spend real pennies and need real
credentials in `.env`) — they are **not** part of `pnpm test` or CI. Examples:

```bash
pnpm --filter @gulley/gateway live:anthropic     # real Anthropic through the gateway
pnpm --filter @gulley/gateway cache:check        # exact + semantic cache w/ real embeddings
pnpm --filter @gulley/gateway guardrail:check
pnpm --filter @gulley/control-api worm:check     # real S3 Object Lock immutability
pnpm --filter @gulley/control-api kms:check      # real split-KMS envelope encrypt/decrypt
pnpm --filter @gulley/control-api ssrf:check     # real DNS-rebind blocking
```

### Terraform

```bash
bash ci/tf-check.sh              # fmt -check + validate for envs/dev and envs/prod (no cloud creds)
```

## Architecture map

Two logically separate planes in one monorepo, one shared container image:

- **`apps/gateway`** — the stateless data plane (hot path). Terminates client requests, runs the
  pipeline, streams to/from providers. Health-only boot if config is incomplete (`/ready` → 503
  until a working context is wired, so ECS/ALB pulls it out of service).
- **`apps/control-api`** — the control plane API (admin CRUD + config/GitOps + OAuth broker).
  Every write is hash-chain audited; stores are Postgres-backed.
- **`apps/web`** — Next.js admin UI (thin; App Router + Tailwind). Excluded from ESLint.
- **`packages/*`** — the substance; all consumed by the two apps.

### The request pipeline is one file

**`apps/gateway/src/routes/messages.ts` → `handleProxy()` is the whole data-plane pipeline** and
the most important file in the repo. Its ordering is fixed and encodes the architecture's hot-path
invariants — read it before touching gateway behavior:

`authn` (virtual-key, fail-closed) → `authz` (model + provider scope) → `guardrails-in`
(audit default / block / mask-with-vault) → `cache lookup` (before budget: a hit is $0 and never
touches an upstream) → `budget reserve` (worst-case, TOCTOU-safe) → **pre-first-byte failover
loop** over candidates → `reply.hijack()` raw-byte pipe with backpressure + inactivity watchdog,
streaming usage extraction, output guardrail scan / detokenize → **one centralized `teardown()`**.

Non-negotiable invariants baked into that flow (do not regress them):

- **Raw byte fidelity + one teardown.** The response socket is hijacked (`reply.hijack()`), so
  Fastify's `onSend`/`onResponse` are bypassed. A single `teardown()` in the stream `end`/`error`
  paths is the _only_ place budget-commit, ledger, request-log, audit, cache-store, and telemetry
  happen — SOC 2 audit completeness depends on it always running.
- **Never buffer by default.** Bytes pipe straight through with `highWaterMark` backpressure
  (pause upstream on a full client socket). Full capture happens only for non-streamed metering,
  buffered output enforcement, or a cacheable miss — and is byte-capped. Streaming output
  guardrails are **audit-only** by default; block/redact enforcement requires buffering
  (non-streamed only) UNLESS the opt-in windowed streaming enforcer is on (M17,
  `STREAMING_ENFORCE`), which redacts / reversibly masks / blocks in-stream on Anthropic
  Messages **and** OpenAI `chat.completions` responses (M18) — relaxing raw-byte-fidelity
  for that mode only (see the streaming-enforcement design in `docs/ARCHITECTURE.md`).
- **Budget = reserve/commit.** Reserve worst-case at admission; commit actual (or refund) in
  teardown, released _first and independently_ of the best-effort durable sinks so a failed
  audit/ledger write can't leak a reservation and DoS the workspace budget. Always meter partial
  spend on abort/failover.
- **Failover is pre-first-byte only.** Once bytes are flowing, a failure is a terminal SSE error,
  never a re-route. The circuit breaker tracks upstream faults only — terminal 4xx (client error)
  must not trip it.
- **Meter only from raw provider `usage`**, never canonical token fields (`packages/cost` encodes
  per-provider inclusion semantics + golden fixtures).

### Providers & routing

- **`packages/providers`** — per-provider adapters (`anthropic`, `openai`, `bedrock`, `azure`),
  the SSE state machine (`sse.ts`), Bedrock `vnd.amazon.eventstream` decode, and
  canonical↔provider translation. Provider-affine artifacts (Anthropic thinking signatures,
  OpenAI Responses state, `cache_control`) are passthrough-preserved, never synthesized
  cross-provider. `closeUpstreamPool()` backs the graceful drain.
- **`packages/routing`** — recursive strategy config (`single | loadbalance | fallback |
conditional`), candidate selection, circuit breaker. In v1, `apps/gateway/src/context.ts
buildRoutes()` registers each provider as a **single-target strategy, and only when its upstream
  key is present** in config.

### Storage & state

- **`packages/storage`** — Drizzle schema + migrations, Postgres adapters (KeyStore, Ledger,
  RequestLog, AuditSink, exact-cache, pgvector index), and **role-split Redis clients**. Redis is
  three physically distinct instances because eviction policies conflict: **cache** =
  `allkeys-lru`, **counters** (budget/rate-limit) = `noeviction`, **vector** = `noeviction`.
  `docker-compose.yml` mirrors this on ports 6379/6380/6381. Postgres is the durable source of
  truth; Redis counters are a rebuildable projection.
- **`packages/pipeline`** — audit sink (hash-chained rows) + sanitize/redaction ports.
- **`packages/cache`** — two-tier engine: exact-hash + semantic (embedding similarity), keys
  partitioned by authz scope; PII/secret-flagged responses excluded. pgvector is the prod default.

### Governance packages

`auth` (virtual-key resolver, HMAC+KMS-pepper, admin sessions), `rbac` (deny-by-default Scope),
`budget` (reserve/commit, Redis + in-memory), `cost` (per-provider cost fns + golden usage
fixtures), `guardrails` (native RE2-safe detectors + reversible tokenization vault + streaming
primitives), `oauth` (device + auth-code/PKCE broker, refresh-reuse detection), `config`
(canonical DB↔YAML, optimistic concurrency, drift report), `worm` (S3 Object Lock mirror),
`crypto` (split-KMS envelope), `redact` (no-content / header-denylist), `egress` (SSRF guard),
`telemetry` (OTel GenAI emitters), `core` (ids, `SecretRef`, `Result`, version — the shared base).

## Conventions & gotchas

- **No build step for libraries.** Every `packages/*` exports `./src/index.ts` directly (`"exports"`
  and `"types"` point at source); apps run via `tsx` (`node --import tsx` in prod). Only
  `@gulley/web` has a `build` script, so `pnpm build` mostly just runs `next build`. Do not add
  `dist` emit or a compile step to a library without reason — consumers import TS source.
- **TypeScript is strict-plus**: `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`,
  `verbatimModuleSyntax`, `isolatedModules`. Prefix intentionally-unused vars with `_`.
- **Secret ARNs only, never values.** Postgres config, YAML exports, and audit diffs carry
  Secrets Manager ARNs (branded `SecretRef` in `@gulley/core`); a serialization guard test fails
  the build if a secret-resolving field is emitted inline. Never put provider keys in `.env`
  examples, tests, or the tree.
- **Gateway config is Zod-validated env** (`apps/gateway/src/config.ts`) — add new knobs there and
  to `.env.example`. Same pattern in `apps/control-api/src/config.ts`.
- **One monorepo container image** (`apps/gateway/Dockerfile`, `apps/control-api/Dockerfile`) runs
  either app; Node is PID 1 so SIGTERM reaches the bounded graceful-drain handler (`main.ts`).
  ARM64 Fargate.
- **CI is thin YAML calling `ci/*.sh`** so GitHub Actions (`.github/workflows/{ci,release,
dependency-bump}.yml`) and Azure Pipelines (`.azuredevops/*.yml`) stay at parity. Dependency
  bumps are **`workflow_dispatch`-only** — never add scheduled Dependabot/renovate.
- **Commits: DCO sign-off required** (`git commit -s`); CI enforces `Signed-off-by`.
