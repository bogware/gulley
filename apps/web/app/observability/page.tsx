'use client';

import { useEffect } from 'react';
import {
  Cell,
  Dot,
  EmptyState,
  ErrorNote,
  GridRow,
  Meter,
  PageHeader,
  Panel,
  PanelHeader,
  Spinner,
  StatTile,
  StatusChip,
} from '../../components/ui';
import { isNotConfigured } from '../../lib/api';
import { formatNum, formatTokens, formatUsd } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type { GatewayMetricsSummary } from '../../lib/types';

const ms = (s: number): string => (s >= 1 ? `${s.toFixed(2)}s` : `${Math.round(s * 1000)}ms`);

export default function ObservabilityPage() {
  const status = useAdminQuery((a) => a.observabilityStatus(), []);
  const metrics = useAdminQuery((a) => a.observabilityMetrics(), []);

  // Poll every 5s — the gateway counters are cumulative-since-boot per replica.
  useEffect(() => {
    const t = window.setInterval(() => metrics.refetch(), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const notConfigured =
    (status.data && status.data.configured === false) || isNotConfigured(metrics.error);
  const m: GatewayMetricsSummary | undefined = metrics.data?.metrics;

  return (
    <div>
      <PageHeader
        title="Observability"
        subtitle="Live gateway metrics — a point-in-time, per-replica snapshot of the Prometheus registry. Durable history is under Analytics."
        actions={
          status.data?.configured ? (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-secondary">
              <Dot tone={status.data.reachable ? 'green' : 'red'} />
              {status.data.reachable
                ? `gateway · ${status.data.latencyMs}ms`
                : 'gateway unreachable'}
            </span>
          ) : undefined
        }
      />

      {notConfigured ? (
        <Panel>
          <PanelHeader title="Live metrics not enabled" />
          <div className="p-4 text-[11.5px] leading-[1.7] text-body">
            Set <span className="font-mono text-ink">GATEWAY_METRICS_URL</span> (the gateway&apos;s
            Prometheus management listener, e.g.{' '}
            <span className="font-mono text-ink">http://gateway:9090/metrics</span>) and add its
            host to <span className="font-mono text-ink">OUTBOUND_HOST_ALLOWLIST</span> to surface
            live request rate, latency percentiles, cache hit rate, guardrail actions, failovers,
            and budget alerts here.
          </div>
        </Panel>
      ) : metrics.loading && !m ? (
        <Spinner />
      ) : metrics.error && !m ? (
        <ErrorNote error={metrics.error} />
      ) : m ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            <StatTile
              label="Requests"
              value={formatNum(m.requests.total)}
              hint={`${Math.round(m.requests.streamedShare * 100)}% streamed`}
            />
            <StatTile
              label="p50 latency"
              value={ms(m.duration.p50)}
              hint={`p90 ${ms(m.duration.p90)}`}
            />
            <StatTile
              label="p99 latency"
              value={ms(m.duration.p99)}
              hint={`avg ${ms(m.duration.avgSeconds)}`}
            />
            <StatTile
              label="Cache hit"
              value={`${(m.cache.hitRatio * 100).toFixed(1)}%`}
              hint={`${formatUsd(sum(m.cost.savedMicroUsd))} saved`}
            />
            <StatTile
              label="Cost"
              value={formatUsd(m.cost.totalMicroUsd)}
              hint={`${formatNum(m.cost.unpriced)} unpriced`}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Breakdown title="Requests by provider" data={m.requests.byProvider} fmt={formatNum} />
            <Breakdown title="Requests by status" data={m.requests.byStatus} fmt={formatNum} />
            <Breakdown title="Tokens by provider" data={m.tokens.byProvider} fmt={formatTokens} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Counters title="Guardrail actions" data={m.guardrail} />
            <Counters title="Failovers by target" data={m.failovers} />
            <Counters title="Budget alerts" data={m.budgetAlerts} />
          </div>

          <div className="text-[10px] text-micro">
            Snapshot at {new Date(m.scrapedAt).toLocaleTimeString()} · counters are cumulative since
            the replica&apos;s boot (this reflects one replica). Auto-refreshing every 5s.
          </div>
        </div>
      ) : (
        <EmptyState message="No metrics." />
      )}
    </div>
  );
}

function sum(r: Record<string, number>): number {
  return Object.values(r).reduce((a, b) => a + b, 0);
}

function Breakdown({
  title,
  data,
  fmt,
}: {
  title: string;
  data: Record<string, number>;
  fmt: (n: number) => string;
}) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  return (
    <Panel>
      <PanelHeader title={title} />
      <div className="flex flex-col p-3">
        {rows.length === 0 ? (
          <div className="py-3 text-center text-[11px] text-micro">no data</div>
        ) : (
          rows.map(([k, v]) => (
            <div key={k} className="mb-2 last:mb-0">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="truncate text-body">{k}</span>
                <span className="font-mono text-secondary">{fmt(v)}</span>
              </div>
              <Meter ratio={total ? v / total : 0} />
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function Counters({ title, data }: { title: string; data: Record<string, number> }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title={title} />
      {rows.length === 0 ? (
        <div className="py-4 text-center text-[11px] text-micro">none</div>
      ) : (
        <div>
          {rows.map(([k, v]) => (
            <GridRow key={k} cols="minmax(0,1fr) 70px">
              <Cell mono tone="body">
                {k}
              </Cell>
              <Cell align="right" mono tone="ink">
                {formatNum(v)}
              </Cell>
            </GridRow>
          ))}
        </div>
      )}
      {rows.length ? <div className="px-3 py-1" /> : null}
      <div className="flex justify-end px-3 pb-2">
        <StatusChip tone="neutral">live</StatusChip>
      </div>
    </Panel>
  );
}
