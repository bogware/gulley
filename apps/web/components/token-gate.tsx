'use client';

import { useState } from 'react';
import { useAdmin } from '../lib/admin-context';
import { controlApiUrl, GulleyAdminApi } from '../lib/api';
import { Button, Card, ErrorNote, Input } from './ui';

export function TokenGate() {
  const { setToken } = useAdmin();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function connect(): Promise<void> {
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    setError(undefined);
    try {
      // Any authorized read verifies the token before we persist it.
      await new GulleyAdminApi(controlApiUrl(), t).orgs();
      setToken(t);
    } catch (e) {
      setError(`Could not connect: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center gap-4 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connect to Gulley</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Paste an admin session token to open the console.
        </p>
      </div>
      <Card className="space-y-3 p-4">
        <Input
          type="password"
          placeholder="Bearer token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void connect();
          }}
        />
        {error ? <ErrorNote error={error} /> : null}
        <Button variant="primary" onClick={() => void connect()} disabled={busy || !value.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        <p className="text-xs text-neutral-400">
          Dev: use a bootstrap admin token. In production this is minted by OIDC login (M11).
        </p>
      </Card>
    </div>
  );
}
