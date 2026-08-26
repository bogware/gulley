'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';
import type { VirtualKeyView } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function KeysPage() {
  const { api } = useAdmin();
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [ws, setWs] = useState('');
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<{ id: string; token: string; keyPrefix: string } | null>(
    null,
  );
  const [lookupId, setLookupId] = useState('');
  const [looked, setLooked] = useState<VirtualKeyView | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  async function mint(): Promise<void> {
    if (!api || !ws || !name.trim()) return;
    setError(undefined);
    try {
      const r = await api.createKey(ws, name.trim());
      setMinted(r);
      setName('');
    } catch (e) {
      setError(msg(e));
    }
  }
  async function lookup(): Promise<void> {
    if (!api || !lookupId.trim()) return;
    setError(undefined);
    try {
      const r = await api.key(lookupId.trim());
      setLooked(r.key);
    } catch (e) {
      setError(msg(e));
      setLooked(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Virtual keys"
        subtitle="Mint API keys scoped to a workspace. The token is shown once, never again."
      />
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 font-medium">Mint a key</div>
          <div className="flex flex-wrap gap-2">
            {workspaces.loading ? (
              <Spinner />
            ) : (
              <Select value={ws} onChange={(e) => setWs(e.target.value)}>
                <option value="">select workspace…</option>
                {workspaces.data?.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
            <Input placeholder="key name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button variant="primary" onClick={() => void mint()} disabled={!ws || !name.trim()}>
              Mint
            </Button>
          </div>

          {minted ? (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                Copy this token now — it is never shown again.
              </div>
              <code className="mt-2 block break-all font-mono text-xs">{minted.token}</code>
              <div className="mt-2 flex items-center gap-2">
                <Button onClick={() => void navigator.clipboard?.writeText(minted.token)}>
                  Copy
                </Button>
                <Badge>prefix {minted.keyPrefix}</Badge>
                <Badge>id {minted.id}</Badge>
              </div>
            </div>
          ) : null}
        </Card>

        <Card className="p-4">
          <div className="mb-3 font-medium">Look up a key</div>
          <div className="flex gap-2">
            <Input
              placeholder="key id"
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
            />
            <Button onClick={() => void lookup()} disabled={!lookupId.trim()}>
              Look up
            </Button>
          </div>
          {looked ? (
            <dl className="mt-4 space-y-2 text-sm">
              <Row k="Name" v={looked.displayName} />
              <Row k="Prefix" v={looked.keyPrefix} />
              <Row k="Workspace" v={looked.workspaceId} />
              <Row k="Disabled" v={String(looked.disabled)} />
            </dl>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-400">{k}</dt>
      <dd className="break-all text-right font-mono text-xs">{v}</dd>
    </div>
  );
}
