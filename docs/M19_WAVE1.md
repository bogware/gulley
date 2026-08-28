# M19 — Wave 1: "Make it real"

Wave 1 of the killer-feature roadmap (`docs/AGENTGATEWAY_PORT.md` → the Aug-2026
principal review). The theme: the engine is world-class, but several headline
features are **built-but-unwired**, plus a short P0/P1 correctness backlog. Wave 1
turns the engine on and clears the backlog so the product is as strong as the
architecture. Delivered in tested, gated, per-slice commits.

## Landed

| Slice                     | What                                                                                                                                                                                                                          | Key knobs                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **A — correctness**       | Reserve/commit price parity (admission uses the catalog `RateResolver` like commit); Anthropic multi-block `failClosed` guard (mirrors the M18 OpenAI n>1 guard); no-usage charge knob.                                       | `METER_CHARGE_ON_MISSING_USAGE` |
| **B — working analytics** | `PostgresRequestLogQuery` (keyset search + `date_trunc` usage rollups with `errorRate` + `p95LatencyMs`), wired into control-api when a DB is present. The log browser + dashboards were empty in production; now functional. | —                               |
| **C — durability**        | Gemini/Vertex cost seeds (no more $0 billing); Postgres exact-cache sweeper (expired rows reclaimed, `semantic_vector` cascades).                                                                                             | `CACHE_SWEEP_INTERVAL_SECONDS`  |
| **D — docs truth pass**   | README status M0→M18 + provider list + package map; ARCHITECTURE pipeline diagram corrected (cache **before** budget — a hit is `$0`); CLAUDE.md gate note.                                                                   | —                               |

## Remaining (each its own carefully-reviewed slice)

These are the substantive wiring efforts. The review's "just turn it on" framing
understated them: each is a real config/adapter/hot-path wiring change, and two feed
the failover/enforcement hot path (so they get an adversarial review + a
`Hotpath-Reviewed:` trailer).

1. **Multi-target routing config surface.** Types already support
   `single|loadbalance|fallback` (weights + `onStatusCodes`) and hedging; the gap is
   the _declaration_. Add a strategy schema to the DB config document **and** an env
   `ROUTE_GROUPS` form, resolve target provider references in both builders
   (`config-builder.ts` `routesForProvider`, `context.ts` `buildRoutes`), and wire
   `ctx.hedgeDelayMs`/`route.hedgeDelayMs` (`HEDGE_DELAY_MS`). Lights up the whole
   resilience library (breaker/outlier/P2C/HRW/hedge). _Hot-path adjacent — review._
2. **Per-workspace guardrails + input vault.** Materialize the DB `guardrail`
   collection into per-workspace `GuardrailEngine`s (preserved by reference across
   hot-reload) and add `GUARDRAILS_INPUT_ACTION` so native input masking + the
   reversible tokenization round-trip are reachable. _Hot path — review._
3. **Native Gemini/Vertex adapter wiring.** Add a `gemini`/`vertex` route-builder
   case constructing `GeminiNativeAdapter` (inner adapter + SA-JWT token provider +
   per-request target model) so thinking-signature round-trips in production instead
   of degrading to the OpenAI preset.
4. **Durable virtual-key admin.** The admin key store is in-memory even in DB mode
   (production keys are seeded directly); add a `PostgresKeyAdminStore` that
   lists/disables (`UPDATE virtual_key SET disabled`) / rotates against the table the
   gateway reads, then expose `GET /keys` + revoke/rotate endpoints + the UI button.
5. **`request_log` / `spend_ledger` partitioning + rollups + retention.** Hand-written
   migration (drizzle-kit can't emit partitioning) converting both to native
   `created_at` range partitions, a per-minute `usage_rollup` table, and
   partition-drop retention. Needs real-Postgres validation (partitioning support in
   the PGlite test harness is limited).
6. **Budget counter self-heal.** Reconcile the Redis committed counter from
   `spend_ledger` (boot + periodic) so a counters-cluster failover can't silently
   reset enforced spend to `$0`.
7. **DB `model_alias` → `ModelRouter`.** Load the `model_alias` table into the router
   at context build + hot-reload (today it's built only from `CUSTOM_PROVIDERS`).

## Conventions

Per-slice commits (`M19 A/B/C/…`), each: implement → focused tests (PGlite for durable
SQL) → `bash ci/verify.sh` green → commit `-s`. Hot-path slices add the
`Hotpath-Reviewed:` trailer after an adversarial review.
