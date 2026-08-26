'use client';

import { useState } from 'react';
import { useAdmin } from '../lib/admin-context';
import { useAdminQuery } from '../lib/hooks';
import type { CollectionKind } from '../lib/types';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from './ui';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Generic create/list panel for the workspace-scoped config collections, which
 *  all share the { workspaceId, name, config } shape. */
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
  const [error, setError] = useState<string | undefined>(undefined);

  async function add(): Promise<void> {
    if (!api || !ws || !name.trim()) return;
    setError(undefined);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config || '{}') as Record<string, unknown>;
    } catch {
      setError('Config must be valid JSON.');
      return;
    }
    try {
      await api.createCollectionItem(kind, ws, name.trim(), parsed);
      setName('');
      items.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }

  const list = items.data?.entities ?? [];

  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      {error ? <ErrorNote error={error} /> : null}

      <Card className="mb-6 p-4">
        <div className="mb-3 font-medium">Create</div>
        <div className="flex flex-wrap items-start gap-2">
          {workspaces.loading ? (
            <Spinner />
          ) : (
            <Select value={ws} onChange={(e) => setWs(e.target.value)}>
              <option value="">workspace…</option>
              {workspaces.data?.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <Input
            className="w-48"
            placeholder="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="min-h-[80px] w-96 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 font-mono text-xs text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            spellCheck={false}
          />
          <Button variant="primary" onClick={() => void add()} disabled={!ws || !name.trim()}>
            Create
          </Button>
        </div>
      </Card>

      <Card>
        {items.loading ? (
          <Spinner />
        ) : list.length === 0 ? (
          <EmptyState message="None configured." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Workspace</Th>
                <Th>Config</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <Td>{e.name}</Td>
                  <Td className="font-mono text-xs text-neutral-400">{e.workspaceId}</Td>
                  <Td className="font-mono text-xs text-neutral-500">{JSON.stringify(e.config)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
