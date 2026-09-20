'use client';

import { useState } from 'react';
import { useAdmin } from '../lib/admin-context';
import { useAdminQuery } from '../lib/hooks';
import type { CollectionEntity, CollectionKind } from '../lib/types';
import {
  Button,
  Cell,
  CodeBlock,
  EmptyState,
  ErrorNote,
  Field,
  GridRow,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
} from './ui';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const COLS = 'minmax(0,1fr) 140px minmax(0,1.4fr) 120px';

/** Generic create/list/edit/delete panel for the workspace-scoped config collections,
 *  which all share the { workspaceId, name, config } shape. */
export function CollectionPage({
  kind,
  title,
  subtitle,
  placeholder,
}: {
  kind: CollectionKind;
  title: string;
  subtitle: string;
  placeholder: string;
}) {
  const { api } = useAdmin();
  const items = useAdminQuery((a) => a.collection(kind), [kind]);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [ws, setWs] = useState('');
  const [name, setName] = useState('');
  const [config, setConfig] = useState(placeholder);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const list = items.data?.entities ?? [];

  const reset = (): void => {
    setEditing(null);
    setName('');
    setConfig(placeholder);
  };

  async function save(): Promise<void> {
    if (!api || !name.trim()) return;
    setError(undefined);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config || '{}') as Record<string, unknown>;
    } catch {
      setError('Config must be valid JSON.');
      return;
    }
    try {
      if (editing)
        await api.updateCollectionItem(kind, editing, { name: name.trim(), config: parsed });
      else {
        if (!ws) return;
        await api.createCollectionItem(kind, ws, name.trim(), parsed);
      }
      reset();
      items.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }

  async function remove(id: string): Promise<void> {
    const name = list.find((e) => e.id === id)?.name ?? id;
    if (!api || !window.confirm(`Delete ${title.toLowerCase()} "${name}"?`)) return;
    try {
      await api.deleteCollectionItem(kind, id);
      if (editing === id) reset();
      items.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }

  function startEdit(e: CollectionEntity): void {
    setEditing(e.id);
    setName(e.name);
    setConfig(JSON.stringify(e.config, null, 2));
  }

  const wsName = (id: string): string =>
    workspaces.data?.workspaces.find((w) => w.id === id)?.name ?? id;

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel className="overflow-hidden">
          <PanelHeader title={title} meta={`${list.length}`} />
          {items.loading ? (
            <Spinner />
          ) : items.error ? (
            <div className="p-3">
              <ErrorNote error={items.error} onRetry={items.refetch} />
            </div>
          ) : list.length === 0 ? (
            <EmptyState message="None configured." />
          ) : (
            <div className="overflow-x-auto">
              <div style={{ minWidth: '600px' }}>
                <GridRow cols={COLS} header>
                  <Cell>Name</Cell>
                  <Cell>Workspace</Cell>
                  <Cell>Config</Cell>
                  <Cell align="right">Actions</Cell>
                </GridRow>
                {list.map((e) => (
                  <GridRow key={e.id} cols={COLS} selected={editing === e.id}>
                    <Cell mono tone="ink">
                      {e.name}
                    </Cell>
                    <Cell tone="secondary">{wsName(e.workspaceId)}</Cell>
                    <Cell mono tone="secondary">
                      {JSON.stringify(e.config)}
                    </Cell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" onClick={() => startEdit(e)}>
                        Edit
                      </Button>
                      <Button variant="ghost" onClick={() => void remove(e.id)}>
                        Delete
                      </Button>
                    </div>
                  </GridRow>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title={editing ? 'Edit item' : 'Create item'} />
          <div className="flex flex-col gap-3 p-3.5">
            {!editing ? (
              <Field label="Workspace">
                {workspaces.loading ? (
                  <Spinner />
                ) : workspaces.error ? (
                  <div className="p-3">
                    <ErrorNote error={workspaces.error} onRetry={workspaces.refetch} />
                  </div>
                ) : (
                  <Select value={ws} onChange={(e) => setWs(e.target.value)} className="w-full">
                    <option value="">workspace…</option>
                    {workspaces.data?.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />
            </Field>
            <Field label="Config (JSON)">
              <textarea
                className="min-h-[160px] w-full rounded-control border border-line-control bg-[#FDFCF9] px-2.5 py-2 font-mono text-[11px] leading-[1.55] text-ink shadow-field outline-none"
                value={config}
                onChange={(e) => setConfig(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => void save()}
                disabled={!name.trim() || (!editing && !ws)}
              >
                {editing ? 'Save changes' : 'Create'}
              </Button>
              {editing ? (
                <Button variant="ghost" onClick={reset}>
                  Cancel
                </Button>
              ) : null}
            </div>
            <CodeBlock className="text-[10px]">
              {`Config is applied verbatim; secret-resolving fields must be ARNs, never values.`}
            </CodeBlock>
          </div>
        </Panel>
      </div>
    </div>
  );
}
