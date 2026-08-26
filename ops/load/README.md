# Load & conformance harness

Two complementary checks, both asserting the SLOs the M13 dashboards visualize
(`ops/prometheus/gulley-slo-alerts.yml`): **availability 99.5%** (error ratio
< 0.005; only 5xx/transport count) and **p99 end-to-end latency < 10s**.

## In-process load smoke (no deploy, no provider cost)

Drives concurrent traffic through a full gateway backed by a fast fake upstream,
measuring the **pipeline** overhead (auth → authz → guardrail → cache → budget →
raw pipe → teardown). Manual, like the live-checks — not part of CI.

```bash
pnpm --filter @gulley/gateway load:check
# tune: LOAD_CONCURRENCY=100 LOAD_DURATION_MS=10000 LOAD_P99_MS=10000 LOAD_MAX_ERROR_RATIO=0.005
```

Exits non-zero on an SLO breach, so it can gate a branch locally.

## k6 against a deployed gateway

Hits a real deployment end-to-end (real provider latency included). Requires
[k6](https://k6.io).

```bash
GATEWAY_URL=https://gateway.example.com GATEWAY_KEY=gk_... MODEL=claude-sonnet-4-6 \
  k6 run ops/load/gateway-load.js
# tune: VUS=100 DURATION=2m P99_MS=10000 MAX_ERROR_RATIO=0.005
```

k6's `thresholds` fail the run on a breach, so this doubles as a pre-release gate
against staging.

## Conformance (correctness, in CI)

Provider wire-format correctness is a separate, CI-run suite:
`apps/gateway/src/conformance.test.ts` replays captured provider SSE fixtures
(`apps/gateway/src/conformance/fixtures/*.sse`) through the full gateway and
asserts raw-byte fidelity, meter-from-raw-usage, and single-teardown per fixture.
Add a provider quirk = add a fixture + a row.
