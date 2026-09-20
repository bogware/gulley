'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  Dot,
  EmptyState,
  ErrorNote,
  Meter,
  Panel,
  PanelHeader,
  SegmentedControl,
  Spinner,
  StatTile,
  StatusPill,
} from '../components/ui';
import { formatMs, formatNum, formatTokens, formatUsd } from '../lib/format';
import { useAdminQuery } from '../lib/hooks';

type Range = '1h' | '24h' | '7d' | '30d';
const RANGE_MS: Record<Range, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A tiny DOM sparkline: 1fr columns, each a bar scaled to the series max. */
function Sparkline({
  values,
  color = '#8FA9C6',
  h = 26,
}: {
  values: number[];
  color?: string;
  h?: number;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-px" style={{ height: h }}>
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-[1px]"
          style={{ height: `${Math.max(4, (v / max) * h)}%`, background: color }}
        />
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState<Range>('24h');
  const window = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - RANGE_MS[range]);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [range]);

  const bucket = range === '1h' ? 'minute' : range === '30d' ? 'day' : 'hour';
  const usage = useAdminQuery(
    (api) => api.usage({ ...window, bucket, groupBy: 'provider' }),
    [window.from, bucket],
  );
  const logs = useAdminQuery((api) => api.logs({ limit: 7 }), []);
  const providers = useAdminQuery((api) => api.providers(), []);
  const audit = useAdminQuery((api) => api.verifyAudit(), []);

  const buckets = usage.data?.buckets ?? [];
  const totals = buckets.reduce(
    (a, b) => ({
      requests: a.requests + b.requests,
      input: a.input + b.inputTokens,
      output: a.output + b.outputTokens,
      cost: a.cost + b.costMicroUsd,
    }),
    { requests: 0, input: 0, output: 0, cost: 0 },
  );

  // Per-time-bucket stack (input vs output tokens across providers) + a first-half vs
  // last-half delta as an honest in-range trend (no separate prior-period call).
  const byTime = useMemo(() => {
    const m = new Map<string, { input: number; output: number; cost: number }>();
    for (const b of buckets) {
      const e = m.get(b.bucketStart) ?? { input: 0, output: 0, cost: 0 };
      e.input += b.inputTokens;
      e.output += b.outputTokens;
      e.cost += b.costMicroUsd;
      m.set(b.bucketStart, e);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [buckets]);

  const trend = (pick: (e: { input: number; output: number; cost: number }) => number) => {
    if (byTime.length < 2) return undefined;
    const mid = Math.floor(byTime.length / 2);
    const first = byTime.slice(0, mid).reduce((s, [, e]) => s + pick(e), 0);
    const last = byTime.slice(mid).reduce((s, [, e]) => s + pick(e), 0);
    if (first === 0) return undefined;
    const pct = ((last - first) / first) * 100;
    return {
      dir: pct >= 0 ? ('up' as const) : ('down' as const),
      text: `${Math.abs(pct).toFixed(1)}% in-range`,
    };
  };

  const maxStack = Math.max(1, ...byTime.map(([, e]) => e.input + e.output));

  // Per-provider hourly spend for the health sparklines.
  const providerSeries = useMemo(() => {
    const m = new Map<string, number[]>();
    const times = [...new Set(buckets.map((b) => b.bucketStart))].sort();
    const idx = new Map(times.map((t, i) => [t, i]));
    for (const b of buckets) {
      const key = b.group ?? 'unknown';
      const arr = m.get(key) ?? new Array(times.length).fill(0);
      arr[idx.get(b.bucketStart) ?? 0] += b.costMicroUsd;
      m.set(key, arr);
    }
    return m;
  }, [buckets]);

  // Export = the usage buckets behind this view, as CSV (what the tiles are computed from).
  function exportCsv(): void {
    const header = 'bucketStart,group,requests,inputTokens,outputTokens,costMicroUsd';
    const rows = buckets.map((b) =>
      [b.bucketStart, b.group ?? '', b.requests, b.inputTokens, b.outputTokens, b.costMicroUsd]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([`${[header, ...rows].join('\n')}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gulley-usage-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeaderStrip
        range={range}
        onRange={setRange}
        onExport={exportCsv}
        exportable={buckets.length > 0}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* ---- left column ---- */}
        <div className="flex flex-col gap-3.5">
          {usage.error ? <ErrorNote error={usage.error} /> : null}

          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <StatTile
              label="Spend"
              value={formatUsd(totals.cost)}
              delta={withGood(
                trend((e) => e.cost),
                false,
              )}
            />
            <StatTile
              label="Requests"
              value={formatNum(totals.requests)}
              delta={withGood(
                trend((e) => e.input + e.output),
                true,
              )}
            />
            <StatTile label="Input tokens" value={formatTokens(totals.input)} />
            <StatTile label="Output tokens" value={formatTokens(totals.output)} />
          </div>

          <Panel>
            <PanelHeader
              title="Spend per hour"
              meta="input vs output tokens"
              right={
                <div className="flex items-center gap-2.5 font-mono text-[10px] text-secondary">
                  <Legend color="#2F5D8C" label="input" />
                  <Legend color="#7FA2C4" label="output" />
                </div>
              }
            />
            <div className="p-3">
              {usage.loading ? (
                <Spinner />
              ) : usage.error ? (
                <div className="p-3">
                  <ErrorNote error={usage.error} onRetry={usage.refetch} />
                </div>
              ) : byTime.length === 0 ? (
                <EmptyState message="No usage in range." />
              ) : (
                <div className="flex h-[150px] items-end gap-[3px]">
                  {byTime.map(([t, e]) => {
                    const total = e.input + e.output;
                    return (
                      <div
                        key={t}
                        className="group flex flex-1 flex-col justify-end"
                        title={`${timeLabel(t)} · ${formatTokens(total)} tok`}
                      >
                        <div
                          className="w-full rounded-t-[1px] bg-accent-soft transition-opacity group-hover:opacity-75"
                          style={{ height: `${(e.output / maxStack) * 100}%` }}
                        />
                        <div
                          className="w-full bg-accent transition-opacity group-hover:opacity-75"
                          style={{ height: `${(e.input / maxStack) * 100}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Recent requests"
              right={
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 font-mono text-[10px] text-secondary">
                    <Dot tone={logs.error ? 'red' : 'green'} /> {logs.error ? 'stale' : 'latest 7'}
                  </span>
                  <a href="/logs" className="text-[11px] text-accent hover:underline">
                    Open log browser →
                  </a>
                </div>
              }
            />
            {logs.loading ? (
              <Spinner />
            ) : logs.error ? (
              <div className="p-3">
                <ErrorNote error={logs.error} />
              </div>
            ) : (logs.data?.entries.length ?? 0) === 0 ? (
              <EmptyState message="No requests yet." />
            ) : (
              <div>
                <Row
                  header
                  cells={['Time', 'Provider', 'Model', 'Route', 'Status', 'Latency', 'Cost']}
                />
                {logs.data?.entries.map((e) => (
                  <Row
                    key={e.id}
                    cells={[
                      timeLabel(e.createdAt),
                      e.provider,
                      e.model,
                      e.route,
                      <StatusPill key="s" status={e.status} code={e.statusCode} />,
                      formatMs(e.latencyMs),
                      formatUsd(e.costMicroUsd),
                    ]}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* ---- right rail ---- */}
        <div className="flex flex-col gap-3.5">
          <Panel>
            <PanelHeader title="Provider health" />
            <div className="flex flex-col">
              {providers.loading ? (
                <Spinner />
              ) : providers.error ? (
                <div className="p-3">
                  <ErrorNote error={providers.error} onRetry={providers.refetch} />
                </div>
              ) : (providers.data?.providers.length ?? 0) === 0 ? (
                <EmptyState message="No providers configured." />
              ) : (
                providers.data?.providers.map((p) => {
                  const series = providerSeries.get(p.kind) ?? [];
                  const spend = series.reduce((s, v) => s + v, 0);
                  return (
                    <div
                      key={p.id}
                      className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2 last:border-0"
                    >
                      <Dot tone={p.enabled ? 'green' : 'amber'} halo={!p.enabled} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11.5px] font-medium text-ink">{p.kind}</div>
                        <div className="font-mono text-[10px] text-secondary">
                          {formatUsd(spend)} · range
                        </div>
                      </div>
                      <div className="w-[52px]">
                        <Sparkline values={series.length ? series : [0]} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Traffic mix" meta="by provider" />
            <div className="flex flex-col p-3">
              {[...providerSeries.entries()]
                .map(([k, s]) => [k, s.reduce((a, b) => a + b, 0)] as const)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <div key={k} className="mb-2 last:mb-0">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] text-body">{k}</span>
                      <span className="font-mono text-[10px] tabular-nums text-secondary">
                        {formatUsd(v)}
                      </span>
                    </div>
                    <Meter ratio={totals.cost ? v / totals.cost : 0} />
                  </div>
                ))}
              {providerSeries.size === 0 ? (
                <div className="py-4 text-center text-[11px] text-micro">No traffic in range.</div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Governance" />
            <div className="p-3">
              <KV
                label="Audit chain"
                value={audit.loading ? '…' : audit.data?.verified ? 'verified' : 'unverified'}
              />
              <KV label="Chain rows" value={audit.data ? formatNum(audit.data.count) : '—'} />
              <div
                className="mt-2.5 flex items-center gap-2 rounded-control border px-2.5 py-1.5 text-[11px]"
                style={
                  audit.data?.verified
                    ? { background: '#E3EFE1', borderColor: '#A8C3A6', color: '#2F5A34' }
                    : { background: '#F6E4E0', borderColor: '#D2A79F', color: '#8E2E22' }
                }
              >
                <Dot tone={audit.data?.verified ? 'green' : 'red'} />
                {audit.loading
                  ? 'Verifying audit chain…'
                  : audit.data?.verified
                    ? `Chain verified · ${formatNum(audit.data.count)} rows · 0 gaps`
                    : 'Audit chain could not be verified'}
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function withGood(
  d: { dir: 'up' | 'down'; text: string } | undefined,
  upIsGood: boolean,
): { dir: 'up' | 'down'; text: string; good: boolean } | undefined {
  if (!d) return undefined;
  return { ...d, good: d.dir === 'up' ? upIsGood : !upIsGood };
}

function PageHeaderStrip({
  range,
  onRange,
  onExport,
  exportable,
}: {
  range: Range;
  onRange: (r: Range) => void;
  onExport: () => void;
  exportable: boolean;
}) {
  return (
    <div className="-mx-5 -mt-4 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-header px-5 py-3.5">
      <div>
        <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">Overview</h1>
        <p className="mt-0.5 text-[11.5px] text-secondary">
          Cross-vendor spend, traffic and governance across the control plane.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <SegmentedControl
          value={range}
          onChange={onRange}
          options={[
            { value: '1h', label: '1h' },
            { value: '24h', label: '24h' },
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
          ]}
        />
        <Button
          variant="primary"
          onClick={onExport}
          disabled={!exportable}
          title="Download the usage buckets in range as CSV"
        >
          Export CSV
        </Button>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-[1px]" style={{ background: color }} />
      {label}
    </span>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line-soft py-1 font-mono text-[10.5px] last:border-0">
      <span className="text-micro">{label}</span>
      <span className="tabular-nums text-ink">{value}</span>
    </div>
  );
}

const GRID = 'grid-cols-[74px_84px_minmax(0,1fr)_96px_58px_64px_70px]';

function Row({ cells, header }: { cells: React.ReactNode[]; header?: boolean }) {
  return (
    <div
      className={`grid ${GRID} items-center gap-2 px-3 ${
        header
          ? 'border-b border-line bg-rail py-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-micro'
          : 'border-b border-line-soft py-[7px] text-[11.5px] transition-colors last:border-0 hover:bg-[#F3F0E8]'
      }`}
    >
      {cells.map((c, i) => (
        <div
          key={i}
          className={cx2(
            'truncate',
            i === 0 && 'font-mono text-secondary',
            i === 2 && 'font-mono text-ink',
            i === 3 && 'font-mono text-secondary',
            (i === 5 || i === 6) && 'text-right font-mono tabular-nums text-body',
            i === 1 && 'text-body',
          )}
        >
          {c}
        </div>
      ))}
    </div>
  );
}

function cx2(...p: Array<string | false | undefined>): string {
  return p.filter(Boolean).join(' ');
}
