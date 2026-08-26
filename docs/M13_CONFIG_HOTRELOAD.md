# M13 — Config hot-reload (durable DB config + live reconcile)

**Goal:** a config change applied via the control plane propagates to every running
gateway replica **without a redeploy**, and each replica reconciles **live** —
preserving in-flight requests and all in-memory routing state. This is the last
agentgateway-port capability.

The M12 propagation bus (`@gulley/storage` `pubsub.ts`: `PostgresConfigBus` +
`RedisConfigBus` + `SignalGate`) is already the transport. M13 builds the durable
source of truth and the data-plane reconcile the bus drives.

## Why it's a milestone, not a slice

The M12 research (7-agent seam map) established that hot-reload is blocked on a
real prerequisite: **routes/providers/guardrails/model-aliases are not persisted
anywhere the gateway reads.** Today the gateway builds its route table once at
boot from Zod **env** (`buildRoutes`/`buildCustomProviders`/`buildGuardrails`),
while the control plane's `ControlConfigStore` writes only **in-memory** Maps.
Budgets and rate-limits are the exception — their resolvers already read Postgres
per request, so they hot-reload for free once the rows are persisted.

So M13 is three layers, each independently shippable and verifiable.

## Layer 1 — Durable config store (control plane)

**New:** `PostgresConfigStore` + `PostgresConfigVersionStore` in `@gulley/storage`
(or `@gulley/config` adapters), implementing the existing `ConfigStore` /
`ConfigVersionStore` interfaces (`packages/config/src/store.ts`).

- `reconcile(doc)` ports `apps/control-api/src/config-store.ts`'s upsert-then-prune
  (find-or-create org/workspace, per-collection delete-by-absence + create + update-
  on-JSON-change; virtual keys untouched) into **one Drizzle transaction** over
  `provider` / `provider_credential` / `route` / `route_policy` / `model_alias` /
  `rate_limit` / `guardrail` / `budget`.
- `PostgresConfigVersionStore` over the existing `config_version` table (append-only,
  immutability from migration 0006, non-unique content_hash so reverts are allowed).
  `tryReserve` must be an **atomic compare-and-bump** (INSERT `version = max+1` under
  a serializable guard / advisory lock) to keep the optimistic-concurrency "exactly
  one concurrent apply wins" contract the tests assert.
- Wire both into `apps/control-api/src/context.ts` (replacing `InMemoryConfigVersionStore`
  - the in-memory stores) so `POST /config/apply` persists to the tables the gateway
    reads, then fires the (already-wired) `onApplied` bus emit.

**Verify:** apply → rows persisted + version bumped; two concurrent applies → one
409 stale; a revert reuses a prior hash under a new version.

## Layer 2 — Gateway builds artifacts from the config document

**New:** a pure `document → { ProviderRoute[], ModelRouteRule[], GuardrailEngine }`
builder factored out of `context.ts`'s `buildRoutes`/`buildCustomProviders`/
`buildGuardrails` (they're already pure functions of config).

- Provider credentials: the DB carries **`SecretRef` ARNs**, not raw keys, so the
  builder resolves each ARN via a **new Secrets Manager resolver** at reload time
  (a documented seam that does not exist yet). A resolution or validation failure
  **aborts the whole reconcile atomically** and keeps the old config — never a
  partial swap pointing a live route at an empty credential.
- Boot path stays env-driven for a v1 deployment; the DB path is opt-in
  (`CONFIG_SOURCE=db`) so nothing changes until an operator turns it on.

**Verify:** a document with an unresolvable ARN → builder throws, old artifacts kept;
a valid document → identical `ProviderRoute[]` to the equivalent env config.

## Layer 3 — Live reconcile + mutable dispatch (data plane)

**New:** a `ConfigWatcher` (in `apps/gateway`) subscribing to the bus, started in
`main.ts` after `listen`, closed first on the SIGTERM drain.

- On a surviving signal (SignalGate: not-self, version > applied) → debounce →
  single-flight `reconcile(desiredDoc)`. On **every (re)connect**, do a full
  `exportDocument` resync (LISTEN drops events while disconnected; Redis pub/sub is
  at-most-once) — version-gated so it's idempotent.
- `reconcile`: build the new artifacts off-path (Layer 2), delta by `target.name`,
  upsert new/changed `ProviderRoute`s, prune vanished ones, then **swap the holder
  pointers in one assignment** (JS single-threaded → atomic between ticks).
- **Preserved by reference (never reset):** `CircuitBreaker`, `OutlierDetector`,
  `LoadScoreboard`, `BudgetStore`, `RateLimiter`, `BatchingRequestLog`, `Telemetry`,
  `GatewayMetrics`, the Postgres pool, and per-URL Redis clients. Reset a breaker/
  outlier entry only on a **material identity change** (baseUrl/credential), never a
  pure weight change; prune a breaker/scoreboard entry only for a name that is gone
  **and** idle (`scoreboard.load(name) === 0`).
- **Mutable dispatch:** convert `GatewayContext` into a holder the request handler
  reads **once at entry** (never re-read mid-request), so an in-flight hijacked
  stream + its single teardown finish on the ctx they started with. Register the
  proxy surface as **one dispatcher** (a parametric route / a stable superset of
  paths) so a path-set change needs no Fastify re-registration.
- **Restart-only (rejected at reconcile, documented):** backend-shape flips
  (`REDIS_*`/`DATABASE_URL`/cache-backend toggles) and constructor-baked scalars
  (`RATELIMIT_FAIL_OPEN`, `LOG_BATCH_*`) unless those classes gain `reconfigure()`.

**Verify (the marquee test):** an ejected upstream stays ejected across a reconcile
that changed an unrelated route; an in-flight streamed request completes untouched
while a reconcile swaps the route table; a config with a bad ARN is rejected with
the old config intact; budgets/rate-limits reflect the new rows on the next request
with no watcher involvement.

## Non-negotiables carried in

Raw-pipe + single centralized teardown; meter-from-raw-usage; **secret-ARNs-only**
(no resolved secret ever crosses the bus or is cached on ctx); role-split Redis
(counters untouched on reload); Postgres is the durable source of truth.

## Sequencing

L1 → L2 → L3, each its own verify-then-commit wave, with an adversarial-review
workflow after L3 (the reconcile touches the hottest file). Est. the largest of the
port's milestones; L1 is mechanical, L3 is where the care goes.

## Open questions (for kickoff)

See the kickoff discussion — deployment target for the DB config path, secret
resolver scope, and how aggressively to refactor Fastify dispatch.
