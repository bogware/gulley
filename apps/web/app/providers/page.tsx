'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  Dot,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  MicroLabel,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  StatusChip,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { formatNum, formatUsd } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type { Provider } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const KINDS = ['anthropic', 'openai', 'bedrock', 'azure', 'custom'];

export default function ProvidersPage() {
  const { api } = useAdmin();
  const providers = useAdminQuery((a) => a.providers(), []);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const usage = useAdminQuery((a) => {
    const to = new Date();
    const from = new Date(to.getTime() - 86_400_000);
    return a.usage({
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: 'hour',
      groupBy: 'provider',
    });
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const list = providers.data?.providers ?? [];
  const selected = list.find((p) => p.id === selectedId) ?? list[0] ?? null;
  const wsName = (id: string): string =>
    workspaces.data?.workspaces.find((w) => w.id === id)?.name ?? id;

  const perProvider = useMemo(() => {
    const m = new Map<string, { requests: number; cost: number; series: number[] }>();
    const times = [...new Set((usage.data?.buckets ?? []).map((b) => b.bucketStart))].sort();
    const idx = new Map(times.map((t, i) => [t, i]));
    for (const b of usage.data?.buckets ?? []) {
      const key = b.group ?? 'unknown';
      const e = m.get(key) ?? { requests: 0, cost: 0, series: new Array(times.length).fill(0) };
      e.requests += b.requests;
      e.cost += b.costMicroUsd;
      e.series[idx.get(b.bucketStart) ?? 0] += b.costMicroUsd;
      m.set(key, e);
    }
    return m;
  }, [usage.data]);

  return (
    <div>
      <PageHeaderStrip
        count={list.length}
        onAdd={() => {
          setAdding((a) => !a);
          setSelectedId(null);
        }}
      />
      {error ? <ErrorNote error={error} /> : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* master list */}
        <div className="w-full shrink-0 lg:w-[340px]">
          <Panel className="overflow-hidden">
            {providers.loading ? (
              <Spinner />
            ) : providers.error ? (
              <div className="p-3">
                <ErrorNote error={providers.error} onRetry={providers.refetch} />
              </div>
            ) : list.length === 0 ? (
              <EmptyState message="No providers configured." />
            ) : (
              <div className="flex flex-col">
                {list.map((p) => {
                  const u = perProvider.get(p.kind);
                  const active = selected?.id === p.id && !adding;
                  return (
                    <button
                      key={p.id}
                      onClick={() => {
                        setSelectedId(p.id);
                        setAdding(false);
                      }}
                      className={`flex flex-col gap-1 border-b border-line-soft px-3 py-2.5 text-left transition-colors last:border-0 ${
                        active ? 'bg-accent-tint shadow-selrow' : 'hover:bg-[#F3F0E8]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12.5px] font-medium text-ink">{p.kind}</span>
                        <StatusChip tone={p.enabled ? 'green' : 'neutral'}>
                          {p.enabled ? 'healthy' : 'disabled'}
                        </StatusChip>
                      </div>
                      <div className="truncate font-mono text-[10px] text-secondary">
                        {p.baseUrl ?? 'default endpoint'}
                      </div>
                      {u ? (
                        <div className="font-mono text-[10px] text-micro">
                          {formatNum(u.requests)} req · {formatUsd(u.cost)} · 24h
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        {/* detail inspector */}
        <div className="min-w-0 flex-1">
          {adding ? (
            <AddProvider
              workspaces={workspaces.data?.workspaces ?? []}
              onCancel={() => setAdding(false)}
              onDone={() => {
                setAdding(false);
                providers.refetch();
              }}
              onError={setError}
            />
          ) : selected ? (
            <Inspector
              key={selected.id}
              provider={selected}
              workspaceName={wsName(selected.workspaceId)}
              usage={perProvider.get(selected.kind)}
              onError={setError}
            />
          ) : (
            <Panel>
              <EmptyState message="Select a provider to inspect it." />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function PageHeaderStrip({ count, onAdd }: { count: number; onAdd: () => void }) {
  return (
    <div className="-mx-5 -mt-4 mb-4 flex items-center justify-between gap-3 border-b border-line bg-header px-5 py-3.5">
      <div className="flex items-baseline gap-2">
        <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">Providers</h1>
        <span className="font-mono text-[11px] text-secondary">{count}</span>
      </div>
      <Button variant="primary" onClick={onAdd}>
        + Add provider
      </Button>
    </div>
  );
}

function Inspector({
  provider: p,
  workspaceName,
  usage,
  onError,
}: {
  provider: Provider;
  workspaceName: string;
  usage?: { requests: number; cost: number; series: number[] };
  onError: (e: string) => void;
}) {
  const { api } = useAdmin();
  const [arn, setArn] = useState('');
  const [ver, setVer] = useState('');
  const [saved, setSaved] = useState(false);
  const maxSpark = Math.max(1, ...(usage?.series ?? [1]));

  async function saveCredential(): Promise<void> {
    if (!api || !arn.trim() || !ver.trim()) return;
    try {
      await api.setCredential(p.id, arn.trim(), ver.trim());
      setSaved(true);
      setArn('');
      setVer('');
    } catch (e) {
      onError(msg(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="flex items-center gap-2">
              <Dot tone={p.enabled ? 'green' : 'amber'} halo={!p.enabled} />
              <span className="text-[14px] font-medium text-ink">{p.kind}</span>
              <StatusChip tone={p.enabled ? 'green' : 'neutral'}>
                {p.enabled ? 'healthy' : 'disabled'}
              </StatusChip>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-secondary">
              {p.id} · workspace {workspaceName}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(0,1fr)_240px]">
          {/* connection */}
          <div>
            <MicroLabel className="mb-2">Connection</MicroLabel>
            <KV label="Kind" value={p.kind} />
            <KV label="Base URL" value={p.baseUrl ?? 'default (vendor endpoint)'} mono />
            <KV label="Workspace" value={workspaceName} />
            <KV label="Enabled" value={p.enabled ? 'yes' : 'no'} />
            <p className="mt-2 text-[10px] text-micro">
              Provider connection fields are managed through GitOps config apply; this view is
              read-only.
            </p>
          </div>

          {/* last 24h */}
          <div>
            <MicroLabel className="mb-2">Last 24h</MicroLabel>
            <div className="rounded-control border border-line-soft bg-inset p-2.5">
              <div className="flex h-[36px] items-end gap-px">
                {(usage?.series ?? [0]).map((v, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-[1px] bg-accent-soft"
                    style={{ height: `${Math.max(4, (v / maxSpark) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-secondary">
                <span>{formatNum(usage?.requests ?? 0)} req</span>
                <span>{formatUsd(usage?.cost ?? 0)}</span>
              </div>
            </div>
          </div>
        </div>
      </Panel>

      {/* credential */}
      <Panel>
        <PanelHeader title="Credential" meta="secret-ref only · never stored in Gulley" />
        <div className="flex flex-col gap-2 p-4">
          <div className="flex flex-col gap-2 md:flex-row">
            <Input
              className="flex-1"
              placeholder="secret ARN (arn:aws:secretsmanager:…)"
              value={arn}
              onChange={(e) => {
                setArn(e.target.value);
                setSaved(false);
              }}
            />
            <Input
              className="md:w-48"
              placeholder="version id"
              value={ver}
              onChange={(e) => {
                setVer(e.target.value);
                setSaved(false);
              }}
            />
            <Button
              variant="primary"
              onClick={() => void saveCredential()}
              disabled={!arn.trim() || !ver.trim()}
            >
              Save credential
            </Button>
          </div>
          {saved ? (
            <div className="flex items-center gap-2 rounded-control border border-ok-border bg-ok-bg px-2.5 py-1.5 text-[11px] text-ok-text">
              <Dot tone="green" /> Credential reference updated — resolved from Secrets Manager at
              request time.
            </div>
          ) : (
            <p className="text-[10px] text-micro">
              Gulley stores only the ARN + version; the secret value is resolved at request time and
              never persisted.
            </p>
          )}
        </div>
      </Panel>

      {/* point a client here */}
      <Panel>
        <PanelHeader title="Point a client here" />
        <div className="p-4">
          <div className="overflow-x-auto rounded-control border border-line-soft border-dashed bg-inset px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] text-body">
            <div className="text-micro"># route this provider&apos;s traffic through Gulley</div>
            <div>export {p.kind.toUpperCase()}_BASE_URL=https://&lt;your-gulley-gateway&gt;</div>
            <div>export {p.kind.toUpperCase()}_API_KEY=&lt;a Gulley virtual key&gt;</div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function AddProvider({
  workspaces,
  onCancel,
  onDone,
  onError,
}: {
  workspaces: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const { api } = useAdmin();
  const [ws, setWs] = useState('');
  const [kind, setKind] = useState('anthropic');
  const [baseUrl, setBaseUrl] = useState('');

  async function add(): Promise<void> {
    if (!api || !ws) return;
    try {
      await api.createProvider(ws, kind, baseUrl || undefined);
      onDone();
    } catch (e) {
      onError(msg(e));
    }
  }

  return (
    <Panel>
      <PanelHeader title="Add a provider" />
      <div className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Workspace">
            <Select value={ws} onChange={(e) => setWs(e.target.value)} className="w-full">
              <option value="">workspace…</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-full">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Base URL (optional — internal upstream for air-gapped / custom)">
          <Input
            placeholder="https://models.internal/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void add()} disabled={!ws}>
            Create provider
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-soft py-1.5 last:border-0">
      <span className="text-[10.5px] text-micro">{label}</span>
      <span
        className={`text-right text-[11.5px] text-ink ${mono ? 'break-all font-mono text-[10.5px]' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}
