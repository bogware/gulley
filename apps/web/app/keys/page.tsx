'use client';

import { useState } from 'react';
import {
  Button,
  Cell,
  CopyButton,
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
import type { VirtualKeyView } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const COLS = 'minmax(0,1fr) 130px 90px 150px';

export default function KeysPage() {
  const { api } = useAdmin();
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [ws, setWs] = useState('');
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<{ id: string; token: string; keyPrefix: string } | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const keys = useAdminQuery((a) => (ws ? a.listKeys(ws) : Promise.resolve({ keys: [] })), [ws]);

  async function mint(): Promise<void> {
    if (!api || !ws || !name.trim()) return;
    setError(undefined);
    try {
      const r = await api.createKey(ws, name.trim());
      setMinted(r);
      setName('');
      keys.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }
  async function disable(id: string): Promise<void> {
    if (!api || !window.confirm('Disable this key? Requests using it fail immediately.')) return;
    try {
      await api.disableKey(id);
      keys.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }
  async function rotate(id: string): Promise<void> {
    if (
      !api ||
      !window.confirm(
        'Rotate this key? The current token stops working; the new one is shown once.',
      )
    )
      return;
    try {
      setMinted(await api.rotateKey(id));
      keys.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }

  const list = keys.data?.keys ?? [];

  return (
    <div>
      <PageHeader
        title="Virtual keys"
        subtitle="Mint, list, disable, and rotate workspace-scoped keys. A token is shown once, never again."
      />
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Keys"
            meta={ws ? `${list.length}` : 'select a workspace'}
            right={
              <Select value={ws} onChange={(e) => setWs(e.target.value)}>
                <option value="">workspace…</option>
                {workspaces.data?.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            }
          />
          {!ws ? (
            <EmptyState message="Select a workspace to list its keys." />
          ) : keys.loading ? (
            <Spinner />
          ) : keys.error ? (
            <div className="p-3">
              <ErrorNote error={keys.error} onRetry={keys.refetch} />
            </div>
          ) : list.length === 0 ? (
            <EmptyState message="No keys in this workspace yet." />
          ) : (
            <div className="overflow-x-auto">
              <div style={{ minWidth: '500px' }}>
                <GridRow cols={COLS} header>
                  <Cell>Name</Cell>
                  <Cell>Prefix</Cell>
                  <Cell>State</Cell>
                  <Cell align="right">Actions</Cell>
                </GridRow>
                {list.map((k: VirtualKeyView) => (
                  <GridRow key={k.id} cols={COLS}>
                    <Cell tone="ink">{k.displayName}</Cell>
                    <Cell mono tone="secondary">
                      {k.keyPrefix}
                    </Cell>
                    <Cell>
                      <StatusChip tone={k.disabled ? 'red' : 'green'}>
                        {k.disabled ? 'disabled' : 'active'}
                      </StatusChip>
                    </Cell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" onClick={() => void rotate(k.id)}>
                        Rotate
                      </Button>
                      {!k.disabled ? (
                        <Button variant="ghost" onClick={() => void disable(k.id)}>
                          Disable
                        </Button>
                      ) : null}
                    </div>
                  </GridRow>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Mint a key" />
          <div className="flex flex-col gap-3 p-3.5">
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
            <Field label="Key name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="claude-code · platform-eng"
              />
            </Field>
            <Button variant="primary" onClick={() => void mint()} disabled={!ws || !name.trim()}>
              Mint key
            </Button>

            {minted ? (
              <div className="rounded-control border border-warn-border bg-warn-bg p-2.5">
                <div className="text-[10.5px] font-medium text-warn-text">
                  Copy this token now — it is never shown again.
                </div>
                <code className="mt-1.5 block break-all font-mono text-[10.5px] text-ink">
                  {minted.token}
                </code>
                <div className="mt-2 flex items-center gap-2">
                  <CopyButton text={minted.token} />
                  <StatusChip>prefix {minted.keyPrefix}</StatusChip>
                </div>
              </div>
            ) : (
              <InlineResult tone="info">
                Point Claude Code / Codex at the gateway with this key.
              </InlineResult>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
