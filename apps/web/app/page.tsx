'use client';

import { useMemo } from 'react';
import {
  EmptyState,
  ErrorNote,
  PageHeader,
  Spinner,
  StatTile,
  StatusPill,
  Table,
  Td,
  Th,
} from '../components/ui';
import { UsageChart } from '../components/usage-chart';
import { formatNum, formatTime, formatTokens, formatUsd } from '../lib/format';
import { useAdminQuery } from '../lib/hooks';

export default function Dashboard() {
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const usage = useAdminQuery((api) => api.usage({ ...range, bucket: 'hour' }), []);
  const logs = useAdminQuery((api) => api.logs({ limit: 10 }), []);

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

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Spend and usage over the last 24 hours." />

      {usage.error ? <ErrorNote error={usage.error} /> : null}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Spend (24h)" value={formatUsd(totals.cost)} />
        <StatTile label="Requests" value={formatNum(totals.requests)} />
        <StatTile label="Input tokens" value={formatTokens(totals.input)} />
        <StatTile label="Output tokens" value={formatTokens(totals.output)} />
      </div>

      <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-2 text-sm font-medium">Spend per hour</div>
        {usage.loading ? <Spinner /> : <UsageChart buckets={buckets} metric="costMicroUsd" />}
      </div>

      <div className="mt-6">
        <div className="mb-2 text-sm font-medium">Recent requests</div>
        <div className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          {logs.loading ? (
            <Spinner />
          ) : logs.error ? (
            <ErrorNote error={logs.error} />
          ) : (logs.data?.entries.length ?? 0) === 0 ? (
            <EmptyState message="No requests yet." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Provider</Th>
                  <Th>Model</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Tokens</Th>
                  <Th className="text-right">Cost</Th>
                </tr>
              </thead>
              <tbody>
                {logs.data?.entries.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap text-neutral-500">
                      {formatTime(e.createdAt)}
                    </Td>
                    <Td>{e.provider}</Td>
                    <Td className="font-mono text-xs">{e.model}</Td>
                    <Td>
                      <StatusPill status={e.status} code={e.statusCode} />
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatTokens(e.inputTokens + e.outputTokens)}
                    </Td>
                    <Td className="text-right tabular-nums">{formatUsd(e.costMicroUsd)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
