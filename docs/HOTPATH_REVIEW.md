# Hot-path adversarial review

The data plane's hot path — `apps/gateway/src/routes/messages.ts` (`handleProxy`)
and the packages whose semantics it depends on — encodes invariants that are
correctness- and compliance-critical, not stylistic. A silent regression here
(double teardown, a leaked budget reservation, a failover after first byte,
metering off a canonical token field) is a SOC 2 / billing incident. Ordinary
review under-catches these because the bug is usually in an interaction the diff
doesn't show on its face. So changes to these files get an **adversarial review
pass** before merge, and CI records that the pass happened.

## What counts as hot-path

`ci/hotpath-guard.sh` is the source of truth (its manifest maps globs →
invariants). Today that is:

| Area                                  | Invariant at risk                                                      |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `apps/gateway/src/routes/messages.ts` | raw-pipe fidelity, single `teardown()`, failover ordering              |
| `apps/gateway/src/context.ts`         | which ports/sinks the pipeline runs with                               |
| `apps/gateway/src/reconcile.ts`       | live route swap preserves breaker/scoreboard/budget state by reference |
| `packages/budget/*`                   | reserve/commit (TOCTOU-safe worst-case, refund on teardown)            |
| `packages/cost/*`                     | per-provider usage inclusion + golden fixtures                         |
| `packages/cache/*`                    | key partitioning by authz scope + PII/secret exclusion                 |
| `packages/routing/*`                  | failover / circuit breaker / outlier / load balancing                  |
| `packages/providers/src/sse.ts`       | SSE state machine (streaming usage extraction)                         |

## The review pass

Run the review against the branch diff, either way:

- **Reusable workflow** (multi-agent, if you have it): `Workflow({ name: 'hotpath-review' })`.
  It fans out one reviewer per invariant dimension over the changed hot-path
  files, then adversarially verifies each finding (each verifier is prompted to
  _refute_) so only confirmed defects survive. See `.claude/workflows/hotpath-review.js`.
- **`/code-review ultra`** — the built-in cloud multi-agent review of the current
  branch (or `/code-review ultra <PR#>`). User-triggered and billed.

The bar is the same one this codebase has been held to: every confirmed finding
is fixed with a regression test before merge.

## Recording it (the CI gate)

`ci/hotpath-guard.sh` runs in CI. It prints which invariants the diff touches. In
strict mode (CI sets `HOTPATH_STRICT=1`) it **fails** unless a commit in the range
carries a trailer acknowledging the review:

```
Hotpath-Reviewed: adversarial pass, 0 confirmed findings
```

Add it with `git commit -s` (alongside the required DCO `Signed-off-by`), or
append it to any commit in the branch. The trailer is the auditable record that
the pass ran — it is not a substitute for actually running it.

Locally, preview what a PR would flag:

```bash
bash ci/hotpath-guard.sh                 # informational, vs origin/main
HOTPATH_STRICT=1 bash ci/hotpath-guard.sh   # what CI enforces
```
