# Wave A — Unblock & Make It Honest (implementation plan)

Wave A of the killer-feature cycle (see the "One Plane, Both Agents" strategy report and
`memory/killer-feature-cycle-2026-09`). Wave A precedes any demo: it fixes the Tier-0 bugs
that **falsify the invariants the product sells**, and turns on the wiring the whole cross-vendor
moat depends on. Almost every item is "secretly small". The GTM decisions taken 2026-09-06 —
**all-open (OSS)**, **general-tech lead**, **local/IDE Codex + Claude Code only**, **single-tenant
per deployment** — put a premium on adoption/DX and on the caching/cost-saving story, so those are
weighted first.

Guiding rule: **do not ship a governance claim on top of a broken invariant.** Fix the credibility
floor, then build.

---

## Delivered (on `agentgateway-port`)

Each hot-path commit passed the adversarial `hotpath-review` (0 confirmed findings) and carries the
`Hotpath-Reviewed:` trailer; the full local gate is green (format + lint + typecheck + test + build).

- **Slice 1** — Tier-0 trust fixes + cache-cost visibility (audit-append advisory lock + teardown
  isolation; durable admin/PII-reveal audit; refusal-cache guard; gateway cache-hit dollars-avoided
  metered under `response_cache`; body-size limit + trust-proxy knobs); config-convergence poll;
  `gulley doctor`; cross-vendor positioning refresh.
- **Slice 2** — config-propagation emit wire (control plane); budget-downshift worst-case reprice;
  off-catalog model metering (observe always + opt-in fail-closed).
- **Wave B opener** — cache ↔ output-enforcement coexistence (a clean, no-transform response is now
  cacheable under DLP enforcement; masked/redacted/blocked/sensitive/plugin-masked never cached).

**Deferred (own designed PR):** hedge/failover **loser** metering. The loser branch's body is drained
(`resume()`) without parsing usage, so metering it needs either a reserve-2×-on-fire path or parsing
a discarded stream — both touch the metering invariants and warrant a dedicated hot-path-reviewed
change rather than a rushed addition. Off-catalog metering (its sibling in the original slice-2 item)
is delivered.

---

## Landing in this PR (Wave A · slice 1)

Weighted to the caching / cost-saving focus and the trust floor; all off the raw-byte streaming
path or minimal-touch, each with tests.

### Caching & cost (the money story)

1. **Request body-size limit + trust-proxy hardening** — `MAX_REQUEST_BYTES` (default 32 MiB) wired
   as Fastify `bodyLimit` in `server.ts`; `TRUST_PROXY` knob so an operator can pin a hop count /
   CIDR instead of trusting every hop (the CEL source-IP allowlist is otherwise spoofable). The
   1 MiB Fastify default silently 413s long-context / multimodal / large-cache-prefix coding
   prompts — the exact payload shape that carries the big cacheable prefixes. Unblocking it is the
   precondition for caching those requests at all.
2. **Refusal responses are no longer cached** — a refusal is HTTP 200 with empty/partial content
   (`stop_reason: "refusal"`); caching it made every semantic-cache paraphrase serve the refusal.
   Guarded at the cache-store site (`n.stopReason !== 'refusal'`).
3. **Gateway cache-hit dollars-avoided are now metered** — `serveFromCache` recorded `costMicroUsd: 0`
   with **no** savings signal, so the product's headline "cost avoided" number was invisible for its
   own two-tier cache. It now prices the cached tokens at the model's full rate and emits
   `cacheSavedMicroUsd` under a new `cacheSavedSource` label (`response_cache`), distinct from the
   existing provider `prompt_cache` savings. The savings also land on the cache-hit request-log
   attributes and audit payload.

### Trust floor

4. **Audit-append race fixed** — `PostgresAuditSink.append` did a read-tail + insert with no lock, so
   two concurrent appends could read the same tail and one was silently dropped by the unique index.
   Now serialized with a transaction-scoped advisory lock (`pg_advisory_xact_lock`), auto-released on
   commit. Independently, the per-request `proxy.request` append in the gateway teardown is wrapped in
   its own try/catch so an audit failure can no longer **cascade** to skip cache-store + mask-vault
   persist. (Hot-path teardown edit — carries a `Hotpath-Reviewed:` trailer.)
5. **Admin & PII-reveal audits are durable** — the control-plane audit sink was `InMemoryAuditSink`
   even with `DATABASE_URL` set, so every admin mutation and every mask-vault PII reveal was
   "audited" to memory wiped on restart. Now backed by `PostgresAuditSink` when a DB is present, and
   `verifyAudit` verifies the durable chain (`verifyAuditChain` over `readAuditRows`).
6. **Config actually converges without a redeploy** — a DB-config gateway only picked up an apply via
   `NOTIFY` (unwired) or a listen-socket reconnect, so a long-lived replica never saw new config after
   boot. Added a bounded **version-poll resync** to `ConfigWatcher` (`CONFIG_POLL_INTERVAL_SECONDS`,
   default 30 s): it compares `versions.currentVersion()` to the last applied and reconciles if
   behind — belt-and-suspenders that converges the fleet even if a `NOTIFY` is missed. Safe because
   the reconciler is already single-flight + fail-safe (keeps last-good config on a build/secret
   failure).
7. **`gulley doctor`** — a config-coherence preflight (`pnpm --filter @gulley/gateway doctor`) that
   fails loudly on the built-but-unwired footguns: DB set but `CONFIG_SOURCE=env`; `MASK_VAULT_PERSIST`
   without KMS on a multi-replica deploy; `trustProxy` trusting all hops while a CEL IP rule is set;
   budgets configured without the counters Redis; a body limit left at a risky value; no provider
   credentials. Institutionalizes this wave so the failure mode becomes a boot/CI error, not a silent
   prod gap.

---

## Next PR (Wave A · slice 2)

- **Control-plane config EMIT wire** — construct a `PostgresConfigBus` notifier in the control-api
  `buildContext` (mirroring the gateway subscriber) + a `CONFIG_NOTIFY_CHANNEL` knob, so
  `/config/apply` broadcasts `NOTIFY` and the fleet reconciles in ~ms rather than waiting for the
  poll. **Gated on** a re-verification that `GatewayReconciler` keeps last-good on a bad/secret-
  unresolvable document (it does today) — turning emit on means a bad apply reconciles the whole
  fleet at once, so the fail-safe must be proven first. The poll (slice 1) already delivers the
  outcome; emit is the latency upgrade.
- **Hedge / failover loser + off-catalog metering** — meter drained hedge-loser branches and charge a
  worst-case (or a metric + fail-closed knob) for a served model absent from the price catalog, so
  real provider spend can't be invisible to the budget. Hot-path; its own reviewed PR.
- **Budget downshift worst-case recompute** — reserve the _downshifted_ model's worst-case against its
  own cap (today it reserves the expensive model's worst-case and spuriously 402s the traffic
  downshift exists to save). Precondition for the Wave-B graceful-degradation ladder.
- **Pre-first-byte admission deadline** — a single `REQUEST_DEADLINE_MS` bounding the whole
  authn→authz→guardrail→cache→reserve→dispatch path, reusing the existing `AbortController`.
- **Budget counter self-heal** — rebuild the Redis committed counter from the ledger on boot/schedule
  so a counters-Redis flush can't over-admit past the hard cap.
- **`count_tokens`** — register `POST /v1/messages/count_tokens` (Anthropic passthrough + local
  estimate) and feed the estimate into the reserve path (a conformance fix _and_ a budget-accuracy
  fix that removes worst-case over-reservation 402s on long-context prompts).
- **Telemetry flush on drain** — call `context.telemetry.forceFlush()/shutdown()` in the gateway
  SIGTERM handler so the last span batch isn't dropped every deploy.
- **CEL `matches()` → RE2** — replace raw `new RegExp` on the pre-admission path (ReDoS) with a
  bounded/RE2 matcher, honoring the "RE2-safe" posture.

---

## Cross-feature ordering (do not violate)

- Cache ↔ output-enforcement coexistence must land **before** any "DLP default-on for coding routes"
  (Wave B) — today enforcement zeroes the cache, which would gut the cache-savings story on exactly
  the coding traffic where caching matters most.
- The continuous audit → WORM shipper (Wave C) must land **after** the audit-append fix (this PR) —
  shipping WORM over a chain that drops rows signs an immutable, incomplete evidence artifact.

## Invariants carried through every change

Raw-byte fidelity; one centralized teardown; pre-first-byte-only failover; meter-from-raw-usage;
cap-all-buffering; secret-ARNs-only; role-split Redis. Every edit to `messages.ts` / budget / cost /
cache / routing / `sse.ts` carries the `Hotpath-Reviewed:` trailer per `ci/hotpath-guard.sh`.
