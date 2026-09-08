'use client';

import { useState } from 'react';
import {
  Button,
  Cell,
  CodeBlock,
  EmptyState,
  ErrorNote,
  Field,
  GridRow,
  InlineResult,
  Input,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  Spinner,
  StatusChip,
} from '../../components/ui';
import { isNotConfigured } from '../../lib/api';
import { useAdmin } from '../../lib/admin-context';
import { useAdminQuery } from '../../lib/hooks';
import type { Rollout } from '../../lib/types';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = {
  promoted: 'green',
  held: 'amber',
  error: 'red',
  pending: 'neutral',
};

const SAMPLE_SUITE = JSON.stringify(
  {
    name: 'smoke',
    cases: [
      {
        id: 'add',
        request: { messages: [{ role: 'user', content: 'what is 2+2? number only' }] },
        scorers: [{ scorer: { kind: 'contains', text: '4' } }],
      },
    ],
  },
  null,
  2,
);

export default function RolloutsPage() {
  const { api } = useAdmin();
  const suites = useAdminQuery((a) => a.evalSuites(), []);
  const rollouts = useAdminQuery((a) => a.rollouts(), []);
  const workspaces = useAdminQuery((a) => a.workspaces(), []);
  const [error, setError] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<unknown>(null);

  const [suiteText, setSuiteText] = useState(SAMPLE_SUITE);
  const [form, setForm] = useState({
    suiteId: '',
    workspaceId: '',
    alias: '',
    fromModel: '',
    toModel: '',
  });

  async function run<T>(fn: () => Promise<T>, after?: (r: T) => void): Promise<void> {
    if (!api) return;
    setError(undefined);
    try {
      const r = await fn();
      after?.(r);
    } catch (e) {
      setError(msg(e));
    }
  }

  const suiteList = suites.data?.suites ?? [];
  const rolloutList = rollouts.data?.rollouts ?? [];

  return (
    <div>
      <PageHeader
        title="Eval rollouts"
        subtitle="Gate a model-alias change on a deterministic golden-set eval: run candidate vs incumbent through the gateway, promote only if it clears."
      />
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* rollouts */}
        <div className="flex flex-col gap-4">
          <Panel className="overflow-hidden">
            <PanelHeader title="Rollouts" meta={`${rolloutList.length}`} />
            {rollouts.loading ? (
              <Spinner />
            ) : rolloutList.length === 0 ? (
              <EmptyState message="No rollouts yet." />
            ) : (
              <div>
                <GridRow cols="minmax(0,1fr) 90px 84px" header>
                  <Cell>Alias → candidate</Cell>
                  <Cell>Status</Cell>
                  <Cell align="right">Run</Cell>
                </GridRow>
                {rolloutList.map((r: Rollout) => (
                  <GridRow key={r.id} cols="minmax(0,1fr) 90px 84px">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-ink">
                        {r.target.alias} → {r.target.toModel}
                      </div>
                      <div className="font-mono text-[9px] text-secondary">
                        from {r.target.fromModel}
                      </div>
                    </div>
                    <Cell>
                      <StatusChip tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</StatusChip>
                    </Cell>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void run(
                            () => api!.runRollout(r.id),
                            (res) => {
                              setReport(res.rollout.report ?? res.rollout);
                              rollouts.refetch();
                            },
                          )
                        }
                      >
                        Run
                      </Button>
                    </div>
                  </GridRow>
                ))}
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="New rollout" />
            <div className="grid grid-cols-1 gap-2.5 p-3.5 md:grid-cols-2">
              <Field label="Suite">
                <Select
                  value={form.suiteId}
                  onChange={(e) => setForm({ ...form, suiteId: e.target.value })}
                  className="w-full"
                >
                  <option value="">suite…</option>
                  {suiteList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Workspace">
                <Select
                  value={form.workspaceId}
                  onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}
                  className="w-full"
                >
                  <option value="">workspace…</option>
                  {workspaces.data?.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Alias">
                <Input
                  value={form.alias}
                  onChange={(e) => setForm({ ...form, alias: e.target.value })}
                  placeholder="coding-default"
                />
              </Field>
              <Field label="From model">
                <Input
                  value={form.fromModel}
                  onChange={(e) => setForm({ ...form, fromModel: e.target.value })}
                  placeholder="claude-sonnet-4-5"
                />
              </Field>
              <Field label="To (candidate)">
                <Input
                  value={form.toModel}
                  onChange={(e) => setForm({ ...form, toModel: e.target.value })}
                  placeholder="claude-sonnet-4-6"
                />
              </Field>
              <div className="flex items-end">
                <Button
                  variant="primary"
                  disabled={
                    !form.suiteId ||
                    !form.workspaceId ||
                    !form.alias ||
                    !form.fromModel ||
                    !form.toModel
                  }
                  onClick={() =>
                    void run(
                      () => api!.createRollout(form),
                      () => rollouts.refetch(),
                    )
                  }
                >
                  Create rollout
                </Button>
              </div>
            </div>
          </Panel>

          {report ? (
            <Panel>
              <PanelHeader
                title="Last run report"
                right={
                  <button
                    onClick={() => setReport(null)}
                    className="text-[11px] text-secondary hover:text-ink"
                  >
                    clear
                  </button>
                }
              />
              <div className="p-3">
                <CodeBlock terminal className="max-h-[280px]">
                  {JSON.stringify(report, null, 2)}
                </CodeBlock>
              </div>
            </Panel>
          ) : null}
        </div>

        {/* suites */}
        <div className="flex flex-col gap-4">
          <Panel className="overflow-hidden">
            <PanelHeader title="Eval suites" meta={`${suiteList.length}`} />
            {suites.loading ? (
              <Spinner />
            ) : suiteList.length === 0 ? (
              <EmptyState message="No suites yet." />
            ) : (
              <div>
                <GridRow cols="minmax(0,1fr) 70px 70px" header>
                  <Cell>Name</Cell>
                  <Cell align="right">Cases</Cell>
                  <Cell align="right"> </Cell>
                </GridRow>
                {suiteList.map((s) => (
                  <GridRow key={s.id} cols="minmax(0,1fr) 70px 70px">
                    <Cell mono tone="ink">
                      {s.name}
                    </Cell>
                    <Cell align="right" mono tone="secondary">
                      {s.cases.length}
                    </Cell>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void run(
                            () => api!.deleteEvalSuite(s.id),
                            () => suites.refetch(),
                          )
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  </GridRow>
                ))}
              </div>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Save an eval suite" meta="golden prompts + deterministic scorers" />
            <div className="flex flex-col gap-2 p-3.5">
              <textarea
                className="min-h-[220px] w-full rounded-control border border-line-control bg-[#FDFCF9] px-2.5 py-2 font-mono text-[10.5px] leading-[1.5] text-ink shadow-field outline-none"
                value={suiteText}
                onChange={(e) => setSuiteText(e.target.value)}
                spellCheck={false}
              />
              <Button
                variant="primary"
                onClick={() =>
                  void run(
                    () => {
                      const parsed = JSON.parse(suiteText);
                      return api!.saveEvalSuite(parsed);
                    },
                    () => suites.refetch(),
                  )
                }
              >
                Save suite
              </Button>
              {suites.error && isNotConfigured(suites.error) ? (
                <InlineResult tone="info">
                  Running a rollout needs EVAL_ROLLOUT_ENABLED + a gateway URL/key.
                </InlineResult>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
