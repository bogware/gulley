# M20 — Wave 2: "Extend the moat"

Wave 2 of the killer-feature roadmap (`docs/AGENTGATEWAY_PORT.md`). Theme: press the
ground competitors can't structurally follow — native governance, hard-dollar
FinOps, and routing that self-hosts OpenRouter's convenience. Per-slice, tested,
gated, pushed.

## Landed (A–F, all on `main`)

| Slice                                  | What                                                                                                                                                                                                                                                                                                                                      | Config                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **A — jailbreak/injection classifier** | `InjectionDetector` — a local, RE2-safe classifier (instruction-override, system-prompt exfiltration, injected role/turn markers, decode-then-execute, jailbreak personas, zero-width smuggling). No egress, no paid managed service. Blocks/audits under the input policy, category-scopable.                                            | `GUARDRAILS_INJECTION_ENABLED`                         |
| **B — price/latency-aware routing**    | loadbalance `select: cheapest \| fastest \| least-load`. `rankPrice` (catalog) drives cheapest; the outlier EWMA TTFB drives fastest. OpenRouter's signature, self-hosted + governed.                                                                                                                                                     | `ROUTE_GROUPS[].select`                                |
| **C — prompt-cache savings analytics** | `CostBreakdown.cacheSavedUsd` + `gulley_cost_saved_micro_usd_total{source}` — surfaces the #1 cost lever (prompt caching), teed off the single request event.                                                                                                                                                                             | —                                                      |
| **D — budget alerts + gauge**          | `BudgetAlerter` fires as utilization crosses each level (once per level per period) → `gulley_budget_alerts_total{threshold}` + optional webhook, before the hard 402.                                                                                                                                                                    | `BUDGET_ALERT_WEBHOOK_URL`, `BUDGET_ALERT_THRESHOLDS`  |
| **E — budget-aware routing downshift** | At/above a utilization threshold, rewrite the request model to a cheaper one the route can serve — graceful degradation instead of a 402. Reserve stays worst-case; commit prices the downshifted model.                                                                                                                                  | `BUDGET_DOWNSHIFT_THRESHOLD`, `BUDGET_DOWNSHIFT_MODEL` |
| **F — multi-level budget caps**        | Per-model caps enforced _in addition to_ the workspace cap (both must admit). Per-scope reserve with rollback — no risky multi-key Lua. On any level's rejection the earlier reservations are released; teardown commits the actual to every reserved scope. Ordered after the E downshift so the model actually used is the one charged. | `BUDGET_MODEL_CAPS`                                    |

That covers **all three non-FinOps moat items** (A/B/C) and the full **FinOps
enforcement core** (D/E/F).

## Design note — multi-level enforcement (F)

The load-bearing hard-cap invariant is preserved by keeping every reserve **per
scope** (each already TOCTOU-safe) rather than a multi-key transaction:

- The cap resolver is composed: `model:<model>` scopes resolve from `BUDGET_MODEL_CAPS`
  (config), everything else from the DB `budget` table as before. The in-memory store
  (counter-less path) is seeded with the model caps so single-node enforcement works.
- The hot path reserves workspace first, then — after the E downshift, so the charged
  model is the one actually used — the `model:<model>` scope when the model is governed.
  On any rejection, `rejectBudget` releases every scope already reserved for the request
  (`commit(scope, id, 0)`) and returns 402; teardown commits the actual spend to each
  reserved scope. A held reservation can only ever cause a _conservative_ (spurious)
  rejection of a concurrent request, never a breach.

Org/project/key caps ride the same generalized scope machinery and can be added by
extending the resolver + the governed-scope set; spend forecasting + chargeback/showback
reports remain deferred (they ride on the per-minute usage rollups, a Wave-1 infra
follow-on).

## Conventions

Per-slice commits (`M20 A/B/…`): implement → focused tests → `bash ci/verify.sh`
green → commit `-s`. Hot-path slices carry a `Hotpath-Reviewed:` trailer.
