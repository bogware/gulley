'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Cell,
  Dot,
  EmptyState,
  ErrorNote,
  GridRow,
  Input,
  Panel,
  Select,
  Spinner,
  StatusChip,
  StatusPill,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { formatMs, formatTime, formatTokens, formatUsd } from '../../lib/format';
import type { LogFilter, RequestLog, RequestStatus } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const COLS = '80px 84px minmax(0,1fr) 120px 58px 60px 72px 78px';

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
}

export default function LogsPage() {
  const { api } = useAdmin();
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [entries, setEntries] = useState<RequestLog[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<RequestLog | null>(null);

  const buildFilter = useCallback(
    (cur?: string): LogFilter => ({
      limit: 25,
      provider: provider || undefined,
      model: model || undefined,
      status: (status || undefined) as RequestStatus | undefined,
      minStatusCode: errorsOnly ? 400 : undefined,
      cursor: cur,
    }),
    [provider, model, status, errorsOnly],
  );

  // Sequence guard: a slow earlier response must never overwrite a newer page.
  const seq = useRef(0);

  const applyFilters = useCallback(async () => {
    if (!api) return;
    const my = ++seq.current;
    setLoading(true);
    setError(undefined);
    try {
      const page = await api.logs(buildFilter(undefined));
      if (my !== seq.current) return;
      setEntries(page.entries);
      setCursor(page.nextCursor);
      // Keep the open drawer if its entry is still in the result set.
      setSelected((cur) => (cur && page.entries.some((e) => e.id === cur.id) ? cur : null));
    } catch (e) {
      if (my === seq.current) setError(msg(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [api, buildFilter]);

  // Discrete controls (status, errors-only) apply immediately; the free-text fields
  // apply on Enter / the Apply button — not a request per keystroke.
  useEffect(() => {
    void applyFilters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status, errorsOnly]);

  async function loadMore(): Promise<void> {
    if (!api || !cursor) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const page = await api.logs(buildFilter(cursor));
      if (my !== seq.current) return;
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (e) {
      if (my === seq.current) setError(msg(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }

  return (
    <div>
      {/* filter bar (header strip) */}
      <div className="-mx-5 -mt-4 mb-4 flex flex-wrap items-center gap-2 border-b border-line bg-header px-5 py-3">
        <div className="mr-1">
          <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">Request logs</h1>
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <Input
            className="w-40"
            placeholder="⌕ provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void applyFilters()}
          />
          <Input
            className="w-48"
            placeholder="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void applyFilters()}
          />
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">status: any</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
            <option value="aborted">aborted</option>
          </Select>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-body">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
              className="accent-accent"
            />
            errors only
          </label>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-secondary">
            {entries.length} shown · keyset
          </span>
          <Button onClick={() => void applyFilters()}>Apply</Button>
        </div>
      </div>

      {error ? <ErrorNote error={error} onRetry={() => void applyFilters()} /> : null}

      <div className="flex gap-4">
        {/* table */}
        <Panel className="min-w-0 flex-1 overflow-hidden">
          {loading && entries.length === 0 ? (
            <Spinner />
          ) : entries.length === 0 ? (
            <EmptyState message="No requests match these filters." />
          ) : (
            <div className="overflow-x-auto">
              <div style={{ minWidth: '760px' }}>
                <GridRow cols={COLS} header>
                  <Cell>Time</Cell>
                  <Cell>Provider</Cell>
                  <Cell>Model</Cell>
                  <Cell>Principal</Cell>
                  <Cell>Status</Cell>
                  <Cell align="right">Lat</Cell>
                  <Cell align="right">Tokens</Cell>
                  <Cell align="right">Cost</Cell>
                </GridRow>
                {entries.map((e) => (
                  <GridRow
                    key={e.id}
                    cols={COLS}
                    onClick={() => setSelected(e)}
                    selected={selected?.id === e.id}
                  >
                    <Cell mono tone="secondary">
                      {timeLabel(e.createdAt)}
                    </Cell>
                    <Cell tone="body">{e.provider}</Cell>
                    <Cell mono tone="ink">
                      {e.model}
                    </Cell>
                    <Cell mono tone="secondary">
                      {e.principalId}
                    </Cell>
                    <Cell>
                      <StatusPill status={e.status} code={e.statusCode} />
                    </Cell>
                    <Cell align="right" mono>
                      {formatMs(e.latencyMs)}
                    </Cell>
                    <Cell align="right" mono>
                      {formatTokens(e.inputTokens + e.outputTokens)}
                    </Cell>
                    <Cell align="right" mono>
                      {formatUsd(e.costMicroUsd)}
                    </Cell>
                  </GridRow>
                ))}
              </div>
            </div>
          )}
          {cursor ? (
            <div className="flex items-center justify-center gap-3 border-t border-line px-3 py-2.5">
              <Button onClick={() => void loadMore()} disabled={loading}>
                {loading ? 'Loading…' : 'Load more'}
              </Button>
              <span className="truncate font-mono text-[10px] text-secondary">
                cursor {cursor.slice(0, 22)}…
              </span>
            </div>
          ) : null}
        </Panel>

        {/* in-panel detail drawer */}
        {selected ? <LogDrawer log={selected} onClose={() => setSelected(null)} /> : null}
      </div>
    </div>
  );
}

const PIPELINE = ['auth', 'rbac', 'budget', 'guardrails', 'cache', 'route', 'upstream'] as const;

function LogDrawer({ log, onClose }: { log: RequestLog; onClose: () => void }) {
  const ok = log.status === 'ok';
  const rows: Array<[string, string]> = [
    ['request id', log.requestId],
    ['principal', log.principalId],
    ['workspace', log.workspaceId],
    ['route', log.route],
    ['provider / model', `${log.provider} · ${log.model}`],
    ['status', `${log.statusCode} (${log.status})`],
    ['streamed', String(log.streamed)],
    ['input tokens', String(log.inputTokens)],
    ['output tokens', String(log.outputTokens)],
    ['cost', formatUsd(log.costMicroUsd)],
    ['latency', formatMs(log.latencyMs)],
    ['timestamp', formatTime(log.createdAt)],
  ];
  return (
    <Panel className="w-[392px] shrink-0 self-start overflow-hidden shadow-drawer">
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-medium text-ink">Request detail</span>
          <span className="font-mono text-2xs text-secondary">{log.requestId.slice(0, 16)}…</span>
        </div>
        <button
          onClick={onClose}
          className="text-secondary transition-colors hover:text-ink"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* key/value */}
      <dl className="px-3 py-2">
        {rows.map(([k, v]) => (
          <div
            key={k}
            className="flex justify-between gap-4 border-b border-line-soft py-[3px] last:border-0"
          >
            <dt className="font-mono text-[10.5px] text-micro">{k}</dt>
            <dd className="break-all text-right font-mono text-[10.5px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      {/* pipeline */}
      <div className="border-t border-line px-3 py-2.5">
        <div className="mb-2 text-[9px] font-medium uppercase tracking-[0.14em] text-micro">
          Pipeline
        </div>
        <div className="flex flex-col gap-1">
          {PIPELINE.map((stage, i) => {
            // The stages an ok request cleared; a failed request terminates at the
            // response. Per-stage timing isn't in the log DTO (follow-up), so this shows
            // the pipeline structure + the real terminal outcome, not fabricated ms.
            const failed = !ok && i === PIPELINE.length - 1;
            return (
              <div key={stage} className="flex items-center gap-2">
                <span
                  className={`flex h-[14px] w-[14px] items-center justify-center rounded-[2px] text-[9px] ${
                    failed ? 'bg-err-bg text-err-text' : 'bg-ok-bg text-ok-text'
                  }`}
                >
                  {failed ? '✕' : '✓'}
                </span>
                <span className="text-[11px] text-body">{stage}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* payload note (content capture is off by default) */}
      <div className="border-t border-line px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-micro">
            Payload
          </span>
          <span className="font-mono text-[9px] text-secondary">content-off default</span>
        </div>
        <div className="rounded-control border border-line-soft bg-inset px-2.5 py-2 font-mono text-[10.5px] leading-[1.55] text-secondary">
          Payload capture is off for this workspace. Enable per-workspace content capture (none /
          metadata / full) to inspect the masked request/response here.
        </div>
      </div>

      {/* attributes */}
      {log.attributes && Object.keys(log.attributes).length > 0 ? (
        <div className="border-t border-line px-3 py-2.5">
          <div className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.14em] text-micro">
            Attributes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(log.attributes).map(([k, v]) => (
              <StatusChip key={k} tone="neutral">
                {k}={String(v)}
              </StatusChip>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-line px-3 py-2">
        <Dot tone={ok ? 'green' : log.status === 'aborted' ? 'amber' : 'red'} />
        <span className="text-[10.5px] text-secondary">
          {ok
            ? 'Completed'
            : log.status === 'aborted'
              ? 'Aborted by client'
              : 'Terminated with an error'}
        </span>
      </div>
    </Panel>
  );
}
