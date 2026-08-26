'use client';

import { useMemo, useState } from 'react';
import {
  Card,
  EmptyState,
  ErrorNote,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { UsageChart } from '../../components/usage-chart';
import { formatNum, formatTokens, formatUsd } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type { UsageBucketWidth } from '../../lib/types';

type Metric = 'costMicroUsd' | 'requests' | 'inputTokens' | 'outputTokens';
type GroupBy = '' | 'provider' | 'model' | 'workspace';

export default function AnalyticsPage() {
  const [rangeHours, setRangeHours] = useState(24);
  const [bucket, setBucket] = useState<UsageBucketWidth>('hour');
  const [groupBy, setGroupBy] = useState<GroupBy>('provider');
  const [metric, setMetric] = useState<Metric>('costMicroUsd');

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - rangeHours * 3600 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [rangeHours]);

  const q = useAdminQuery(
    (api) => api.usage({ ...range, bucket, groupBy: groupBy || undefined }),
    [rangeHours, bucket, groupBy],
  );

  const buckets = q.data?.buckets ?? [];
  const byGroup = new Map<
    string,
    { requests: number; input: number; output: number; cost: number }
  >();
  for (const b of buckets) {
    const key = b.group ?? 'all';
    const g = byGroup.get(key) ?? { requests: 0, input: 0, output: 0, cost: 0 };
    g.requests += b.requests;
    g.input += b.inputTokens;
    g.output += b.outputTokens;
    g.cost += b.costMicroUsd;
    byGroup.set(key, g);
  }
  const groups = [...byGroup.entries()].sort((a, b) => b[1].cost - a[1].cost);

  return (
    <div>
      <PageHeader title="Analytics" subtitle="Time-bucketed spend and token usage." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={String(rangeHours)} onChange={(e) => setRangeHours(Number(e.target.value))}>
          <option value="24">Last 24h</option>
          <option value="168">Last 7d</option>
          <option value="720">Last 30d</option>
        </Select>
        <Select value={bucket} onChange={(e) => setBucket(e.target.value as UsageBucketWidth)}>
          <option value="minute">by minute</option>
          <option value="hour">by hour</option>
          <option value="day">by day</option>
        </Select>
        <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
          <option value="">no split</option>
          <option value="provider">by provider</option>
          <option value="model">by model</option>
          <option value="workspace">by workspace</option>
        </Select>
        <Select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          <option value="costMicroUsd">cost</option>
          <option value="requests">requests</option>
          <option value="inputTokens">input tokens</option>
          <option value="outputTokens">output tokens</option>
        </Select>
      </div>

      {q.error ? <ErrorNote error={q.error} /> : null}

      <Card className="p-4">
        {q.loading ? <Spinner /> : <UsageChart buckets={buckets} metric={metric} />}
      </Card>

      <div className="mt-6">
        <div className="mb-2 text-sm font-medium">Breakdown{groupBy ? ` by ${groupBy}` : ''}</div>
        <Card>
          {q.loading ? (
            <Spinner />
          ) : groups.length === 0 ? (
            <EmptyState message="No usage in range." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{groupBy || 'total'}</Th>
                  <Th className="text-right">Requests</Th>
                  <Th className="text-right">Input</Th>
                  <Th className="text-right">Output</Th>
                  <Th className="text-right">Cost</Th>
                </tr>
              </thead>
              <tbody>
                {groups.map(([name, g]) => (
                  <tr key={name}>
                    <Td className="font-mono text-xs">{name}</Td>
                    <Td className="text-right tabular-nums">{formatNum(g.requests)}</Td>
                    <Td className="text-right tabular-nums">{formatTokens(g.input)}</Td>
                    <Td className="text-right tabular-nums">{formatTokens(g.output)}</Td>
                    <Td className="text-right tabular-nums">{formatUsd(g.cost)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
