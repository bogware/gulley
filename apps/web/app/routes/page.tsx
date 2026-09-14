'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Cell,
  EmptyState,
  ErrorNote,
  GridRow,
  Panel,
  PanelHeader,
  Spinner,
  StatusChip,
} from '../../components/ui';
import { useAdminQuery } from '../../lib/hooks';
import type { CollectionEntity } from '../../lib/types';

interface Target {
  name: string;
  provider?: string;
  weight: number;
}
interface ParsedRoute {
  id: string;
  alias: string;
  mode: string;
  targets: Target[];
  raw: Record<string, unknown>;
}

const STRATEGIES = [
  { mode: 'loadbalance', title: 'Weighted', desc: 'weight-split load balance across targets' },
  { mode: 'latency', title: 'Latency-aware', desc: 'power-of-two-choices least-load' },
  { mode: 'cost', title: 'Cost-optimal', desc: 'cheapest healthy target by catalog price' },
  { mode: 'conditional', title: 'Classified', desc: 'route by task classifier (smart routing)' },
] as const;

function parseRoute(e: CollectionEntity): ParsedRoute {
  const cfg = e.config ?? {};
  const strat = (cfg['strategy'] ?? cfg) as Record<string, unknown>;
  const mode =
    (typeof cfg['mode'] === 'string' && cfg['mode']) ||
    (typeof strat['mode'] === 'string' && strat['mode']) ||
    (typeof cfg['strategy'] === 'string' && (cfg['strategy'] as string)) ||
    'single';
  const rawTargets = (strat['targets'] ?? cfg['targets'] ?? []) as unknown[];
  const targets: Target[] = Array.isArray(rawTargets)
    ? rawTargets.map((t, i) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          name: String(o['name'] ?? o['model'] ?? o['target'] ?? `target-${i + 1}`),
          provider: typeof o['provider'] === 'string' ? o['provider'] : undefined,
          weight: typeof o['weight'] === 'number' ? o['weight'] : 1,
        };
      })
    : [];
  return { id: e.id, alias: e.name, mode: String(mode), targets, raw: cfg };
}

export default function RoutesPage() {
  const routes = useAdminQuery((a) => a.collection('routes'), []);
  const parsed = useMemo(() => (routes.data?.entities ?? []).map(parseRoute), [routes.data]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = parsed.find((r) => r.id === selectedId) ?? parsed[0] ?? null;

  return (
    <div>
      <div className="-mx-5 -mt-4 mb-4 flex items-center justify-between gap-3 border-b border-line bg-header px-5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">
            Routes &amp; aliases
          </h1>
          {active ? (
            <span className="font-mono text-[13px] text-secondary">alias/{active.alias}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-secondary">{parsed.length} routes</span>
        </div>
      </div>

      {routes.error ? <ErrorNote error={routes.error} /> : null}

      {routes.loading ? (
        <Spinner />
      ) : parsed.length === 0 ? (
        <Panel>
          <PanelHeader title="No standalone routes configured" />
          <div className="p-4 text-[11.5px] leading-[1.7] text-body">
            In v1, each provider is registered as a single-target route automatically, and
            cross-provider load-balance / fallback / same-model arbitrage are composed by{' '}
            <span className="font-mono text-ink">route groups</span> in config. Define an explicit{' '}
            <span className="font-mono text-ink">routes</span> entry (strategy + weighted targets)
            via GitOps config apply and it will appear here as an editable strategy builder.
            <div className="mt-3 rounded-control border border-line-soft bg-inset px-3 py-2 font-mono text-[10.5px] text-secondary">
              docs/ARCHITECTURE.md — Routing &amp; config
            </div>
          </div>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {parsed.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {parsed.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`rounded-control border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                    active?.id === r.id
                      ? 'border-accent bg-accent-tint text-accent-ink'
                      : 'border-line-control bg-panel text-body hover:bg-rail'
                  }`}
                >
                  alias/{r.alias}
                </button>
              ))}
            </div>
          ) : null}
          {active ? <RouteBuilder route={active} /> : null}
        </div>
      )}
    </div>
  );
}

function RouteBuilder({ route }: { route: ParsedRoute }) {
  const [mode, setMode] = useState(route.mode);
  const [targets, setTargets] = useState<Target[]>(route.targets);
  const [dryRun, setDryRun] = useState<string[] | null>(null);

  useEffect(() => {
    setMode(route.mode);
    setTargets(route.targets);
    setDryRun(null);
  }, [route]);

  const sum = targets.reduce((s, t) => s + t.weight, 0);
  const dirty =
    mode !== route.mode || targets.some((t, i) => t.weight !== route.targets[i]?.weight);
  const balanced = sum === 100 || targets.length === 0;

  const setWeight = (i: number, w: number) =>
    setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, weight: w } : t)));

  function runDryRun(): void {
    const total = sum || 1;
    const lines = [
      '$ gulley routes dry-run --n 1000',
      '',
      ...targets.map((t) => {
        const pct = Math.round((t.weight / total) * 100);
        const bar = '█'.repeat(Math.max(0, Math.round(pct / 4)));
        return `${t.name.slice(0, 22).padEnd(22)} ${String(pct).padStart(3)}%  ${bar}`;
      }),
      '',
      `strategy=${mode}  targets=${targets.length}  weights ${balanced ? 'ok' : '≠100'}`,
      balanced ? 'ok — safe to reload' : 'blocked — weights must sum to 100',
    ];
    setDryRun(lines);
  }

  return (
    <div>
      {/* actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {dirty ? <StatusChip tone="amber">unsaved changes</StatusChip> : null}
        <div className="flex-1" />
        <Button onClick={runDryRun}>Dry-run 1k reqs</Button>
        <Button
          variant="secondary"
          onClick={() =>
            setDryRun(['# route config', ...JSON.stringify(route.raw, null, 2).split('\n')])
          }
        >
          View config
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || !balanced}
          title="Apply via GitOps /config/apply"
        >
          Hot-reload
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="flex flex-col gap-4">
          {/* strategy */}
          <Panel>
            <PanelHeader title="Strategy" meta={`applies to alias/${route.alias}`} />
            <div className="grid grid-cols-2 gap-2 p-3">
              {STRATEGIES.map((s) => {
                const on = mode === s.mode || (mode === 'single' && s.mode === 'loadbalance');
                return (
                  <button
                    key={s.mode}
                    onClick={() => setMode(s.mode)}
                    className={`rounded-control border px-3 py-2.5 text-left transition-colors ${
                      on
                        ? 'border-accent bg-accent-tint text-accent-ink'
                        : 'border-line-control bg-panel hover:bg-rail'
                    }`}
                  >
                    <div className="text-[12px] font-medium text-ink">{s.title}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-secondary">{s.desc}</div>
                  </button>
                );
              })}
            </div>
          </Panel>

          {/* targets */}
          <Panel>
            <PanelHeader
              title="Targets"
              meta={targets.length ? `weights sum to ${sum}` : 'no targets'}
              right={
                balanced ? (
                  <StatusChip tone="green">balanced</StatusChip>
                ) : (
                  <StatusChip tone="amber">≠ 100</StatusChip>
                )
              }
            />
            {targets.length === 0 ? (
              <EmptyState message="This route has a single target (no weights to balance)." />
            ) : (
              <div>
                <GridRow cols="minmax(0,1fr) 1fr 52px" header>
                  <Cell>Target</Cell>
                  <Cell>Weight</Cell>
                  <Cell align="right">%</Cell>
                </GridRow>
                {targets.map((t, i) => (
                  <GridRow key={i} cols="minmax(0,1fr) 1fr 52px">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-ink">{t.name}</div>
                      {t.provider ? (
                        <div className="font-mono text-[9px] text-secondary">{t.provider}</div>
                      ) : null}
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={t.weight}
                      onChange={(e) => setWeight(i, Number(e.target.value))}
                      className="w-full accent-accent"
                    />
                    <Cell align="right" mono tone="secondary">
                      {sum ? Math.round((t.weight / sum) * 100) : 0}
                    </Cell>
                  </GridRow>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* right rail: dry-run terminal */}
        <Panel className="overflow-hidden">
          <PanelHeader title="Dry-run" meta="local projection" />
          <div className="bg-term-bg p-3 font-mono text-[10.5px] leading-[1.6] text-term-text">
            {dryRun ? (
              dryRun.map((l, i) => (
                <div key={i} className="whitespace-pre">
                  {l || ' '}
                </div>
              ))
            ) : (
              <div className="text-term-label">
                Run a dry-run to project the weighted distribution across targets. This is a local
                projection from the current weights; Hot-reload applies the change through GitOps
                config-apply and reports the applied version.
              </div>
            )}
          </div>
        </Panel>
      </div>

      <p className="mt-3 text-[10px] text-micro">
        Weight editing is local; applying a change goes through the audited config hot-reload path
        (M13). Wiring the in-console apply + the smart-routing classifier gate is a follow-up.
      </p>
    </div>
  );
}
