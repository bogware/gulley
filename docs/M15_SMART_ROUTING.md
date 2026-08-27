# M15 — Smart Routing

Classification-driven routing: after authn/authz (pre-first-byte), the gateway
optionally **classifies** the inbound request into a category and reroutes it
based on that category — cheap prompts to a small model, code to a code model,
sensitive prompts to a guarded path, or any operator-defined taxonomy. It is
opt-in, fully config-driven, and composes with everything already built (the
model router, per-tenant overrides, the failover loop).

Smart routing is a **strategy _selector_**, not a new routing strategy. It sits
in the same precedence chain as the model router and the per-tenant override,
reassigning the `strategy`/`createExtractor` locals in `handleProxy` before
candidate selection. The `single | loadbalance | fallback` union and the
synchronous `selectCandidates` are unchanged.

## Locked decisions

1. **Classifier backends (operator-selectable per policy):**
   - `embedding-nearest-label` — embed the prompt (reusing the semantic-cache
     `EmbeddingProvider`) and pick the nearest labeled centroid / kNN over
     operator exemplars. Fastest + cheapest; no extra LLM round-trip.
   - `llm-router` — forward the prompt to a designated model that returns a
     category label. Most flexible; costs a round-trip (metered, see §Cost).
   - `rules-then-llm` — synchronous regex/keyword/length rules first; escalate
     to `llm-router` only on no-match.
2. **Objectives** (all four; they are just distinct label vocabularies feeding
   the same engine — no per-objective code branch): cost/complexity tiering,
   domain/skill routing, safety/risk routing, operator-defined taxonomy.
3. **Scope & precedence.** Config is resolved by selector precedence
   **user → group → route → workspace/tenant → org**, most-specific wins, with an
   explicit numeric `priority` tie-break. Runtime routing precedence is
   **route.strategy < model-router < smart-router < tenant-pin** — the per-tenant
   residency/isolation pin stays final.
4. **Groups** are a lightweight **claim/tag** on the principal
   (`scope.groups: string[]`), sourced from an IdP JWT `groups` claim, a Basic
   per-user override, or a `groups` column on the virtual key. No managed-group
   tables, no join, no extra per-request lookup.
5. **Per-user** identity is the JWT `sub` / Basic username where present; in pure
   virtual-key mode `principal.id` is the key id, so "per-user" == "per-key". No
   `user_id` column is added to virtual keys.
6. **Classifier cost** is **sub-metered** against the tenant budget under a
   derived request id `${requestId}#classify`, with its own `proxy.classify`
   ledger + audit line, metered only from raw provider usage — gated by a
   `meterClassifier` policy flag. It never registers a second `teardown()` and
   never calls `reply.hijack()`.
7. **Safety vs residency.** The per-tenant residency pin always wins (the
   classifier runs _below_ the tenant override); a safety category selects among
   the tenant's allowed targets but cannot move a request off a pinned provider.
   A per-policy flag can opt a policy out.
8. **Defaults:** multi-group ties break by policy `priority`; an unconfigured
   scope or an unknown category **fails open to the model router** (never a 5xx);
   a classification is memoized per session-affinity key + prompt hash to
   amortize `llm-router` cost across a conversation; default method is
   `rules-then-llm` for safety/risk and `embedding-nearest-label` for cost-tier,
   with a ~200 ms classifier timeout.

## Invariants preserved

- **Single teardown.** The classifier's spend is accounted in its own
  reserve→forward→commit; `teardown()` stays byte-identical, budget-commit-first.
- **Failover pre-first-byte only.** Classification is pre-first-byte; on
  timeout/error/breaker-open it is a no-op — `strategy` keeps the model-router
  result, so fallback is free.
- **Meter only from raw provider usage** — the classifier sub-call meters via a
  `UsageExtractor` + `@gulley/cost`, exactly like the main path.
- **Metering correctness.** A category that crosses provider _family_ carries its
  own `createExtractor`, or teardown mis-meters (same rule as `TenantRoute`).
- **Secret-ARN-only.** A policy references an existing provider by kind (reusing
  its resolved credential) or carries a branded `SecretRef`; `assertNoInlineSecret`
  rejects any inline key.

## The seam

`apps/gateway/src/routes/messages.ts` `handleProxy` declares `let strategy` /
`let createExtractor` and reassigns them in precedence order (route → model-router
→ tenant). The classifier is one more link, inserted **after authn (principal
known) and before the tenant block**, finishing before `selectCandidates`. On a
category hit it reassigns `strategy` (+ `createExtractor` on a cross-family
reroute) and optionally rewrites `parsed['model']`/`body`, exactly as the model
router does. On any miss it does nothing.

## Config model

A `smartRoutingPolicies` `ConfigEntity` collection (mirrors `route`; inherits
reconcile/export/GitOps/drift). Each policy `config` carries: `objective`,
`classifier { mode, model?/labels?/rules?, credentialRef | SecretRef, timeoutMs,
meterClassifier }`, a `categoryRoutes` map (category → strategy/target ref),
`selector { user?, group?, org?, route?, tenant? }`, and `priority`. Validated by
a Zod schema at the consumer boundary (`buildSmartRoutingFromDocument`), which
rejects the reconcile and keeps the prior snapshot on a parse failure. Off unless
`ctx.smartRouter`/`ctx.smartRoutes` are wired — single-tenant deployments are
unchanged.

## Phases (each independently verifiable + committable)

| Phase  | Scope                                                                                                                              | Hot-path |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **A1** | Group primitive: `scope.groups`, `virtual_key.groups`, populate in all resolvers.                                                  | no       |
| **A2** | Declarative policy types + `MapSmartRouteResolver` (selector precedence + priority), a pure `@gulley/routing` module.              | no       |
| **B**  | `smartRoutingPolicies` collection + `smart_routing_policy` table + Zod-validated `buildSmartRoutingFromDocument` + reconcile swap. | no       |
| **C**  | Classifier engine (`rules-then-llm`, `embedding-nearest-label` + centroid store, `llm-router`) + timeout/breaker.                  | no       |
| **D**  | Wire `ctx.smartRouter`/`ctx.smartRoutes`; insert the classify stage; miss/timeout = no-op. **→ adversarial review.**               | yes      |
| **E**  | Classifier sub-metering (`${requestId}#classify`, `proxy.classify`, `meterClassifier`). **→ adversarial review.**                  | yes      |
| **F**  | Hot-path review, docs + roadmap, `smart:check` live smoke.                                                                         | —        |

## Status — delivered

All phases are delivered, verified (`ci/verify.sh` green), and committed; the two
hot-path phases (D, E) each passed the adversarial review gate — D fixed two
confirmed findings (unwired `kind:model` fail-open; decisions keyed by policy
object, not name), E had zero confirmed findings (cost-compute hardened into the
fail-open guard as defense-in-depth). Off unless `SMART_ROUTING_ENABLED=true`
(DB config), so single-tenant deployments are unchanged.

**Classifier backends:** `rules-then-llm` and `llm-router` are fully wired and,
for `llm-router`, metered. The `embedding-nearest-label` **ports**
(`ClassifierEmbedder`, `CentroidIndex`) are defined and the engine path exists,
but its labeled-centroid store + exemplar management is an additive follow-on (it
needs a `classifier_centroid` table separate from `semantic_vector`, whose
`cache_entry` FK forbids standalone exemplars). The `llm-router` completer speaks
the **Anthropic-canonical** response shape; other classifier provider families are
additive.

**Also delivered:** groups as a claim/tag (`scope.groups` from a key column or JWT
`groups` claim); per-user via JWT `sub`/Basic username; the residency-pin fully
preempts smart routing (the per-policy opt-out is a future knob); selector
precedence user > group > route > workspace > org with priority tie-break; the
`smartRoutingPolicies` GitOps config collection.

**Smoke:** `pnpm --filter @gulley/gateway smart:check` runs the router over sample
prompts (rules + a stubbed metered `llm-router`) and prints the decisions +
`proxy.classify` metering — a deterministic, no-cost end-to-end demonstration.

## Operator notes & known limitations

- **Classifier ordering / data-handling (llm-router & embedding).** The classifier
  runs after authn but **before** authz, rate-limit, and input guardrails —
  because authz must validate the _rewritten_ model, classification has to precede
  it. So a `llm-router`/`embedding` policy makes a **bounded upstream classifier
  call** (≤ `timeoutMs`, ≤ 16 output tokens, breaker-guarded, to the **operator's
  own** provider) that is: (a) **not covered by input-guardrail masking** — the
  prompt reaching the classifier is the pre-mask prompt; and (b) **not
  rate-limited** — an over-RPM client can still drive (bounded) classifier calls.
  If you require masking-before-any-egress or strict rate-limiting of every
  provider call, use **`rules-then-llm` with local rules** (no upstream, no
  egress) — the safe default. The classifier sub-call is fail-open and its spend
  is metered on its own `proxy.classify` line (best-effort, off the served
  request's critical path).
- **Multi-tenant selector scoping.** Policies are matched by `selector`, which keys
  off runtime IDs (workspace/org **ids**) while the config document nests under
  **names** — so the owning workspace is not auto-injected and a policy with no
  `selector.workspace` is **global**. Correct for v1 (single-tenant per
  deployment); a multi-tenant deployment **must pin `selector.workspace`** (the
  workspace id) on each policy, or it applies to every tenant.
- **Embedding backend is inert until wired.** With no embedder/centroids in the
  reconcile deps, an `embedding-nearest-label` policy always abstains (fails open
  to the model router). The `classifier_centroid` store + a classifier breaker in
  the production reconcile path are the follow-ons that make it live.
