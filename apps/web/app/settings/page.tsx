'use client';

import { useState } from 'react';
import {
  Button,
  CodeBlock,
  Dot,
  EmptyState,
  ErrorNote,
  MicroLabel,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  StatusChip,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';
import { isNotConfigured } from '../../lib/api';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

export default function SettingsPage() {
  const { api } = useAdmin();
  const status = useAdminQuery((a) => a.adminStatus(), []);
  const level = useAdminQuery((a) => a.logLevel(), []);
  const dump = useAdminQuery((a) => a.configDump(), []);
  const [busy, setBusy] = useState(false);

  const subsystems = status.data?.subsystems ?? {};

  async function setLevel(l: string): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      await api.setLogLevel(l);
      level.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Settings & status"
        subtitle="Deployment version, which optional subsystems are wired, runtime log level, and the redacted effective config."
        actions={
          status.data ? <StatusChip tone="blue">v{status.data.version}</StatusChip> : undefined
        }
      />
      {status.error ? <ErrorNote error={status.error} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader
              title="Subsystems"
              meta={status.data?.durable ? 'durable (Postgres)' : 'in-memory'}
            />
            {status.loading ? (
              <Spinner />
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 p-3.5 md:grid-cols-3">
                {Object.entries(subsystems).map(([k, on]) => (
                  <div key={k} className="flex items-center gap-2">
                    <Dot tone={on ? 'green' : 'amber'} halo={!on} />
                    <span className="text-[11.5px] text-body">{k}</span>
                    <span className="ml-auto font-mono text-[9px] text-secondary">
                      {on ? 'on' : 'off'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Effective config" meta="secret values redacted → set/unset" />
            <div className="p-3">
              {dump.loading ? (
                <Spinner />
              ) : dump.error ? (
                isNotConfigured(dump.error) ? (
                  <EmptyState message="Config dump not available." />
                ) : (
                  <ErrorNote error={dump.error} />
                )
              ) : (
                <CodeBlock terminal className="max-h-[360px]">
                  {JSON.stringify(dump.data, null, 2)}
                </CodeBlock>
              )}
            </div>
          </Panel>
        </div>

        <Panel>
          <PanelHeader title="Runtime log level" />
          <div className="flex flex-col gap-3 p-3.5">
            <MicroLabel>Current</MicroLabel>
            {level.loading ? (
              <Spinner />
            ) : level.error ? (
              isNotConfigured(level.error) ? (
                <span className="text-[11px] text-micro">not available</span>
              ) : (
                <ErrorNote error={level.error} />
              )
            ) : (
              <>
                <StatusChip tone="blue">{level.data?.level ?? '—'}</StatusChip>
                <MicroLabel className="mt-1">Set (no redeploy)</MicroLabel>
                <Select
                  value={level.data?.level ?? 'info'}
                  onChange={(e) => void setLevel(e.target.value)}
                  className="w-full"
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
                {busy ? <span className="text-[10px] text-secondary">updating…</span> : null}
                <Button variant="ghost" onClick={() => level.refetch()}>
                  Refresh
                </Button>
              </>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
