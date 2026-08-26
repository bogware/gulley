# M14 — Resilience & Hardening

This milestone group finishes the reliability story started in M11–M13 and closes
the remaining enterprise gaps. Slate order: **A** (resilience triad) → **C**
(conformance & load harness) → **B** (native Vertex/Copilot) → **D** (per-tenant
routing) → **E** (release & supply-chain hardening). Each ships verified
(`ci/verify.sh` green) and, for hot-path changes, passes the adversarial review
gate (`docs/HOTPATH_REVIEW.md`).

---

## A — Resilience triad

Two additions that compose with the existing breaker / outlier / P2C scoreboard in
`packages/routing` and the pre-first-byte failover loop in
`apps/gateway/src/routes/messages.ts`:

### A1 — Adaptive concurrency limiting

**Problem.** Nothing bounds per-target in-flight load. Under an upstream slowdown,
the gateway keeps piling requests onto a degrading target; latency collapses for
everyone. The P2C scoreboard _spreads_ load but never _caps_ it.

**Design.** A per-target gradient limiter (`AdaptiveLimiter`, Netflix
concurrency-limits style) in `packages/routing/src/adaptive-limit.ts`:

- Per-target state: `limit` (float, dynamic), `inflight` (int), `rttNoLoad`
  (rolling min RTT = the uncongested baseline).
- `tryAcquire(name) → boolean`: admit iff `inflight < floor(limit)`; on admit,
  `inflight++`. This is the gate.
- `record(name, rttMs, dropped)`: `inflight--`, then adapt:
  - `dropped` (5xx / timeout / connection error): multiplicative decrease
    `limit ← max(minLimit, limit × backoffRatio)`.
  - success: only adjust when near saturation (`inflight ≥ limit/2`, so idle
    traffic doesn't inflate the limit). `gradient = clamp(rttNoLoad / rtt, 0.5, 1)`;
    `newLimit = limit × gradient + √limit` (the √ is the allowed queue);
    `limit ← clamp(smooth(limit, newLimit), minLimit, maxLimit)`.
- Observability: `currentLimit(name)`, `inFlight(name)`.

**Hot-path integration** (mirrors the scoreboard lifecycle, so the risk surface is
known):

- Acquire once per candidate, _before_ the same-target retry loop. If a candidate
  can't be acquired it is **saturated** — skip to the next candidate. This is a
  load-shed, **not a fault**, so it must NOT record a breaker failure.
- Release on every exit from a candidate:
  - failed over / errored → `record(dropped = true)` immediately, then continue.
  - **served** → hold the slot to `teardown()` (like the scoreboard), then
    `record(name, totalDurationMs, dropped = statusCode ≥ 500 || aborted)`.
- If the loop ends with no served target **and at least one candidate was skipped
  purely for saturation** (no real fault), return **503 + Retry-After** — genuine
  backpressure — instead of the generic 502.

**Config:** `ADAPTIVE_CONCURRENCY_ENABLED` (default off), `ADAPTIVE_MIN_LIMIT`,
`ADAPTIVE_MAX_LIMIT`, `ADAPTIVE_INITIAL_LIMIT`, `ADAPTIVE_BACKOFF_RATIO`,
`ADAPTIVE_SMOOTHING`.

### A2 — Request hedging

**Problem.** A single slow target drags a request's tail latency even when a
healthy sibling could have answered fast.

**Design.** Opt-in, **pre-first-byte only** (the body is fully buffered, so
replaying to a second target is exactly as safe as the existing same-target
retry). Per route: `hedgeDelayMs` (fire a second candidate if the first hasn't
returned response headers within this delay). One hedge (2 concurrent in flight)
by default.

- Each hedge branch runs under its **own child AbortController** linked to the
  request controller. The first branch to return a **usable** response (non-
  failover status) wins; the loser is aborted and its body destroyed.
- Exactly one response is served, metered, and holds the served slot(s). The
  loser is torn down and never metered — hedging trades a bounded extra
  **input-token** cost (the loser is aborted at/around headers, before output) for
  tail-latency. Gate it conservatively; document the tradeoff.
- A hedge that returns a failover status does not beat a still-pending sibling;
  if both hedges are unusable, outer failover continues to the remaining
  candidates. Breaker/outlier/limiter side effects are recorded per branch, but
  only the winner holds the scoreboard/limiter slot into teardown.

**Invariants preserved:** single `teardown()`; failover pre-first-byte only (a
hedge IS pre-first-byte); budget reserved once (worst-case for one response);
meter only the winner from raw provider usage; loser fully aborted.

**Config:** `HEDGE_ENABLED` (default off) + per-route `hedgeDelayMs`;
`HEDGE_MAX_ATTEMPTS` (default 2).

### A — verification

Unit: limiter gradient math (shrink on high RTT / drops, grow near saturation,
`tryAcquire` gates at `floor(limit)`). Integration: (1) saturated primary →
request sheds 503 when all candidates saturated; (2) slow primary + fast secondary
with hedging → secondary served, primary aborted, metered exactly once, one
teardown, budget committed once. Then the adversarial hot-path review pass.

---

## C — Conformance & load harness (planned)

Golden black-box record/replay of real provider SSE fixtures asserting the
pipeline invariants end-to-end, plus a k6/autocannon load profile asserting the
SLOs the M13 dashboards visualize.

## B — Native Vertex + Copilot adapters (planned)

Real `generateContent` ↔ canonical translation, Vertex SA-JWT/ADC auth, and
`thoughtSignature` round-trip fidelity (beyond the OpenAI-compat presets).

## D — Per-tenant routing (planned)

Let a tenant route the same client path to a different provider/model; additive on
the org→workspace spine, no tenant-boundary schema migration.

## E — Release & supply-chain hardening (planned)

SBOM + image signing (cosign / SLSA provenance) on the release pipeline; a
documented DR/restore drill for the Postgres source of truth.
