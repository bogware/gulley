# Ops artifacts

Operator-facing observability for the Gulley gateway. Everything here is driven by
the Prometheus metrics the gateway exposes on its **separate management listener**
(`/metrics` on `METRICS_PORT`, default 9090 — never the data port) and the OTLP
traces/logs it exports when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The compose file
(`deploy/docker-compose.prod.yml`) publishes that listener on `127.0.0.1:9090` only;
the Helm chart annotates the gateway pods for scraping (`gateway.metricsAnnotations`).
`gulley_build_info` carries the running version + git sha.

## `prometheus/gulley-slo-alerts.yml`

Recording + alerting rules for a **99.5% availability, p99 < 10s** SLO over 30 days,
using multi-window multi-burn-rate alerts (Google SRE workbook):

- `GulleyErrorBudgetBurnFast` (page) — ~14.4× burn confirmed on 5m **and** 1h.
- `GulleyErrorBudgetBurnSlow` (ticket) — ~6× burn on 30m **and** 6h.
- `GulleyLatencySLOBreach` (warning) — p99 > 10s for 10m.
- `GulleyBudgetRejectionsSpiking` / `GulleyFailoversElevated` — capacity signals.

`status="error"` is a gateway/upstream failure; a 4xx **client** error is
`status="ok"` with a 4xx `status_code`, so client mistakes never burn the budget.

Add to `prometheus.yml`:

```yaml
rule_files:
  - gulley-slo-alerts.yml
```

## `grafana/gulley-gateway-dashboard.json`

A RED + cost dashboard: request rate, error ratio (SLO-thresholded), p50/p95/p99
latency, cost/hr, cache hit ratio, tokens/s, guardrail actions, failovers — with a
`provider` template variable. Import via Grafana → Dashboards → Import, and pick a
Prometheus datasource.

## Traces & access logs

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, each request emits a CLIENT span with
per-stage child spans (`admission`, `upstream.ttfb`, `stream`) and a
`gulley.trace_id`. With `ACCESS_LOG_OTLP=true`, the operator-configured access log
(`ACCESS_LOG_FIELDS`) is also shipped to the OTLP **logs** endpoint (`/v1/logs`) as
structured, credential-free records that correlate to the span by trace id.
