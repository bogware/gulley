'use client';

import { useState } from 'react';
import { Badge, Button, Card, ErrorNote, PageHeader } from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function AuditPage() {
  const { api } = useAdmin();
  const [result, setResult] = useState<{ verified: boolean; count: number } | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function verify(): Promise<void> {
    if (!api) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.verifyAudit());
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Audit"
        subtitle="Verify the tamper-evident, hash-chained audit log end to end."
      />
      {error ? <ErrorNote error={error} /> : null}
      <Card className="max-w-lg space-y-3 p-4">
        <Button variant="primary" onClick={() => void verify()} disabled={busy}>
          {busy ? 'Verifying…' : 'Verify chain'}
        </Button>
        {result ? (
          <div className="flex items-center gap-2">
            <Badge tone={result.verified ? 'green' : 'red'}>
              {result.verified ? 'verified' : 'BROKEN'}
            </Badge>
            <span className="text-sm text-neutral-500">{result.count} rows checked</span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
