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
    <div className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center gap-4 px-6">
      <div>
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Gulley</div>
        <h1 className="mt-3 text-[19px] font-semibold tracking-[-0.015em] text-ink">
          Sign in to the console
        </h1>
        <p className="mt-1 text-[11.5px] text-secondary">
          Open the cross-vendor LLM-gateway control plane.
        </p>
      </div>

      {oidc?.enabled ? (
        <Card className="p-3.5">
          <Button
            variant="primary"
            className="w-full justify-center"
            onClick={() => {
              window.location.href = `${controlApiUrl()}/auth/login`;
            }}
          >
            Sign in with SSO
          </Button>
          <p className="mt-2 text-center text-[10.5px] text-micro">OpenID Connect single sign-on</p>
        </Card>
      ) : null}

      <Card className="space-y-3 p-3.5">
        <div className="text-[12px] font-medium text-ink">
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
        <p className="text-[10.5px] text-micro">Dev / break-glass: a bootstrap or session token.</p>
      </Card>
    </div>
  );
}
