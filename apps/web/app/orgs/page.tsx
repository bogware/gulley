'use client';

import { useState } from 'react';
import {
  Button,
  Cell,
  EmptyState,
  ErrorNote,
  Field,
  GridRow,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
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

  async function run(fn: () => Promise<unknown>, after: () => void): Promise<void> {
    if (!api) return;
    setError(undefined);
    try {
      await fn();
      after();
    } catch (e) {
      setError(msg(e));
    }
  }

  const orgList = orgs.data?.orgs ?? [];
  const wsList = workspaces.data?.workspaces ?? [];
  const orgName2 = (id: string): string => orgList.find((o) => o.id === id)?.name ?? id;

  return (
    <div>
      <PageHeader title="Orgs & workspaces" subtitle="The tenancy tree that scopes everything." />
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* orgs */}
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Organizations"
            meta={`${orgList.length}`}
            right={
              <div className="flex items-center gap-1.5">
                <Input
                  className="w-40"
                  placeholder="new org"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={!orgName.trim()}
                  onClick={() =>
                    void run(
                      () => api!.createOrg(orgName.trim()),
                      () => {
                        setOrgName('');
                        orgs.refetch();
                      },
                    )
                  }
                >
                  Add
                </Button>
              </div>
            }
          />
          {orgs.loading ? (
            <Spinner />
          ) : orgs.error ? (
            <div className="p-3">
              <ErrorNote error={orgs.error} onRetry={orgs.refetch} />
            </div>
          ) : orgList.length === 0 ? (
            <EmptyState message="No orgs yet." />
          ) : (
            <div>
              <GridRow cols="minmax(0,1fr) minmax(0,1.4fr) 70px" header>
                <Cell>Name</Cell>
                <Cell>ID</Cell>
                <Cell align="right"> </Cell>
              </GridRow>
              {orgList.map((o) => (
                <GridRow key={o.id} cols="minmax(0,1fr) minmax(0,1.4fr) 70px">
                  <Cell tone="ink">{o.name}</Cell>
                  <Cell mono tone="secondary">
                    {o.id}
                  </Cell>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Delete org "${o.name}"? Its workspaces, keys and config go with it.`,
                          )
                        )
                          return;
                        void run(
                          () => api!.deleteOrg(o.id),
                          () => {
                            orgs.refetch();
                            workspaces.refetch();
                          },
                        );
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </GridRow>
              ))}
            </div>
          )}
        </Panel>

        {/* workspaces */}
        <Panel className="overflow-hidden">
          <PanelHeader title="Workspaces" meta={`${wsList.length}`} />
          <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2.5">
            <Field label="Org" className="w-40">
              <Select value={wsOrg} onChange={(e) => setWsOrg(e.target.value)} className="w-full">
                <option value="">select org…</option>
                {orgList.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name" className="flex-1">
              <Input
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                placeholder="workspace"
              />
            </Field>
            <Button
              variant="primary"
              disabled={!wsOrg || !wsName.trim()}
              onClick={() =>
                void run(
                  () => api!.createWorkspace(wsOrg, wsName.trim()),
                  () => {
                    setWsName('');
                    workspaces.refetch();
                  },
                )
              }
            >
              Add
            </Button>
          </div>
          {workspaces.loading ? (
            <Spinner />
          ) : workspaces.error ? (
            <div className="p-3">
              <ErrorNote error={workspaces.error} onRetry={workspaces.refetch} />
            </div>
          ) : wsList.length === 0 ? (
            <EmptyState message="No workspaces yet." />
          ) : (
            <div>
              <GridRow cols="minmax(0,1fr) 120px 70px" header>
                <Cell>Name</Cell>
                <Cell>Org</Cell>
                <Cell align="right"> </Cell>
              </GridRow>
              {wsList.map((w) => (
                <GridRow key={w.id} cols="minmax(0,1fr) 120px 70px">
                  <Cell tone="ink">{w.name}</Cell>
                  <Cell tone="secondary">{orgName2(w.orgId)}</Cell>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (!window.confirm(`Delete workspace "${w.name}" and everything in it?`))
                          return;
                        void run(
                          () => api!.deleteWorkspace(w.id),
                          () => workspaces.refetch(),
                        );
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </GridRow>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
