'use client';

import { useState } from 'react';
import {
  Button,
  Cell,
  EmptyState,
  ErrorNote,
  Field,
  GridRow,
  InlineResult,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  StatusChip,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';
import {
  COMMON_CLIENT_PATHS,
  configFromForm,
  EMPTY_ROUTE_GROUP_FORM,
  formFromEntity,
  groupOptionsLabel,
  isLegacyRouteConfig,
  ROUTE_GROUP_MODES,
  ROUTE_GROUP_SELECTS,
  type RouteGroupForm,
} from '../../lib/route-edit';
import type { CollectionEntity } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const COLS = 'minmax(0,1fr) minmax(0,1.1fr) 100px minmax(0,1.2fr) minmax(0,1.4fr) 110px';
const PATH_LIST_ID = 'route-group-client-paths';
// Same look as the Input primitive, for the one multi-line field.
const TEXTAREA =
  'w-full rounded-control border border-line-control bg-[#FDFCF9] px-2.5 py-[5px] font-mono text-[11.5px] text-ink shadow-field outline-none placeholder:text-secondary/70';

export default function RoutesPage() {
  const { api } = useAdmin();
  const routes = useAdminQuery((a) => a.collection('routes'), []);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [ws, setWs] = useState('');
  const [editing, setEditing] = useState<CollectionEntity | null>(null);
  const [form, setForm] = useState<RouteGroupForm>(EMPTY_ROUTE_GROUP_FORM);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const list = routes.data?.entities ?? [];
  const legacyCount = list.filter((e) => isLegacyRouteConfig(e.config)).length;
  const legacyEditing = editing ? isLegacyRouteConfig(editing.config) : false;
  const wsName = (id: string): string =>
    workspaces.data?.workspaces.find((w) => w.id === id)?.name ?? id;
  const set = <K extends keyof RouteGroupForm>(k: K, v: RouteGroupForm[K]): void =>
    setForm((f) => ({ ...f, [k]: v }));

  function reset(): void {
    setEditing(null);
    setForm(EMPTY_ROUTE_GROUP_FORM);
    setError(undefined);
  }
  function edit(e: CollectionEntity): void {
    setEditing(e);
    setForm(formFromEntity(e.name, e.config));
    setError(undefined);
  }

  // Create/update go through the audited console write path; in DB-config mode that is
  // one config commit the gateways reconcile from live. The control API validates the
  // route-group schema and names the failing field on a 400.
  async function save(): Promise<void> {
    if (!api || busy) return;
    const name = form.name.trim();
    if (!name) return setError('Name is required.');
    if (!editing && !ws) return setError('Select a workspace.');
    const built = configFromForm(form);
    if (!built.ok) return setError(built.error);
    setBusy(true);
    setError(undefined);
    try {
      if (editing) {
        await api.updateCollectionItem('routes', editing.id, { name, config: built.config });
      } else {
        await api.createCollectionItem('routes', ws, name, built.config);
      }
      reset();
      routes.refetch();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: CollectionEntity): Promise<void> {
    if (
      !api ||
      !window.confirm(
        `Delete route group "${e.name}"? Its client path falls back to the single-target provider routes (or an env ROUTE_GROUPS group).`,
      )
    )
      return;
    try {
      await api.deleteCollectionItem('routes', e.id);
      if (editing?.id === e.id) reset();
      routes.refetch();
    } catch (err) {
      setError(msg(err));
    }
  }

  return (
    <div>
      <PageHeader
        title="Route groups"
        subtitle="Combine configured providers into one fallback or load-balanced route per client path. Gateways in DB-config mode apply these live; a group here shadows an env ROUTE_GROUPS entry on the same path."
      />
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Route groups"
            meta={`${list.length}${legacyCount ? ` · ${legacyCount} legacy` : ''}`}
          />
          {routes.loading ? (
            <Spinner />
          ) : routes.error ? (
            <div className="p-3">
              <ErrorNote error={routes.error} onRetry={routes.refetch} />
            </div>
          ) : list.length === 0 ? (
            <EmptyState message="No route groups yet. Each provider serves its paths single-target until a group combines two or more." />
          ) : (
            <div className="overflow-x-auto">
              <div style={{ minWidth: '900px' }}>
                <GridRow cols={COLS} header>
                  <Cell>Name</Cell>
                  <Cell>Client path</Cell>
                  <Cell>Mode</Cell>
                  <Cell>Providers</Cell>
                  <Cell>Options</Cell>
                  <Cell align="right">Actions</Cell>
                </GridRow>
                {list.map((e) => {
                  const legacy = isLegacyRouteConfig(e.config);
                  const providers = Array.isArray(e.config['providers'])
                    ? (e.config['providers'] as unknown[]).join(' → ')
                    : '';
                  return (
                    <GridRow key={e.id} cols={COLS} selected={editing?.id === e.id}>
                      <div className="min-w-0">
                        <div className="truncate text-ink">{e.name}</div>
                        <div className="truncate font-mono text-[9.5px] text-secondary">
                          {wsName(e.workspaceId)}
                        </div>
                      </div>
                      {legacy ? (
                        <div className="col-span-4 flex min-w-0 items-center gap-2">
                          <StatusChip tone="amber">legacy</StatusChip>
                          <span className="truncate text-[11px] text-secondary">
                            ignored by the gateway — Convert, fill in a client path and two or more
                            providers, then save
                          </span>
                        </div>
                      ) : (
                        <>
                          <Cell mono tone="ink">
                            {String(e.config['clientPath'])}
                          </Cell>
                          <Cell>
                            <StatusChip
                              tone={e.config['mode'] === 'loadbalance' ? 'blue' : 'neutral'}
                            >
                              {String(e.config['mode'])}
                            </StatusChip>
                          </Cell>
                          <Cell mono tone="secondary">
                            {providers}
                          </Cell>
                          <Cell tone="secondary">{groupOptionsLabel(e.config)}</Cell>
                        </>
                      )}
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" onClick={() => edit(e)}>
                          {legacy ? 'Convert' : 'Edit'}
                        </Button>
                        <Button variant="ghost" onClick={() => void remove(e)}>
                          Delete
                        </Button>
                      </div>
                    </GridRow>
                  );
                })}
              </div>
            </div>
          )}
          <p className="px-3.5 pb-3 pt-2 text-[10px] text-micro">
            Fallback tries providers in order (pre-first-byte only); load-balance picks by
            least-load, cheapest or fastest with optional weights. A group whose providers resolve
            to fewer than two configured targets is skipped at reconcile; the last group for a
            client path wins.
          </p>
        </Panel>

        <Panel>
          <PanelHeader
            title={
              editing
                ? `${legacyEditing ? 'Convert' : 'Edit'} ${editing.name}`
                : 'Create a route group'
            }
            right={
              editing ? (
                <Button variant="ghost" onClick={reset}>
                  Cancel
                </Button>
              ) : undefined
            }
          />
          <div className="flex flex-col gap-3 p-3.5">
            {legacyEditing ? (
              <InlineResult tone="info">
                Old console shape — ignored by the gateway. Saving replaces it with a route group.
              </InlineResult>
            ) : null}
            {editing ? (
              <Field label="Workspace">
                <Input value={wsName(editing.workspaceId)} readOnly />
              </Field>
            ) : (
              <Field label="Workspace">
                <Select value={ws} onChange={(e) => setWs(e.target.value)} className="w-full">
                  <option value="">workspace…</option>
                  {workspaces.data?.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="messages-ha"
              />
            </Field>
            <Field label="Client path (or suffix)">
              <Input
                list={PATH_LIST_ID}
                value={form.clientPath}
                onChange={(e) => set('clientPath', e.target.value)}
                placeholder="/v1/messages"
              />
              <datalist id={PATH_LIST_ID}>
                {COMMON_CLIENT_PATHS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </Field>
            <Field label="Mode">
              <Select
                value={form.mode}
                onChange={(e) => set('mode', e.target.value as RouteGroupForm['mode'])}
                className="w-full"
              >
                {ROUTE_GROUP_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Providers (comma-separated, two or more, in preference order)">
              <Input
                value={form.providers}
                onChange={(e) => set('providers', e.target.value)}
                placeholder="anthropic, bedrock"
              />
            </Field>
            <Field label="Select (loadbalance; blank = least-load)">
              <Select
                value={form.select}
                onChange={(e) => set('select', e.target.value as RouteGroupForm['select'])}
                className="w-full"
              >
                <option value="">default</option>
                {ROUTE_GROUP_SELECTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Weights (loadbalance; JSON, blank = 1 each)">
              <Input
                value={form.weights}
                onChange={(e) => set('weights', e.target.value)}
                placeholder='{"anthropic": 3, "bedrock": 1}'
              />
            </Field>
            <Field label="Failover status codes (fallback; comma-separated, blank = default set)">
              <Input
                value={form.onStatusCodes}
                onChange={(e) => set('onStatusCodes', e.target.value)}
                placeholder="429, 503"
              />
            </Field>
            <Field label="Hedge delay ms (blank = global HEDGE_DELAY_MS)">
              <Input
                type="number"
                min={0}
                step={1}
                value={form.hedgeDelayMs}
                onChange={(e) => set('hedgeDelayMs', e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Model map (JSON: provider → client model → upstream model)">
              <textarea
                className={TEXTAREA}
                rows={4}
                value={form.modelMap}
                onChange={(e) => set('modelMap', e.target.value)}
                placeholder='{"bedrock": {"claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6-v1:0"}}'
              />
            </Field>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={busy || !form.name.trim() || (!editing && !ws)}
            >
              {busy
                ? 'Saving…'
                : editing
                  ? legacyEditing
                    ? 'Convert to route group'
                    : 'Save changes'
                  : 'Create route group'}
            </Button>
            <p className="text-[10px] text-micro">
              Saved through the audited console write path; in DB-config mode gateways reconcile the
              new version live. The control API validates the schema and names the failing field.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
