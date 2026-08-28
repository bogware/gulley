# M19 — Wave 1: "Make it real"

Wave 1 of the killer-feature roadmap (`docs/AGENTGATEWAY_PORT.md` → the Aug-2026
principal review). Theme: the engine is world-class, but several headline features
were **built-but-unwired**, plus a P0/P1 correctness backlog. Wave 1 turns the engine
on. Delivered in tested, gated, per-slice commits.

## Landed (A–H, all on `main`)

| Slice                             | What                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — correctness**               | Reserve/commit price parity; Anthropic multi-block `failClosed` guard; no-usage charge knob (`METER_CHARGE_ON_MISSING_USAGE`).                                                                 |
| **B — working analytics**         | `PostgresRequestLogQuery` (keyset search + `date_trunc` usage rollups w/ error-rate + p95), wired when a DB is present — the empty-dashboard fix.                                              |
| **C — durability**                | Gemini/Vertex cost seeds; Postgres exact-cache sweeper (`CACHE_SWEEP_INTERVAL_SECONDS`).                                                                                                       |
| **D — docs truth pass**           | README M0→M18; ARCHITECTURE pipeline order corrected; CLAUDE.md.                                                                                                                               |
| **E — multi-target routing**      | `ROUTE_GROUPS` overlay (fallback/loadbalance folding) + `HEDGE_DELAY_MS` — lights up breaker/outlier/P2C/HRW/hedge. Env form.                                                                  |
| **F — durable virtual-key admin** | `PostgresKeyAdminStore` (mint/list/**revoke**/rotate over `virtual_key`) + control-api endpoints. Revoke/rotate now effective on the data plane.                                               |
| **G — DB model aliases**          | `buildModelRouterFromDocument` + reconciler `swapModelRouter` — admin-configured aliases/pins reach the gateway.                                                                               |
| **H — input guardrails + vault**  | `GUARDRAILS_INPUT_ACTION` — native input masking/blocking + the reversible tokenization round-trip reachable (integration-proven: PII masked to the provider, detokenized back to the client). |

## Remaining (focused follow-ons — each a real infra/design slice)

Not one-liners; several feed the hot path or need a real environment. Ordered by value.

1. **Native Gemini/Vertex adapter wiring.** `GeminiNativeAdapter` exists, but wiring
   it needs a provider config-schema extension (fixed target model + an inner HTTP
   adapter; for Vertex, project/location + the SA-JWT token provider). Cost seeds
   already landed (C); the route-builder case + config shape is the remaining work.
2. **`request_log` / `spend_ledger` partitioning + per-minute rollups + retention.**
   Hand-written migration (drizzle-kit can't emit partitioning) that recreates the
   tables as `created_at` range partitions + a `usage_rollup` table + partition-drop
   retention. **Needs real-Postgres validation** (PGlite's partitioning support is
   limited, and it's a data migration). The analytics _reader_ already works on the
   plain tables (B).
3. **Budget counter self-heal.** Reconcile the Redis committed counter from
   `spend_ledger` on a counters-cluster failover. Redis-specific (opt-in lazy heal
   vs. periodic reconcile is a real tradeoff) and only meaningfully testable against a
   live Redis — best validated with the `budget:check` live script.
4. **Doc-native forms** of the two overlays: the config-document `strategy` schema
   (vs the env `ROUTE_GROUPS`) and materializing the DB `guardrail` collection into
   per-workspace engines (vs the env `GUARDRAILS_INPUT/OUTPUT_ACTION`). Both feed the
   hot path → adversarial review.
5. **TTFT metric** (`gulley_time_to_first_byte_seconds`): `firstByteMs` is measured
   but only emitted as a trace span, so streaming latency is unalertable in
   Prometheus. Small, but a hot-path teardown edit.

## Conventions

Per-slice commits (`M19 A/B/…`): implement → focused tests (PGlite for durable SQL) →
`bash ci/verify.sh` green → commit `-s`. Hot-path slices carry a `Hotpath-Reviewed:`
trailer.
