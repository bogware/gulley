'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  Cell,
  EmptyState,
  ErrorNote,
  Field,
  GridRow,
  InlineResult,
  Input,
  Meter,
  PageHeader,
  Panel,
  PanelHeader,
  SegmentedControl,
  Select,
  Spinner,
  StatusChip,
  Tabs,
} from '../../components/ui';
import { useAdmin } from '../../lib/admin-context';
import { describeError, isNotConfigured } from '../../lib/api';
import { formatNum, formatTime, formatTokens, formatUsd } from '../../lib/format';
import { useAdminQuery } from '../../lib/hooks';
import type {
  AgentNode,
  ChargebackRow,
  PromptNode,
  SessionBlock,
  SessionNode,
  ShadowSpendReport,
} from '../../lib/types';

type Tab = 'chargeback' | 'agents' | 'runaway' | 'shadow';
type GroupBy =
  'workspace' | 'provider' | 'model' | 'attr:agent' | 'attr:repo' | 'attr:dev' | 'attr:session';
type Range = '24h' | '7d' | '30d';

/** The FOCUS export follows `x-next-cursor` this many pages (50k rows each) at most. */
const FOCUS_MAX_PAGES = 40;

function rangeWindow(range: Range): { from: string; to: string } {
  const to = new Date();
  const ms = range === '24h' ? 86_400_000 : range === '7d' ? 604_800_000 : 2_592_000_000;
  return { from: new Date(to.getTime() - ms).toISOString(), to: to.toISOString() };
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function FinOpsPage() {
  const [tab, setTab] = useState<Tab>('chargeback');
  return (
    <div>
      <PageHeader
        title="FinOps"
        subtitle="Cost attribution across coding agents, repos, and developers — per-agent cost trees, FOCUS export, the runaway-session kill switch, and the CISO bypass alert."
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'chargeback', label: 'Chargeback' },
            { value: 'agents', label: 'Agent tree' },
            { value: 'runaway', label: 'Runaway sessions' },
            { value: 'shadow', label: 'Shadow-spend' },
          ]}
        />
      </div>
      {tab === 'chargeback' ? (
        <Chargeback />
      ) : tab === 'agents' ? (
        <AgentTree />
      ) : tab === 'runaway' ? (
        <RunawaySessions />
      ) : (
        <ShadowSpend />
      )}
    </div>
  );
}

function Chargeback() {
  const { api } = useAdmin();
  const [range, setRange] = useState<Range>('7d');
  const [groupBy, setGroupBy] = useState<GroupBy>('attr:agent');
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusNote, setFocusNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const window = useMemo(() => rangeWindow(range), [range]);

  const q = useAdminQuery((a) => a.chargeback({ ...window, groupBy }), [range, groupBy]);
  const rows: ChargebackRow[] = (q.data?.rows ?? [])
    .slice()
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  const total = rows.reduce((a, r) => a + r.costMicroUsd, 0);
  const saved = rows.reduce((a, r) => a + (r.cacheSavedMicroUsd ?? 0), 0);

  function csv(): void {
    // Quote+escape every field, and neutralize spreadsheet formula injection on the
    // user-influenced attribution key (a value starting =,+,-,@ becomes a live formula
    // in Excel). `r.key` is an attribution label (repo/dev/session), so it is untrusted.
    const cell = (v: unknown): string => {
      let s = String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = 'key,requests,inputTokens,outputTokens,costUsd,cacheSavedUsd\n';
    const body = rows
      .map((r) =>
        [
          r.key ?? 'un-attributed',
          r.requests,
          r.inputTokens,
          r.outputTokens,
          (r.costMicroUsd / 1e6).toFixed(6),
          ((r.cacheSavedMicroUsd ?? 0) / 1e6).toFixed(6),
        ]
          .map(cell)
          .join(','),
      )
      .join('\n');
    download(`gulley-chargeback-${groupBy.replace(':', '-')}.csv`, header + body, 'text/csv');
  }

  /** FOCUS 1.2 CSV for the selected range: the server streams 50k-row pages and
   *  signals a continuation in `x-next-cursor`; pages are concatenated client-side
   *  (the header line only once). */
  async function focusExport(): Promise<void> {
    if (!api || focusBusy) return;
    setFocusBusy(true);
    setFocusNote(null);
    try {
      let cursor: string | undefined;
      let out = '';
      let pages = 0;
      for (;;) {
        const page = await api.focusCsv({ ...window, cursor });
        out += pages === 0 ? page.csv : page.csv.slice(page.csv.indexOf('\n') + 1);
        pages++;
        if (!page.nextCursor || pages >= FOCUS_MAX_PAGES) {
          cursor = page.nextCursor;
          break;
        }
        cursor = page.nextCursor;
      }
      const stamp = (iso: string): string => iso.slice(0, 10);
      download(
        `gulley-focus-${stamp(window.from)}-${stamp(window.to)}.csv`,
        out,
        'text/csv;charset=utf-8',
      );
      setFocusNote({
        tone: 'ok',
        text: cursor
          ? `Downloaded the first ${pages} pages (${FOCUS_MAX_PAGES} × 50k rows); narrow the range for the rest.`
          : `FOCUS export downloaded (${pages} page${pages === 1 ? '' : 's'}).`,
      });
    } catch (e) {
      setFocusNote({ tone: 'err', text: describeError(e) });
    } finally {
      setFocusBusy(false);
    }
  }

  if (q.error && isNotConfigured(q.error)) {
    return (
      <Panel>
        <PanelHeader title="Chargeback needs a database" />
        <div className="p-4 text-[11.5px] text-body">
          Chargeback aggregates the durable spend ledger — configure DATABASE_URL to enable it.
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="attr:agent">by agent (claude-code vs codex)</option>
            <option value="attr:repo">by repo</option>
            <option value="attr:dev">by developer</option>
            <option value="attr:session">by session</option>
            <option value="workspace">by workspace</option>
            <option value="model">by model</option>
            <option value="provider">by provider</option>
          </Select>
          <SegmentedControl
            value={range}
            onChange={setRange}
            options={[
              { value: '24h', label: '24h' },
              { value: '7d', label: '7d' },
              { value: '30d', label: '30d' },
            ]}
          />
          <Button onClick={() => void focusExport()} disabled={focusBusy || !api}>
            {focusBusy ? 'Exporting…' : 'FOCUS export'}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <StatTileInline label="Total" value={formatUsd(total)} />
          <StatTileInline label="Cache saved" value={formatUsd(saved)} />
        </div>
      </div>
      {focusNote ? <InlineResult tone={focusNote.tone}>{focusNote.text}</InlineResult> : null}

      <Panel className="overflow-hidden">
        <PanelHeader
          title={`Spend by ${groupBy}`}
          meta={`${rows.length}`}
          right={
            <button onClick={csv} className="text-[11px] text-accent hover:underline">
              Export CSV
            </button>
          }
        />
        {q.loading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-3">
            <ErrorNote error={q.error} onRetry={q.refetch} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState message="No spend in range." />
        ) : (
          <div className="overflow-x-auto">
            <div style={{ minWidth: '640px' }}>
              <GridRow cols="minmax(0,1fr) 150px 76px 82px 82px 84px" header>
                <Cell>{groupBy}</Cell>
                <Cell>Share</Cell>
                <Cell align="right">Requests</Cell>
                <Cell align="right">In</Cell>
                <Cell align="right">Out</Cell>
                <Cell align="right">Cost</Cell>
              </GridRow>
              {rows.map((r, i) => (
                <GridRow key={i} cols="minmax(0,1fr) 150px 76px 82px 82px 84px">
                  <Cell mono tone="ink">
                    {r.key ?? <span className="text-micro">un-attributed</span>}
                  </Cell>
                  <div className="pr-2">
                    <Meter ratio={total ? r.costMicroUsd / total : 0} />
                  </div>
                  <Cell align="right" mono>
                    {formatNum(r.requests)}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {formatTokens(r.inputTokens)}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {formatTokens(r.outputTokens)}
                  </Cell>
                  <Cell align="right" mono tone="ink">
                    {formatUsd(r.costMicroUsd)}
                  </Cell>
                </GridRow>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

const TREE_COLS = 'minmax(0,1fr) 64px 70px 84px 84px 84px 130px 70px';

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : '–';
}

function AgentTree() {
  const { api } = useAdmin();
  const [range, setRange] = useState<Range>('7d');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const window = useMemo(() => rangeWindow(range), [range]);
  const q = useAdminQuery((a) => a.agentTree(window), [range]);
  const sessions: SessionNode[] = q.data?.tree ?? [];
  const total = sessions.reduce((a, s) => a + s.costMicroUsd, 0);
  const compaction = sessions.reduce((a, s) => a + s.compactionMicroUsd, 0);
  const subagents = sessions.reduce((a, s) => a + s.subagentMicroUsd, 0);

  function toggle(key: string): void {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function block(s: SessionNode): Promise<void> {
    if (!api || !s.workspaceId) return;
    const reason = window_prompt(`Block session ${s.session} for 4 hours — reason:`);
    if (!reason) return;
    try {
      await api.blockSession(s.session, {
        workspaceId: s.workspaceId,
        reason,
        ttlSeconds: 4 * 3600,
      });
      setNote({ tone: 'ok', text: `Blocked ${s.session} for 4h (audited session.blocked).` });
    } catch (e) {
      setNote({ tone: 'err', text: describeError(e) });
    }
  }

  if (q.error && isNotConfigured(q.error)) {
    return (
      <Panel>
        <PanelHeader title="The agent cost tree needs a database" />
        <div className="p-4 text-[11.5px] text-body">
          Sessions, prompts and subagents are rolled up from the durable spend ledger — configure
          DATABASE_URL to enable it.
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={range}
          onChange={setRange}
          options={[
            { value: '24h', label: '24h' },
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
          ]}
        />
        <div className="flex items-center gap-2">
          <StatTileInline label="Sessions" value={formatNum(sessions.length)} />
          <StatTileInline label="Total" value={formatUsd(total)} />
          <StatTileInline label="Compaction" value={pct(compaction, total)} />
          <StatTileInline label="Subagents" value={pct(subagents, total)} />
        </div>
      </div>
      {note ? <InlineResult tone={note.tone}>{note.text}</InlineResult> : null}
      {q.data?.truncated ? (
        <InlineResult tone="info">
          More than 10,000 sessions matched — the costliest are shown; narrow the range.
        </InlineResult>
      ) : null}

      <Panel className="overflow-hidden">
        <PanelHeader title="Spend by session → prompt → subagent" meta={`${sessions.length}`} />
        {q.loading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-3">
            <ErrorNote error={q.error} onRetry={q.refetch} />
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState message="No sessions in range (sessions need the x-claude-code-session-id header or a mapped `session` attribution header)." />
        ) : (
          <div className="overflow-x-auto">
            <div style={{ minWidth: '820px' }}>
              <GridRow cols={TREE_COLS} header>
                <Cell>Session</Cell>
                <Cell align="right">Reqs</Cell>
                <Cell align="right">Tokens</Cell>
                <Cell align="right">Cost</Cell>
                <Cell align="right">Compaction</Cell>
                <Cell align="right">Subagents</Cell>
                <Cell>Last active</Cell>
                <Cell></Cell>
              </GridRow>
              {sessions.map((s) => {
                const key = `${s.workspaceId ?? ''}:${s.session}`;
                const expanded = open.has(key);
                return (
                  <div key={key}>
                    <GridRow cols={TREE_COLS}>
                      <Cell mono tone="ink">
                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          className="text-left hover:underline"
                          title={s.principalId ? `principal ${s.principalId}` : undefined}
                        >
                          {expanded ? '▾' : '▸'} {s.session}
                        </button>
                      </Cell>
                      <Cell align="right" mono>
                        {formatNum(s.requests)}
                      </Cell>
                      <Cell align="right" mono tone="secondary">
                        {formatTokens(s.inputTokens + s.outputTokens)}
                      </Cell>
                      <Cell align="right" mono tone="ink">
                        {formatUsd(s.costMicroUsd)}
                      </Cell>
                      <Cell align="right" mono tone="secondary">
                        {pct(s.compactionMicroUsd, s.costMicroUsd)}
                      </Cell>
                      <Cell align="right" mono tone="secondary">
                        {pct(s.subagentMicroUsd, s.costMicroUsd)}
                      </Cell>
                      <Cell tone="secondary">{formatTime(s.lastAt)}</Cell>
                      <div className="flex justify-end pr-2">
                        <button
                          type="button"
                          onClick={() => void block(s)}
                          disabled={!s.workspaceId || !api}
                          className="text-[11px] text-err-text hover:underline disabled:opacity-40"
                        >
                          Block
                        </button>
                      </div>
                    </GridRow>
                    {expanded
                      ? s.prompts.map((p, i) => <PromptRows key={i} prompt={p} session={s} />)
                      : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function window_prompt(message: string): string | null {
  return typeof globalThis.prompt === 'function' ? globalThis.prompt(message) : null;
}

function PromptRows({ prompt, session }: { prompt: PromptNode; session: SessionNode }) {
  return (
    <div className="bg-rail/40">
      <GridRow cols={TREE_COLS}>
        <Cell mono tone="body">
          <span className="pl-5">
            ↳ prompt {prompt.prompt ?? <span className="text-micro">(no prompt id)</span>}
          </span>
        </Cell>
        <Cell align="right" mono>
          {formatNum(prompt.requests)}
        </Cell>
        <Cell align="right" mono tone="secondary">
          {formatTokens(prompt.inputTokens + prompt.outputTokens)}
        </Cell>
        <Cell align="right" mono tone="ink">
          {formatUsd(prompt.costMicroUsd)}
        </Cell>
        <Cell align="right" mono tone="secondary">
          {pct(prompt.compactionMicroUsd, session.costMicroUsd)}
        </Cell>
        <Cell align="right" mono tone="secondary">
          {pct(prompt.subagentMicroUsd, session.costMicroUsd)}
        </Cell>
        <Cell tone="secondary">
          main thread {formatUsd(prompt.direct.costMicroUsd)} · {formatNum(prompt.direct.requests)}{' '}
          reqs
        </Cell>
        <div />
      </GridRow>
      {prompt.agents.map((a) => (
        <AgentRows key={a.ccAgent} node={a} depth={2} session={session} />
      ))}
    </div>
  );
}

function AgentRows({
  node,
  depth,
  session,
}: {
  node: AgentNode;
  depth: number;
  session: SessionNode;
}) {
  return (
    <>
      <GridRow cols={TREE_COLS}>
        <Cell mono tone="secondary">
          <span style={{ paddingLeft: `${depth * 20}px` }}>↳ agent {node.ccAgent}</span>
        </Cell>
        <Cell align="right" mono>
          {formatNum(node.requests)}
        </Cell>
        <Cell align="right" mono tone="secondary">
          {formatTokens(node.inputTokens + node.outputTokens)}
        </Cell>
        <Cell align="right" mono>
          {formatUsd(node.costMicroUsd)}
        </Cell>
        <Cell align="right" mono tone="secondary">
          {pct(node.compactionMicroUsd, session.costMicroUsd)}
        </Cell>
        <Cell align="right" mono tone="secondary">
          {pct(node.subagentMicroUsd, session.costMicroUsd)}
        </Cell>
        <Cell tone="secondary">{node.ccParentAgent ? `parent ${node.ccParentAgent}` : ''}</Cell>
        <div />
      </GridRow>
      {node.children.map((c) => (
        <AgentRows key={c.ccAgent} node={c} depth={depth + 1} session={session} />
      ))}
    </>
  );
}

const BLOCK_COLS = 'minmax(0,1fr) 150px 80px minmax(0,1.4fr) 120px 130px 60px';

function RunawaySessions() {
  const { api } = useAdmin();
  const q = useAdminQuery((a) => a.blockedSessions(), []);
  const blocks: SessionBlock[] = q.data?.blocks ?? [];
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [form, setForm] = useState({ workspaceId: '', session: '', reason: '', ttlMinutes: '240' });
  const [busy, setBusy] = useState(false);

  async function unblock(b: SessionBlock): Promise<void> {
    if (
      !api ||
      !globalThis.confirm(`Unblock session ${b.session}? Its requests resume immediately.`)
    )
      return;
    try {
      await api.unblockSession(b.session, b.workspaceId);
      setNote({ tone: 'ok', text: `Unblocked ${b.session} (audited session.unblocked).` });
      q.refetch();
    } catch (e) {
      setNote({ tone: 'err', text: describeError(e) });
    }
  }

  async function submit(): Promise<void> {
    if (!api) return;
    const ttl = Number(form.ttlMinutes);
    setBusy(true);
    setNote(null);
    try {
      await api.blockSession(form.session.trim(), {
        workspaceId: form.workspaceId.trim(),
        reason: form.reason.trim(),
        ...(Number.isFinite(ttl) && ttl > 0 ? { ttlSeconds: Math.round(ttl * 60) } : {}),
      });
      setNote({ tone: 'ok', text: `Blocked ${form.session.trim()} (audited session.blocked).` });
      setForm((f) => ({ ...f, session: '', reason: '' }));
      q.refetch();
    } catch (e) {
      setNote({ tone: 'err', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  if (q.error && isNotConfigured(q.error)) {
    return (
      <Panel>
        <PanelHeader title="The session kill switch needs a database" />
        <div className="p-4 text-[11.5px] leading-[1.7] text-body">
          Runaway-session blocks live in Postgres (the gateway refreshes a snapshot every 10 s).
          Configure DATABASE_URL, then tune RUNAWAY_* on the control-api (see docs/FINOPS.md).
        </div>
      </Panel>
    );
  }

  const canSubmit =
    !busy &&
    !!api &&
    form.workspaceId.trim() !== '' &&
    form.session.trim() !== '' &&
    form.reason.trim() !== '';

  return (
    <div className="flex flex-col gap-4">
      {note ? <InlineResult tone={note.tone}>{note.text}</InlineResult> : null}
      <Panel className="overflow-hidden">
        <PanelHeader
          title="Blocked sessions"
          meta={`${blocks.length}`}
          right={
            <button onClick={q.refetch} className="text-[11px] text-accent hover:underline">
              Refresh
            </button>
          }
        />
        {q.loading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-3">
            <ErrorNote error={q.error} onRetry={q.refetch} />
          </div>
        ) : blocks.length === 0 ? (
          <EmptyState message="No blocked sessions. The detector flags by default (RUNAWAY_ACTION=flag) — see the session.runaway audit events." />
        ) : (
          <div className="overflow-x-auto">
            <div style={{ minWidth: '900px' }}>
              <GridRow cols={BLOCK_COLS} header>
                <Cell>Session</Cell>
                <Cell>Workspace</Cell>
                <Cell>Source</Cell>
                <Cell>Reason</Cell>
                <Cell>By</Cell>
                <Cell>Expires</Cell>
                <Cell></Cell>
              </GridRow>
              {blocks.map((b) => (
                <GridRow key={`${b.workspaceId}:${b.session}`} cols={BLOCK_COLS}>
                  <Cell mono tone="ink">
                    {b.session}
                  </Cell>
                  <Cell mono tone="secondary">
                    {b.workspaceId.slice(0, 8)}…
                  </Cell>
                  <div>
                    <StatusChip tone={b.source === 'runaway' ? 'red' : 'amber'}>
                      {b.source}
                    </StatusChip>
                  </div>
                  <Cell tone="body">{b.reason}</Cell>
                  <Cell mono tone="secondary">
                    {b.createdBy}
                  </Cell>
                  <Cell tone="secondary">
                    {b.expiresAt ? formatTime(b.expiresAt) : 'until unblocked'}
                  </Cell>
                  <div className="flex justify-end pr-2">
                    <button
                      type="button"
                      onClick={() => void unblock(b)}
                      disabled={!api}
                      className="text-[11px] text-accent hover:underline disabled:opacity-40"
                    >
                      Unblock
                    </button>
                  </div>
                </GridRow>
              ))}
            </div>
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Block a session manually" />
        <div className="flex flex-col gap-3 p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Workspace id">
              <Input
                value={form.workspaceId}
                onChange={(e) => setForm((f) => ({ ...f, workspaceId: e.target.value }))}
                placeholder="uuid"
              />
            </Field>
            <Field label="Session id">
              <Input
                value={form.session}
                onChange={(e) => setForm((f) => ({ ...f, session: e.target.value }))}
                placeholder="x-claude-code-session-id"
              />
            </Field>
            <Field label="Reason">
              <Input
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="why (audited)"
              />
            </Field>
            <Field label="TTL (minutes, blank = until unblocked)">
              <Input
                value={form.ttlMinutes}
                onChange={(e) => setForm((f) => ({ ...f, ttlMinutes: e.target.value }))}
                inputMode="numeric"
              />
            </Field>
          </div>
          <div>
            <Button variant="danger" onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? 'Blocking…' : 'Block session'}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ShadowSpend() {
  const q = useAdminQuery((a) => a.shadowSpend(), []);
  const report: ShadowSpendReport | undefined = q.data;

  if (q.error && isNotConfigured(q.error)) {
    return (
      <Panel>
        <PanelHeader title="Shadow-spend needs a database + provider admin keys" />
        <div className="p-4 text-[11.5px] leading-[1.7] text-body">
          Reconciliation compares each provider&apos;s own billed usage against gateway-mediated
          ledger spend. Configure DATABASE_URL and the provider admin API keys
          (ANTHROPIC_ADMIN_API_KEY / OPENAI_ADMIN_API_KEY) to surface spend that bypassed Gulley.
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {report?.flagged ? (
        <InlineResult tone="err">
          Bypass detected — provider-billed spend exceeds gateway-mediated spend beyond the
          threshold.
        </InlineResult>
      ) : report ? (
        <InlineResult tone="ok">
          No bypass flagged — provider billing reconciles with the gateway ledger.
        </InlineResult>
      ) : null}

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Reconciliation by provider"
          meta={
            report?.reconciledProviders
              ? `${report.reconciledProviders.length} reconciled`
              : undefined
          }
        />
        {q.loading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-3">
            <ErrorNote error={q.error} />
          </div>
        ) : (report?.rows.length ?? 0) === 0 ? (
          <EmptyState message="No reconciliation data." />
        ) : (
          <div>
            <GridRow cols="minmax(0,1fr) 100px 100px 100px 70px 70px" header>
              <Cell>Provider</Cell>
              <Cell align="right">Gateway</Cell>
              <Cell align="right">Provider</Cell>
              <Cell align="right">Shadow</Cell>
              <Cell align="right">Ratio</Cell>
              <Cell align="right">Flag</Cell>
            </GridRow>
            {(report?.rows ?? [])
              .slice()
              .sort((a, b) => b.shadowMicroUsd - a.shadowMicroUsd)
              .map((r) => (
                <GridRow key={r.provider} cols="minmax(0,1fr) 100px 100px 100px 70px 70px">
                  <Cell tone="ink">{r.provider}</Cell>
                  <Cell align="right" mono>
                    {formatUsd(r.gatewayMicroUsd)}
                  </Cell>
                  <Cell align="right" mono>
                    {formatUsd(r.providerMicroUsd)}
                  </Cell>
                  <Cell align="right" mono tone={r.flagged ? 'ink' : 'secondary'}>
                    {formatUsd(r.shadowMicroUsd)}
                  </Cell>
                  <Cell align="right" mono tone="secondary">
                    {(r.shadowRatio * 100).toFixed(1)}%
                  </Cell>
                  <div className="flex justify-end">
                    <StatusChip tone={r.flagged ? 'red' : 'green'}>
                      {r.flagged ? 'bypass' : 'ok'}
                    </StatusChip>
                  </div>
                </GridRow>
              ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function StatTileInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-line-card bg-panel px-3 py-1.5">
      <span className="text-[9px] uppercase tracking-[0.14em] text-micro">{label} </span>
      <span className="font-mono text-[13px] tabular-nums text-ink">{value}</span>
    </div>
  );
}
