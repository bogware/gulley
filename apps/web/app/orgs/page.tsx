'use client';

import { useState } from 'react';
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
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function OrgsPage() {
  const { api } = useAdmin();
  const orgs = useAdminQuery((a) => a.orgs(), []);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [orgName, setOrgName] = useState('');
  const [wsOrg, setWsOrg] = useState('');
  const [wsName, setWsName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  async function addOrg(): Promise<void> {
    if (!api || !orgName.trim()) return;
    setError(undefined);
    try {
      await api.createOrg(orgName.trim());
      setOrgName('');
      orgs.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }
  async function addWorkspace(): Promise<void> {
    if (!api || !wsOrg || !wsName.trim()) return;
    setError(undefined);
    try {
      await api.createWorkspace(wsOrg, wsName.trim());
      setWsName('');
      workspaces.refetch();
    } catch (e) {
      setError(msg(e));
    }
  }

  const orgList = orgs.data?.orgs ?? [];

  return (
    <div>
      <PageHeader title="Orgs & workspaces" subtitle="The tenancy tree that scopes everything." />
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 font-medium">Organizations</div>
          <div className="mb-3 flex gap-2">
            <Input
              placeholder="New org name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
            <Button variant="primary" onClick={() => void addOrg()} disabled={!orgName.trim()}>
              Add
            </Button>
          </div>
          {orgs.loading ? (
            <Spinner />
          ) : orgList.length === 0 ? (
            <EmptyState message="No orgs yet." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>ID</Th>
                </tr>
              </thead>
              <tbody>
                {orgList.map((o) => (
                  <tr key={o.id}>
                    <Td>{o.name}</Td>
                    <Td className="font-mono text-xs text-neutral-400">{o.id}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 font-medium">Workspaces</div>
          <div className="mb-3 flex flex-wrap gap-2">
            <Select value={wsOrg} onChange={(e) => setWsOrg(e.target.value)}>
              <option value="">select org…</option>
              {orgList.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
            <Input
              placeholder="Workspace name"
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
            />
            <Button
              variant="primary"
              onClick={() => void addWorkspace()}
              disabled={!wsOrg || !wsName.trim()}
            >
              Add
            </Button>
          </div>
          {workspaces.loading ? (
            <Spinner />
          ) : (workspaces.data?.workspaces.length ?? 0) === 0 ? (
            <EmptyState message="No workspaces yet." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>ID</Th>
                </tr>
              </thead>
              <tbody>
                {workspaces.data?.workspaces.map((w) => (
                  <tr key={w.id}>
                    <Td>{w.name}</Td>
                    <Td className="font-mono text-xs text-neutral-400">{w.id}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
