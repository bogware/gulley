'use client';

import { useMemo, useState } from 'react';
import {
  Cell,
  EmptyState,
  ErrorNote,
  GridRow,
  MicroLabel,
  Panel,
  PanelHeader,
  SegmentedControl,
  Select,
  Spinner,
} from '../../components/ui';
import { formatNum, formatTokens, formatUsd } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type { UsageBucket, UsageBucketWidth } from '../../lib/types';

type Metric = 'cost' | 'tokens' | 'requests';
type GroupBy = 'provider' | 'model' | 'workspace';

const PALETTE = [
  '#2F5D8C',
  '#7FA2C4',
  '#4B7A4E',
  '#C67A28',
  '#6B4A7A',
  '#8FA9C6',
  '#A0392E',
  '#5F594D',
];
const PROVIDER_COLOR: Record<string, string> = {
  anthropic: '#2F5D8C',
  openai: '#7FA2C4',
  bedrock: '#4B7A4E',
  vertex: '#C67A28',
  azure: '#6B4A7A',
};

const metricOf = (b: UsageBucket, m: Metric): number =>
  m === 'cost' ? b.costMicroUsd : m === 'requests' ? b.requests : b.inputTokens + b.outputTokens;

const fmt = (v: number, m: Metric): string =>
  m === 'cost' ? formatUsd(v) : m === 'requests' ? formatNum(v) : formatTokens(v);

export default function AnalyticsPage() {
  const [rangeHours, setRangeHours] = useState(168);
  const [bucket, setBucket] = useState<UsageBucketWidth>('day');
  const [groupBy, setGroupBy] = useState<GroupBy>('provider');
  const [metric, setMetric] = useState<Metric>('cost');

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - rangeHours * 3600 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [rangeHours]);

  const q = useAdminQuery(
    (api) => api.usage({ ...range, bucket, groupBy }),
    [rangeHours, bucket, groupBy],
  );
  const buckets = q.data?.buckets ?? [];

  const { times, groups, grand, series, total, delta } = useMemo(() => {
    const times = [...new Set(buckets.map((b) => b.bucketStart))].sort();
    const tIdx = new Map(times.map((t, i) => [t, i]));
    const byGroup = new Map<string, number>();
    const series = new Map<string, number[]>();
    const grand = new Array(times.length).fill(0);
    for (const b of buckets) {
      const key = b.group ?? 'all';
      const v = metricOf(b, metric);
      byGroup.set(key, (byGroup.get(key) ?? 0) + v);
      const arr = series.get(key) ?? new Array(times.length).fill(0);
      const i = tIdx.get(b.bucketStart) ?? 0;
      arr[i] += v;
      grand[i] += v;
      series.set(key, arr);
    }
    const groups = [...byGroup.entries()].sort((a, b) => b[1] - a[1]);
    const total = groups.reduce((s, [, v]) => s + v, 0);
    let delta: { dir: 'up' | 'down'; pct: number } | undefined;
    if (grand.length >= 2) {
      const mid = Math.floor(grand.length / 2);
      const first = grand.slice(0, mid).reduce((a, b) => a + b, 0);
      const last = grand.slice(mid).reduce((a, b) => a + b, 0);
      if (first > 0)
        delta = { dir: last >= first ? 'up' : 'down', pct: (Math.abs(last - first) / first) * 100 };
    }
    return { times, groups, grand, series, total, delta };
  }, [buckets, metric]);

  const colorFor = (name: string, i: number): string =>
    groupBy === 'provider'
      ? (PROVIDER_COLOR[name] ?? PALETTE[i % PALETTE.length])
      : PALETTE[i % PALETTE.length];

  const maxStack = Math.max(1, ...grand);

  return (
    <div>
      <div className="-mx-5 -mt-4 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-header px-5 py-3.5">
        <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">Analytics</h1>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'cost', label: 'Cost' },
              { value: 'tokens', label: 'Tokens' },
              { value: 'requests', label: 'Requests' },
            ]}
          />
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="provider">group: provider</option>
            <option value="model">group: model</option>
            <option value="workspace">group: workspace</option>
          </Select>
          <Select value={bucket} onChange={(e) => setBucket(e.target.value as UsageBucketWidth)}>
            <option value="hour">bucket: hour</option>
            <option value="day">bucket: day</option>
          </Select>
          <Select
            value={String(rangeHours)}
            onChange={(e) => setRangeHours(Number(e.target.value))}
          >
            <option value="24">24 hours</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </Select>
        </div>
      </div>

      {q.error ? <ErrorNote error={q.error} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {/* hero */}
        <Panel className="lg:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-4 px-4 pt-3.5">
            <div>
              <MicroLabel>
                {metric} ·{' '}
                {rangeHours >= 168 ? `${Math.round(rangeHours / 24)} days` : `${rangeHours} hours`}
              </MicroLabel>
              <div className="mt-1 font-mono text-[30px] font-medium tabular-nums tracking-[-0.02em] text-ink">
                {fmt(total, metric)}
              </div>
              {delta ? (
                <div
                  className="mt-0.5 text-[11px]"
                  style={{ color: delta.dir === 'up' ? '#A0392E' : '#3D6B42' }}
                >
                  {delta.dir === 'up' ? '▲' : '▼'} {delta.pct.toFixed(1)}% first-half vs last-half
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2.5 font-mono text-[10px] text-secondary">
              {groups.slice(0, 6).map(([name], i) => (
                <span key={name} className="flex items-center gap-1">
                  <span
                    className="h-2 w-2 rounded-[1px]"
                    style={{ background: colorFor(name, i) }}
                  />
                  {name}
                </span>
              ))}
            </div>
          </div>
          <div className="p-4">
            {q.loading ? (
              <Spinner />
            ) : q.error ? (
              <div className="p-3">
                <ErrorNote error={q.error} onRetry={q.refetch} />
              </div>
            ) : times.length === 0 ? (
              <EmptyState message="No usage in range." />
            ) : (
              <div className="flex h-[168px] items-end gap-[2px]">
                {times.map((t, ti) => (
                  <div key={t} className="flex flex-1 flex-col justify-end" title={t}>
                    {groups.map(([name], gi) => {
                      const v = series.get(name)?.[ti] ?? 0;
                      if (v <= 0) return null;
                      return (
                        <div
                          key={name}
                          className="w-full transition-opacity hover:opacity-75"
                          style={{
                            height: `${(v / maxStack) * 100}%`,
                            background: colorFor(name, gi),
                          }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        {/* breakdown */}
        <Panel className="overflow-hidden">
          <PanelHeader title={`By ${groupBy}`} meta={`${groups.length} groups`} />
          {q.loading ? (
            <Spinner />
          ) : q.error ? (
            <div className="p-3">
              <ErrorNote error={q.error} onRetry={q.refetch} />
            </div>
          ) : groups.length === 0 ? (
            <EmptyState message="No usage in range." />
          ) : (
            <div>
              <GridRow cols="minmax(0,1fr) 78px 90px" header>
                <Cell>{groupBy}</Cell>
                <Cell align="right">Share</Cell>
                <Cell align="right">{metric}</Cell>
              </GridRow>
              {groups.map(([name, v], i) => (
                <GridRow key={name} cols="minmax(0,1fr) 78px 90px">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-[1px]"
                      style={{ background: colorFor(name, i) }}
                    />
                    <span className="truncate font-mono text-[11px] text-ink">{name}</span>
                  </div>
                  <Cell align="right" mono tone="secondary">
                    {total ? `${((v / total) * 100).toFixed(1)}%` : '—'}
                  </Cell>
                  <Cell align="right" mono>
                    {fmt(v, metric)}
                  </Cell>
                </GridRow>
              ))}
            </div>
          )}
        </Panel>

        {/* share meters */}
        <Panel>
          <PanelHeader title="Share of spend" meta={`by ${groupBy}`} />
          <div className="flex flex-col p-3">
            {groups.length === 0 ? (
              <div className="py-4 text-center text-[11px] text-micro">No usage in range.</div>
            ) : (
              groups.slice(0, 8).map(([name, v], i) => (
                <div key={name} className="mb-2.5 last:mb-0">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="truncate text-[11px] text-body">{name}</span>
                    <span className="font-mono text-[10px] tabular-nums text-secondary">
                      {fmt(v, metric)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-[2px] bg-inset shadow-field">
                    <div
                      className="h-full"
                      style={{
                        width: `${total ? (v / total) * 100 : 0}%`,
                        background: colorFor(name, i),
                      }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>

      <p className="mt-3 text-[10px] text-micro">
        Latency percentiles and prompt-cache economics are emitted by the gateway but not yet in the
        analytics DTO — a follow-up will surface them here.
      </p>
    </div>
  );
}
