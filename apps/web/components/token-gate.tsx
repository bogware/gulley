'use client';

import { useEffect, useState } from 'react';
import { useAdmin } from '../lib/admin-context';
import { controlApiUrl, GulleyAdminApi } from '../lib/api';
import { Button, Card, ErrorNote, Input } from './ui';

export function TokenGate() {
  const { setToken, refreshAuth } = useAdmin();
  const [oidc, setOidc] = useState<{ enabled: boolean } | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    new GulleyAdminApi(controlApiUrl())
      .authConfig()
      .then((c) => setOidc(c))
      .catch(() => setOidc({ enabled: false }));
  }, []);

  async function connect(): Promise<void> {
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    setError(undefined);
    try {
      await new GulleyAdminApi(controlApiUrl(), t).me();
      setToken(t);
      refreshAuth();
    } catch (e) {
      setError(`Could not connect: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center gap-4 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to Gulley</h1>
        <p className="mt-1 text-sm text-neutral-500">Open the control-plane console.</p>
      </div>

      {oidc?.enabled ? (
        <Card className="p-4">
          <Button
            variant="primary"
            className="w-full justify-center"
            onClick={() => {
              window.location.href = `${controlApiUrl()}/auth/login`;
            }}
          >
            Sign in with SSO
          </Button>
          <p className="mt-2 text-center text-xs text-neutral-400">OpenID Connect single sign-on</p>
        </Card>
      ) : null}

      <Card className="space-y-3 p-4">
        <div className="text-sm font-medium">
          {oidc?.enabled ? 'Or use an admin token' : 'Admin token'}
        </div>
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
        <Button variant="secondary" onClick={() => void connect()} disabled={busy || !value.trim()}>
          {busy ? 'Connecting…' : 'Connect with token'}
        </Button>
        <p className="text-xs text-neutral-400">Dev / break-glass: a bootstrap or session token.</p>
      </Card>
    </div>
  );
}
