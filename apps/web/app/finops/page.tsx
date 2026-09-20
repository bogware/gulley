'use client';

import { useMemo, useState } from 'react';
import {
  Cell,
  EmptyState,
  ErrorNote,
  GridRow,
  InlineResult,
  Meter,
  PageHeader,
  Panel,
  PanelHeader,
  SegmentedControl,
  Select,
  Spinner,
  StatTile,
  StatusChip,
  Tabs,
} from '../../components/ui';
import { isNotConfigured } from '../../lib/api';
import { formatNum, formatTokens, formatUsd } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type { ChargebackRow, ShadowSpendReport } from '../../lib/types';

type Tab = 'chargeback' | 'shadow';
type GroupBy =
  'workspace' | 'provider' | 'model' | 'attr:agent' | 'attr:repo' | 'attr:dev' | 'attr:session';

export default function FinOpsPage() {
  const [tab, setTab] = useState<Tab>('chargeback');
  return (
    <div>
      <PageHeader
        title="FinOps"
        subtitle="Cost attribution across coding agents, repos, and developers — and the CISO bypass alert."
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'chargeback', label: 'Chargeback' },
            { value: 'shadow', label: 'Shadow-spend' },
          ]}
        />
      </div>
      {tab === 'chargeback' ? <Chargeback /> : <ShadowSpend />}
    </div>
  );
}

function Chargeback() {
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('7d');
  const [groupBy, setGroupBy] = useState<GroupBy>('attr:agent');
  const window = useMemo(() => {
    const to = new Date();
    const ms = range === '24h' ? 86_400_000 : range === '7d' ? 604_800_000 : 2_592_000_000;
    return { from: new Date(to.getTime() - ms).toISOString(), to: to.toISOString() };
  }, [range]);

  const q = useAdminQuery((a) => a.chargeback({ ...window, groupBy }), [range, groupBy]);
  const rows: ChargebackRow[] = (q.data?.rows ?? [])
    .slice()
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  const total = rows.reduce((a, r) => a + r.costMicroUsd, 0);
  const saved = rows.reduce((a, r) => a + (r.cacheSavedMicroUsd ?? 0), 0);

  function csv(): void {
    const header = 'key,requests,inputTokens,outputTokens,costUsd,cacheSavedUsd\n';
    const body = rows
      .map((r) =>
        [
          r.key ?? 'un-attributed',
          r.requests,
          r.inputTokens,
          r.outputTokens,
          (r.costMicroUsd / 1e6).toFixed(6),
          ((r.cacheSavedMicroUsd ?? 0) / 1e6).toFixed(6),
        ].join(','),
      )
      .join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gulley-chargeback-${groupBy.replace(':', '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (q.error && isNotConfigured(q.error)) {
    return (
      <Panel>
        <PanelHeader title="Chargeback needs a database" />
        <div className="p-4 text-[11.5px] text-body">
          Chargeback aggregates the durable spend ledger — configure DATABASE_URL to enable it.
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="attr:agent">by agent (claude-code vs codex)</option>
            <option value="attr:repo">by repo</option>
            <option value="attr:dev">by developer</option>
            <option value="attr:session">by session</option>
            <option value="workspace">by workspace</option>
            <option value="model">by model</option>
            <option value="provider">by provider</option>
          </Select>
          <SegmentedControl
            value={range}
            onChange={setRange}
            options={[
              { value: '24h', label: '24h' },
              { value: '7d', label: '7d' },
              { value: '30d', label: '30d' },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <StatTileInline label="Total" value={formatUsd(total)} />
          <StatTileInline label="Cache saved" value={formatUsd(saved)} />
        </div>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader
          title={`Spend by ${groupBy}`}
          meta={`${rows.length}`}
          right={
            <button onClick={csv} className="text-[11px] text-accent hover:underline">
              Export CSV
            </button>
          }
        />
        {q.loading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-3">
            <ErrorNote error={q.error} onRetry={q.refetch} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState message="No spend in range." />
        ) : (
          <div className="overflow-x-auto">
            <div style={{ minWidth: '640px' }}>
              <GridRow cols="minmax(0,1fr) 150px 76px 82px 82px 84px" header>
                <Cell>{groupBy}</Cell>
                <Cell>Share</Cell>
                <Cell align="right">Requests</Cell>
                <Cell align="right">In</Cell>
                <Cell align="right">Out</Cell>
                <Cell align="right">Cost</Cell>
              </GridRow>
              {rows.map((r, i) => (
                <GridRow key={i} cols="minmax(0,1fr) 150px 76px 82px 82px 84px">
                  <Cell mono tone="ink">
                    {r.key ?? <span className="text-micro">un-attributed</span>}
                  </Cell>
                  <div className="pr-2">
                    <Meter ratio={total ? r.costMicroUsd / total : 0} />
                  </div>
                  <Cell align="right" mono>
                    {formatNum(r.requests)}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {formatTokens(r.inputTokens)}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {formatTokens(r.outputTokens)}
                  </Cell>
                  <Cell align="right" mono tone="ink">
                    {formatUsd(r.costMicroUsd)}
                  </Cell>
                </GridRow>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function ShadowSpend() {
  const q = useAdminQuery((a) => a.shadowSpend(), []);
  const report: ShadowSpendReport | undefined = q.data;

  if (q.error && isNotConfigured(q.error)) {
    return (
      <Panel>
        <PanelHeader title="Shadow-spend needs a database + provider admin keys" />
        <div className="p-4 text-[11.5px] leading-[1.7] text-body">
          Reconciliation compares each provider&apos;s own billed usage against gateway-mediated
          ledger spend. Configure DATABASE_URL and the provider admin API keys
          (ANTHROPIC_ADMIN_API_KEY / OPENAI_ADMIN_API_KEY) to surface spend that bypassed Gulley.
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {report?.flagged ? (
        <InlineResult tone="err">
          Bypass detected — provider-billed spend exceeds gateway-mediated spend beyond the
          threshold.
        </InlineResult>
      ) : report ? (
        <InlineResult tone="ok">
          No bypass flagged — provider billing reconciles with the gateway ledger.
        </InlineResult>
      ) : null}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Reconciliation by provider"
          meta={
            report?.reconciledProviders
              ? `${report.reconciledProviders.length} reconciled`
              : undefined
          }
        />
        {q.loading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-3">
            <ErrorNote error={q.error} />
          </div>
        ) : (report?.rows.length ?? 0) === 0 ? (
          <EmptyState message="No reconciliation data." />
        ) : (
          <div>
            <GridRow cols="minmax(0,1fr) 100px 100px 100px 70px 70px" header>
              <Cell>Provider</Cell>
              <Cell align="right">Gateway</Cell>
              <Cell align="right">Provider</Cell>
              <Cell align="right">Shadow</Cell>
              <Cell align="right">Ratio</Cell>
              <Cell align="right">Flag</Cell>
            </GridRow>
            {(report?.rows ?? [])
              .slice()
              .sort((a, b) => b.shadowMicroUsd - a.shadowMicroUsd)
              .map((r) => (
                <GridRow key={r.provider} cols="minmax(0,1fr) 100px 100px 100px 70px 70px">
                  <Cell tone="ink">{r.provider}</Cell>
                  <Cell align="right" mono>
                    {formatUsd(r.gatewayMicroUsd)}
                  </Cell>
                  <Cell align="right" mono>
                    {formatUsd(r.providerMicroUsd)}
                  </Cell>
                  <Cell align="right" mono tone={r.flagged ? 'ink' : 'secondary'}>
                    {formatUsd(r.shadowMicroUsd)}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {(r.shadowRatioBps / 100).toFixed(1)}%
                  </Cell>
                  <div className="flex justify-end">
                    <StatusChip tone={r.flagged ? 'red' : 'green'}>
                      {r.flagged ? 'bypass' : 'ok'}
                    </StatusChip>
                  </div>
                </GridRow>
              ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function StatTileInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-line-card bg-panel px-3 py-1.5">
      <span className="text-[9px] uppercase tracking-[0.14em] text-micro">{label} </span>
      <span className="font-mono text-[13px] tabular-nums text-ink">{value}</span>
    </div>
  );
}
