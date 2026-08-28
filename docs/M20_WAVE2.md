# M20 — Wave 2: "Extend the moat"

Wave 2 of the killer-feature roadmap (`docs/AGENTGATEWAY_PORT.md`). Theme: press the
ground competitors can't structurally follow — native governance, hard-dollar
FinOps, and routing that self-hosts OpenRouter's convenience. Per-slice, tested,
gated, pushed.

## Landed (A–E, all on `main`)

| Slice                                  | What                                                                                                                                                                                                                                                                                           | Config                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **A — jailbreak/injection classifier** | `InjectionDetector` — a local, RE2-safe classifier (instruction-override, system-prompt exfiltration, injected role/turn markers, decode-then-execute, jailbreak personas, zero-width smuggling). No egress, no paid managed service. Blocks/audits under the input policy, category-scopable. | `GUARDRAILS_INJECTION_ENABLED`                         |
| **B — price/latency-aware routing**    | loadbalance `select: cheapest \| fastest \| least-load`. `rankPrice` (catalog) drives cheapest; the outlier EWMA TTFB drives fastest. OpenRouter's signature, self-hosted + governed.                                                                                                          | `ROUTE_GROUPS[].select`                                |
| **C — prompt-cache savings analytics** | `CostBreakdown.cacheSavedUsd` + `gulley_cost_saved_micro_usd_total{source}` — surfaces the #1 cost lever (prompt caching), teed off the single request event.                                                                                                                                  | —                                                      |
| **D — budget alerts + gauge**          | `BudgetAlerter` fires as utilization crosses each level (once per level per period) → `gulley_budget_alerts_total{threshold}` + optional webhook, before the hard 402.                                                                                                                         | `BUDGET_ALERT_WEBHOOK_URL`, `BUDGET_ALERT_THRESHOLDS`  |
| **E — budget-aware routing downshift** | At/above a utilization threshold, rewrite the request model to a cheaper one the route can serve — graceful degradation instead of a 402. Reserve stays worst-case; commit prices the downshifted model.                                                                                       | `BUDGET_DOWNSHIFT_THRESHOLD`, `BUDGET_DOWNSHIFT_MODEL` |

That covers **all three non-FinOps moat items** (A/B/C) and **two of the three FinOps
pieces** (D/E).

## Remaining (the FinOps enforcement core — a dedicated reviewed slice)

**Multi-level budget caps** (org / project / key / model, most-constrained wins).
This is the one Wave-2 piece not yet landed, and deliberately so: it touches the
load-bearing hard-cap safety invariant. The clean design (no risky multi-key Lua)
is a **per-scope reserve with rollback**:

- Generalize the cap resolver to any scope key (`ws:…`, `model:…`, `key:…`, `org:…`)
  — model/key/org caps from config or a `budget.scope` column; workspace as today.
- The gateway reserves against each applicable scope sequentially (each reserve is
  already TOCTOU-safe per scope); on any rejection, release the earlier reservations
  (`commit(scope, id, 0)`) and 402. Teardown commits the actual to every reserved
  scope.
- Careful ordering with the M20 E downshift (reserve the _final_, post-downshift
  model so per-model spend is attributed correctly), plus an adversarial review of
  the multi-reserve/rollback/dual-commit hot-path — the same discipline every
  budget-safety change in this repo gets.

Spend forecasting + chargeback/showback reports were explicitly deferred at Wave-2
scoping (they ride on the per-minute usage rollups, a Wave-1 infra follow-on).

## Conventions

Per-slice commits (`M20 A/B/…`): implement → focused tests → `bash ci/verify.sh`
green → commit `-s`. Hot-path slices carry a `Hotpath-Reviewed:` trailer.
