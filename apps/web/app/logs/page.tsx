'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusPill,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { formatMs, formatTime, formatTokens, formatUsd } from '../../lib/format';
import type { LogFilter, RequestLog, RequestStatus } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

  const applyFilters = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(undefined);
    setSelected(null);
    try {
      const page = await api.logs(buildFilter(undefined));
      setEntries(page.entries);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, [api, buildFilter]);

  useEffect(() => {
    void applyFilters();
  }, [applyFilters]);

  async function loadMore(): Promise<void> {
    if (!api || !cursor) return;
    setLoading(true);
    try {
      const page = await api.logs(buildFilter(cursor));
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader title="Request logs" subtitle="Every proxied request, filtered and paginated." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          className="w-40"
          placeholder="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
        <Input
          className="w-52"
          placeholder="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">any status</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="aborted">aborted</option>
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
          />
          errors only
        </label>
        <Button onClick={() => void applyFilters()}>Refresh</Button>
      </div>

      {error ? <ErrorNote error={error} /> : null}

      <Card>
        {loading && entries.length === 0 ? (
          <Spinner />
        ) : entries.length === 0 ? (
          <EmptyState message="No requests match these filters." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Provider</Th>
                <Th>Model</Th>
                <Th>Status</Th>
                <Th className="text-right">Latency</Th>
                <Th className="text-right">Tokens</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                >
                  <Td className="whitespace-nowrap text-neutral-500">{formatTime(e.createdAt)}</Td>
                  <Td>{e.provider}</Td>
                  <Td className="font-mono text-xs">{e.model}</Td>
                  <Td>
                    <StatusPill status={e.status} code={e.statusCode} />
                  </Td>
                  <Td className="text-right tabular-nums">{formatMs(e.latencyMs)}</Td>
                  <Td className="text-right tabular-nums">
                    {formatTokens(e.inputTokens + e.outputTokens)}
                  </Td>
                  <Td className="text-right tabular-nums">{formatUsd(e.costMicroUsd)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {cursor ? (
        <div className="mt-4 text-center">
          <Button onClick={() => void loadMore()} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}

      {selected ? <LogDetail log={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function LogDetail({ log, onClose }: { log: RequestLog; onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['Request ID', log.requestId],
    ['Principal', log.principalId],
    ['Workspace', log.workspaceId],
    ['Route', log.route],
    ['Provider / model', `${log.provider} · ${log.model}`],
    ['Status', `${log.statusCode} (${log.status})`],
    ['Streamed', String(log.streamed)],
    ['Input tokens', String(log.inputTokens)],
    ['Output tokens', String(log.outputTokens)],
    ['Cost', formatUsd(log.costMicroUsd)],
    ['Latency', formatMs(log.latencyMs)],
    ['Time', formatTime(log.createdAt)],
  ];
  return (
    <div className="fixed inset-y-0 right-0 z-20 w-full max-w-md overflow-y-auto border-l border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Request detail</h2>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <dl className="space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-neutral-400">{k}</dt>
            <dd className="break-all text-right font-mono text-xs">{v}</dd>
          </div>
        ))}
      </dl>
      {log.attributes ? (
        <div className="mt-4">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
            Attributes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(log.attributes).map(([k, v]) => (
              <Badge key={k}>
                {k}: {String(v)}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
