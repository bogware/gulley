'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, ErrorNote, InlineResult, Input, Spinner } from '../../../components/ui';
import { useAdmin } from '../../../lib/admin-context';
import { ApiError } from '../../../lib/api';
import type { DeviceCodePreview } from '../../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Canonical `XXXX-XXXX` for display; the broker normalizes too, this is cosmetic. */
function normalize(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : input.toUpperCase();
}

/**
 * The device-flow consent page (RFC 8628 verification URI) in the console. A coding
 * agent shows the developer a code + this URL (`?user_code=` pre-fills it); the
 * signed-in developer confirms which client / workspace is asking, then approves or
 * denies. The AppShell's session gate wraps this page, so consent always carries an
 * authenticated admin identity — the broker binds the grant to it, never to anything
 * the agent sent.
 */
export default function DeviceConsentPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <DeviceConsent />
    </Suspense>
  );
}

function DeviceConsent() {
  const { api } = useAdmin();
  const params = useSearchParams();
  const [code, setCode] = useState(params.get('user_code') ?? '');
  const [preview, setPreview] = useState<DeviceCodePreview | null>(null);
  const [lookupError, setLookupError] = useState<string | undefined>(undefined);
  const [decision, setDecision] = useState<'approved' | 'denied' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const compact = code.replace(/[^A-Za-z0-9]/g, '');

  useEffect(() => {
    if (compact.length !== 8) {
      setPreview(null);
      setLookupError(undefined);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .deviceCodePreview(code)
        .then((p) => {
          if (!cancelled) {
            setPreview(p);
            setLookupError(undefined);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setPreview(null);
            const status = e instanceof ApiError ? e.status : /→ (4\d\d)/.exec(msg(e))?.[1];
            const code = Number(status);
            setLookupError(
              code === 401 || code === 403
                ? 'Your session has expired — sign in again to approve this device.'
                : code === 400 || code === 404 || code === 410
                  ? 'Unknown, expired, or already-used code.'
                  : `Could not look up the code: ${msg(e)}`,
            );
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, code, compact.length]);

  async function decide(kind: 'approved' | 'denied'): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'approved') await api.approveDeviceCode(code);
      else await api.denyDeviceCode(code);
      setDecision(kind);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <div>
        <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">Approve a device</h1>
        <p className="mt-1 text-[11.5px] text-secondary">
          A coding agent (Claude Code, Codex, …) is asking for access to the LLM gateway on your
          behalf. Confirm the code it showed you.
        </p>
      </div>

      {decision ? (
        <Card className="space-y-3 p-3.5">
          <InlineResult tone={decision === 'approved' ? 'ok' : 'info'}>
            {decision === 'approved'
              ? 'Approved — you can close this page and return to the agent.'
              : 'Denied — the agent will report that access was refused.'}
          </InlineResult>
          <Button
            variant="ghost"
            onClick={() => {
              setDecision(undefined);
              setCode('');
              setPreview(null);
            }}
          >
            Approve another
          </Button>
        </Card>
      ) : (
        <Card className="space-y-3 p-3.5">
          <label className="block text-[11px] text-secondary" htmlFor="user-code">
            Code
          </label>
          <Input
            id="user-code"
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            maxLength={9}
            className="text-[18px] font-semibold uppercase tracking-[0.12em]"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onBlur={() => setCode((c) => (c ? normalize(c) : c))}
          />
          {preview ? (
            <div
              className="rounded-md bg-canvas p-3 text-[11.5px] leading-[1.6] text-body"
              data-testid="device-preview"
            >
              <span className="font-semibold text-ink">
                {preview.clientName} ({preview.clientId})
              </span>{' '}
              wants access to workspace{' '}
              <span className="font-mono text-ink">
                {preview.workspaceName ?? preview.workspaceId}
              </span>
              {preview.orgName ? ` in ${preview.orgName}` : ''}. The grant is bound to YOUR identity
              and its tokens can be revoked from Identity → OAuth broker. Expires{' '}
              {new Date(preview.expiresAt).toLocaleTimeString()}.
            </div>
          ) : null}
          {lookupError ? <ErrorNote error={lookupError} /> : null}
          {error ? <ErrorNote error={error} /> : null}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1 justify-center"
              disabled={busy || !preview}
              onClick={() => void decide('denied')}
            >
              Deny
            </Button>
            <Button
              variant="primary"
              className="flex-1 justify-center"
              disabled={busy || !preview}
              onClick={() => void decide('approved')}
            >
              {busy ? 'Working…' : 'Approve'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
