import { assertEgressAllowed } from '@gulley/egress';

/**
 * Console-facing gateway observability. The gateway exposes a hand-rolled Prometheus
 * registry on a SEPARATE management listener (METRICS_PORT, not the data port), so the
 * control-api fetches that text (egress-guarded, exactly like the shadow-spend admin
 * clients), parses the v0.0.4 exposition with a PURE parser, and folds it into a JSON
 * summary the console can render.
 *
 * Caveats surfaced to the UI: the counters are cumulative-since-boot and per-replica, so
 * a scrape is a point-in-time single-replica snapshot — the durable, fleet-complete
 * figures live in /admin/analytics/usage + the ledger. This endpoint is LIVE OPS (latency
 * percentiles, cache hit rate, failovers, budget alerts), not the billing source of truth.
 */

export interface PromSample {
  labels: Record<string, string>;
  value: number;
}
export interface PromHistogram {
  labels: Record<string, string>; // label set minus `le`
  buckets: Array<{ le: number; count: number }>;
  sum: number;
  count: number;
}
export interface ParsedMetrics {
  counters: Map<string, PromSample[]>;
  histograms: Map<string, PromHistogram[]>;
}

const MAX_TEXT_BYTES = 4_000_000; // cap a hostile/huge scrape

function parseLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  // name="value" pairs; values may contain escaped quotes/backslashes.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1] as string] = (m[2] as string).replace(/\\(["\\n])/g, (_s, c) =>
      c === 'n' ? '\n' : c,
    );
  }
  return out;
}

/** Pure Prometheus text-exposition (v0.0.4) parser. Defensive: unknown metric names
 *  fall through into the counters map; malformed lines are skipped, never thrown. */
export function parsePromText(text: string): ParsedMetrics {
  const counters = new Map<string, PromSample[]>();
  const histBuckets = new Map<string, PromHistogram>(); // keyed by base+labelset(minus le)
  const histOrder = new Map<string, PromHistogram[]>();

  const capped = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
  for (const line of capped.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // name{labels} value   OR   name value
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/.exec(t);
    if (!m) continue;
    const name = m[1] as string;
    const labels = parseLabels(m[2]?.slice(1, -1));
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;

    if (name.endsWith('_bucket') || name.endsWith('_sum') || name.endsWith('_count')) {
      const base = name.replace(/_(bucket|sum|count)$/, '');
      const { le, ...rest } = labels;
      const key = base + '|' + JSON.stringify(rest);
      let h = histBuckets.get(key);
      if (!h) {
        h = { labels: rest, buckets: [], sum: 0, count: 0 };
        histBuckets.set(key, h);
        const arr = histOrder.get(base) ?? [];
        arr.push(h);
        histOrder.set(base, arr);
      }
      if (name.endsWith('_bucket') && le !== undefined) {
        h.buckets.push({ le: le === '+Inf' ? Infinity : Number(le), count: value });
      } else if (name.endsWith('_sum')) h.sum = value;
      else if (name.endsWith('_count')) h.count = value;
      continue;
    }
    const arr = counters.get(name) ?? [];
    arr.push({ labels, value });
    counters.set(name, arr);
  }
  for (const h of histBuckets.values()) h.buckets.sort((a, b) => a.le - b.le);
  return { counters, histograms: histOrder };
}

export interface GatewayMetricsSummary {
  scrapedAt: string;
  requests: {
    total: number;
    byStatus: Record<string, number>;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    streamedShare: number;
  };
  tokens: { input: number; output: number; byProvider: Record<string, number> };
  cost: { totalMicroUsd: number; savedMicroUsd: Record<string, number>; unpriced: number };
  cache: { byStatus: Record<string, number>; hitRatio: number };
  guardrail: Record<string, number>;
  failovers: Record<string, number>;
  budgetAlerts: Record<string, number>;
  duration: { count: number; avgSeconds: number; p50: number; p90: number; p99: number };
}

function sumBy(samples: PromSample[] | undefined, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples ?? []) {
    const k = s.labels[label] ?? 'unknown';
    out[k] = (out[k] ?? 0) + s.value;
  }
  return out;
}
const total = (samples: PromSample[] | undefined): number =>
  (samples ?? []).reduce((a, s) => a + s.value, 0);

/** Linear-interpolated quantile from cumulative histogram buckets (aggregated across
 *  label sets). Returns seconds. */
function quantile(hists: PromHistogram[] | undefined, q: number): number {
  if (!hists || hists.length === 0) return 0;
  const merged = new Map<number, number>();
  let count = 0;
  for (const h of hists) {
    count += h.count;
    for (const b of h.buckets) merged.set(b.le, (merged.get(b.le) ?? 0) + b.count);
  }
  if (count === 0) return 0;
  const bounds = [...merged.entries()].sort((a, b) => a[0] - b[0]);
  const target = q * count;
  let prevLe = 0;
  let prevCum = 0;
  for (const [le, cum] of bounds) {
    if (cum >= target) {
      if (!Number.isFinite(le)) return prevLe;
      const frac = cum > prevCum ? (target - prevCum) / (cum - prevCum) : 0;
      return prevLe + (le - prevLe) * frac;
    }
    prevLe = Number.isFinite(le) ? le : prevLe;
    prevCum = cum;
  }
  return prevLe;
}

export function summarizeGatewayMetrics(
  p: ParsedMetrics,
  scrapedAt: string,
): GatewayMetricsSummary {
  const reqs = p.counters.get('gulley_requests_total');
  const reqTotal = total(reqs);
  const streamed = (reqs ?? [])
    .filter((s) => s.labels['streamed'] === 'true')
    .reduce((a, s) => a + s.value, 0);
  const tokens = p.counters.get('gulley_tokens_total');
  const cache = p.counters.get('gulley_cache_events_total');
  const cacheByStatus = sumBy(cache, 'status');
  const hits = (cacheByStatus['hit-exact'] ?? 0) + (cacheByStatus['hit-semantic'] ?? 0);
  const cacheTotal = Object.values(cacheByStatus).reduce((a, b) => a + b, 0);
  const dur = p.histograms.get('gulley_request_duration_seconds');
  const durCount = (dur ?? []).reduce((a, h) => a + h.count, 0);
  const durSum = (dur ?? []).reduce((a, h) => a + h.sum, 0);

  return {
    scrapedAt,
    requests: {
      total: reqTotal,
      byStatus: sumBy(reqs, 'status'),
      byProvider: sumBy(reqs, 'provider'),
      byModel: sumBy(reqs, 'model'),
      streamedShare: reqTotal > 0 ? streamed / reqTotal : 0,
    },
    tokens: {
      input: (tokens ?? [])
        .filter((s) => s.labels['type'] === 'input')
        .reduce((a, s) => a + s.value, 0),
      output: (tokens ?? [])
        .filter((s) => s.labels['type'] === 'output')
        .reduce((a, s) => a + s.value, 0),
      byProvider: sumBy(tokens, 'provider'),
    },
    cost: {
      totalMicroUsd: total(p.counters.get('gulley_cost_micro_usd_total')),
      savedMicroUsd: sumBy(p.counters.get('gulley_cost_saved_micro_usd_total'), 'source'),
      unpriced: total(p.counters.get('gulley_unpriced_requests_total')),
    },
    cache: { byStatus: cacheByStatus, hitRatio: cacheTotal > 0 ? hits / cacheTotal : 0 },
    guardrail: sumBy(p.counters.get('gulley_guardrail_actions_total'), 'action'),
    failovers: sumBy(p.counters.get('gulley_failovers_total'), 'target'),
    budgetAlerts: sumBy(p.counters.get('gulley_budget_alerts_total'), 'threshold'),
    duration: {
      count: durCount,
      avgSeconds: durCount > 0 ? durSum / durCount : 0,
      p50: quantile(dur, 0.5),
      p90: quantile(dur, 0.9),
      p99: quantile(dur, 0.99),
    },
  };
}

export interface GatewayMetricsOptions {
  url: string;
  allowlist?: ReadonlySet<string> | readonly string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Egress-guarded fetch of the gateway's raw Prometheus text. */
export async function fetchGatewayMetricsText(opts: GatewayMetricsOptions): Promise<string> {
  assertEgressAllowed(opts.url, { allowlist: opts.allowlist, requireHttps: false });
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  timer.unref?.();
  try {
    const res = await doFetch(opts.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`gateway metrics endpoint returned ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** A GatewayMetricsProvider is the ControlContext port: returns a parsed summary or
 *  raw text, or throws (routes map a throw to 502). */
export interface GatewayMetricsProvider {
  summary(now: string): Promise<GatewayMetricsSummary>;
  raw(): Promise<string>;
  status(
    now: string,
  ): Promise<{ reachable: boolean; scrapedAt: string; latencyMs: number; error?: string }>;
}

export function buildGatewayMetricsProvider(opts: GatewayMetricsOptions): GatewayMetricsProvider {
  return {
    async summary(now) {
      return summarizeGatewayMetrics(parsePromText(await fetchGatewayMetricsText(opts)), now);
    },
    async raw() {
      return fetchGatewayMetricsText(opts);
    },
    async status(now) {
      const started = Date.now();
      try {
        await fetchGatewayMetricsText({
          ...opts,
          timeoutMs: Math.min(opts.timeoutMs ?? 5000, 3000),
        });
        return { reachable: true, scrapedAt: now, latencyMs: Date.now() - started };
      } catch (e) {
        return {
          reachable: false,
          scrapedAt: now,
          latencyMs: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
