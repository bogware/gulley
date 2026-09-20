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

| Area                                   | Invariant at risk                                                      |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `apps/gateway/src/routes/messages.ts`  | raw-pipe fidelity, single `teardown()`, failover ordering              |
| `apps/gateway/src/context.ts`          | which ports/sinks the pipeline runs with                               |
| `apps/gateway/src/reconcile.ts`        | live route swap preserves breaker/scoreboard/budget state by reference |
| `packages/budget/*`                    | reserve/commit (TOCTOU-safe worst-case, refund on teardown)            |
| `packages/cost/*`                      | per-provider usage inclusion + golden fixtures                         |
| `packages/cache/*`                     | key partitioning by authz scope + PII/secret exclusion                 |
| `packages/routing/*`                   | failover / circuit breaker / outlier / load balancing                  |
| `packages/providers/src/sse.ts`        | SSE state machine (streaming usage extraction)                         |
| `packages/providers/src/*eventstream*` | Bedrock `vnd.amazon.eventstream` decode                                |
| `packages/guardrails/src/*stream*`     | streaming output guardrail primitives (audit-only invariant)           |

## The review pass

Run the review against the branch diff, either way:

- **`/hotpath-review`** — the multi-agent workflow in
  `.claude/workflows/hotpath-review.js` (Claude Code). It computes the hot-path
  diff vs `origin/main`, fans out one reviewer per invariant dimension
  (fidelity/teardown, budget, failover, metering, cache scope), then
  adversarially verifies each finding (each verifier is prompted to _refute_) so
  only confirmed defects survive.
- **`/code-review ultra`** — the built-in cloud multi-agent review of the current
  branch (or `/code-review ultra <PR#>`). User-triggered and billed.

The bar is the same one this codebase has been held to: every confirmed finding
is fixed with a regression test before merge.

## Recording it (the CI gate)

`ci/hotpath-guard.sh` runs in CI (the `hotpath` job in `.github/workflows/ci.yml`
and `.azuredevops/azure-pipelines.yml`, both with full history). It prints which
invariants the diff touches. In strict mode (CI sets `HOTPATH_STRICT=1`) it
**fails** unless a commit in the range carries a trailer acknowledging the review:

```
Hotpath-Reviewed: adversarial pass, 0 confirmed findings
```

Add it with `git commit -s` (alongside the required DCO `Signed-off-by`), or
append it to any commit in the branch. The trailer is the auditable record that
the pass ran — it is not a substitute for actually running it. Strict mode also
fails when the base ref cannot be found (a shallow checkout), so a missing history
can never silently skip the guard.

Locally, preview what a PR would flag:

```bash
bash ci/hotpath-guard.sh                    # informational, vs origin/main (else main)
HOTPATH_STRICT=1 bash ci/hotpath-guard.sh   # what CI enforces
bash ci/hotpath-guard.sh <base-ref>         # diff against another base (or set HOTPATH_BASE)
```
