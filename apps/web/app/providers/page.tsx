'use client';

import { useState } from 'react';
import {
  Badge,
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
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const KINDS = ['anthropic', 'openai', 'bedrock', 'azure', 'custom'];

export default function ProvidersPage() {
  const { api } = useAdmin();
  const providers = useAdminQuery((a) => a.providers(), []);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [ws, setWs] = useState('');
  const [kind, setKind] = useState('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [credFor, setCredFor] = useState<string | null>(null);
  const [arn, setArn] = useState('');
  const [ver, setVer] = useState('');

  async function addProvider(): Promise<void> {
    if (!api || !ws) return;
    setError(undefined);
    try {
      await api.createProvider(ws, kind, baseUrl || undefined);
      setBaseUrl('');
      providers.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }
  async function saveCredential(): Promise<void> {
    if (!api || !credFor || !arn.trim() || !ver.trim()) return;
    setError(undefined);
    try {
      await api.setCredential(credFor, arn.trim(), ver.trim());
      setCredFor(null);
      setArn('');
      setVer('');
    } catch (e) {
      setError(msg(e));
    }
  }

  const list = providers.data?.providers ?? [];

  return (
    <div>
      <PageHeader
        title="Providers"
        subtitle="Upstream providers and their secret-ref credentials (ARNs only)."
      />
      {error ? <ErrorNote error={error} /> : null}

      <Card className="mb-6 p-4">
        <div className="mb-3 font-medium">Add a provider</div>
        <div className="flex flex-wrap gap-2">
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
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Input
            className="w-72"
            placeholder="base URL (optional)"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <Button variant="primary" onClick={() => void addProvider()} disabled={!ws}>
            Add
          </Button>
        </div>
      </Card>

      <Card>
        {providers.loading ? (
          <Spinner />
        ) : list.length === 0 ? (
          <EmptyState message="No providers configured." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Kind</Th>
                <Th>Base URL</Th>
                <Th>Enabled</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <Td>{p.kind}</Td>
                  <Td className="font-mono text-xs text-neutral-500">{p.baseUrl ?? '—'}</Td>
                  <Td>
                    <Badge tone={p.enabled ? 'green' : 'neutral'}>{p.enabled ? 'yes' : 'no'}</Badge>
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="ghost"
                      onClick={() => setCredFor(credFor === p.id ? null : p.id)}
                    >
                      Credential
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {credFor ? (
        <Card className="mt-4 p-4">
          <div className="mb-3 font-medium">Set credential (Secrets Manager ARN only)</div>
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-96"
              placeholder="secret ARN"
              value={arn}
              onChange={(e) => setArn(e.target.value)}
            />
            <Input
              className="w-48"
              placeholder="secret version"
              value={ver}
              onChange={(e) => setVer(e.target.value)}
            />
            <Button
              variant="primary"
              onClick={() => void saveCredential()}
              disabled={!arn.trim() || !ver.trim()}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setCredFor(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
