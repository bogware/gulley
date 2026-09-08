'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  Cell,
  CodeBlock,
  EmptyState,
  ErrorNote,
  GridRow,
  InlineResult,
  MicroLabel,
  PageHeader,
  Panel,
  PanelHeader,
  Spinner,
  StatusChip,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';
import { formatTime } from '../../lib/format';
import type { ConfigVersion } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function ConfigPage() {
  const { api } = useAdmin();
  const exported = useAdminQuery((a) => a.configExport(), []);
  const versions = useAdminQuery((a) => a.configVersions(), []);
  const history = useAdminQuery((a) => a.configVersionHistory(20), []);
  const drift = useAdminQuery((a) => a.configDrift(), []);

  const [doc, setDoc] = useState('');
  const [plan, setPlan] = useState<unknown>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (exported.data?.document) setDoc(JSON.stringify(exported.data.document, null, 2));
  }, [exported.data]);

  function parse(): unknown | null {
    try {
      return JSON.parse(doc);
    } catch {
      setResult({ tone: 'err', text: 'Document is not valid JSON.' });
      return null;
    }
  }

  async function dryRun(): Promise<void> {
    if (!api) return;
    const parsed = parse();
    if (parsed === null) return;
    setResult(null);
    try {
      setPlan((await api.configPlan(parsed)).plan);
    } catch (e) {
      setResult({ tone: 'err', text: msg(e) });
    }
  }

  async function apply(): Promise<void> {
    if (!api) return;
    const parsed = parse();
    if (parsed === null) return;
    setResult(null);
    try {
      const r = await api.configApply(parsed, versions.data?.version ?? 0);
      setResult({
        tone: 'ok',
        text: `Applied — version ${r.version} (${r.contentHash.slice(0, 12)}…)`,
      });
      versions.refetch();
      history.refetch();
      drift.refetch();
    } catch (e) {
      setResult({ tone: 'err', text: msg(e) });
    }
  }

  const drifted = (drift.data as { drifted?: boolean } | undefined)?.drifted;

  return (
    <div>
      <PageHeader
        title="Config console"
        subtitle="Export, edit, dry-run, and hot-apply the whole GitOps config document (optimistic-concurrency safe)."
        actions={
          <>
            <StatusChip tone="blue">v{versions.data?.version ?? '—'}</StatusChip>
            {drifted !== undefined ? (
              <StatusChip tone={drifted ? 'amber' : 'green'}>
                {drifted ? 'drifted' : 'in sync'}
              </StatusChip>
            ) : null}
          </>
        }
      />

      {drifted ? (
        <div className="mb-4">
          <InlineResult tone="err">
            Live config has drifted from the stored version — re-apply to reconcile.
          </InlineResult>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel className="overflow-hidden">
          <PanelHeader
            title="Config document"
            meta="apiVersion gulley/v1"
            right={
              <div className="flex items-center gap-2">
                <Button onClick={() => void dryRun()}>Dry-run plan</Button>
                <Button variant="primary" onClick={() => void apply()}>
                  Apply
                </Button>
              </div>
            }
          />
          <div className="flex flex-col gap-2 p-3">
            {exported.loading ? (
              <Spinner />
            ) : exported.error ? (
              <ErrorNote error={exported.error} />
            ) : (
              <textarea
                className="min-h-[420px] w-full rounded-control border border-line-control bg-[#FDFCF9] px-3 py-2.5 font-mono text-[11px] leading-[1.6] text-ink shadow-field outline-none"
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                spellCheck={false}
              />
            )}
            {result ? <InlineResult tone={result.tone}>{result.text}</InlineResult> : null}
            {plan ? (
              <div>
                <MicroLabel className="mb-1">Plan</MicroLabel>
                <CodeBlock terminal>{JSON.stringify(plan, null, 2)}</CodeBlock>
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader title="Version history" meta="newest first" />
          {history.loading ? (
            <Spinner />
          ) : (history.data?.versions.length ?? 0) === 0 ? (
            <EmptyState message="No applied versions yet." />
          ) : (
            <div>
              <GridRow cols="42px minmax(0,1fr) 96px" header>
                <Cell>Ver</Cell>
                <Cell>Actor</Cell>
                <Cell align="right">When</Cell>
              </GridRow>
              {history.data?.versions.map((v: ConfigVersion) => (
                <GridRow key={v.version} cols="42px minmax(0,1fr) 96px">
                  <Cell mono tone="ink">
                    {v.version}
                  </Cell>
                  <Cell mono tone="secondary">
                    {v.actor}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {formatTime(v.createdAt)}
                  </Cell>
                </GridRow>
              ))}
            </div>
          )}
          <div className="border-t border-line p-3 text-[10px] text-micro">
            Rollback is a GitOps re-apply of a prior exported document — historical document bodies
            aren&apos;t retained, only their metadata (version, hash, actor).
          </div>
        </Panel>
      </div>
    </div>
  );
}
