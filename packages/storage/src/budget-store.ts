import {
  type BudgetLike,
  type BudgetPeriod,
  type BudgetScopeKind,
  type BudgetSpec,
  isCalendar,
  parseBudgetConfig,
  parseBudgetScope,
  windowStart,
} from '@gulley/budget';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database } from './db';
import { budget, spendLedger } from './schema';

/**
 * Budget rows (K4 — hierarchical hard budgets).
 *
 * A `budget` row caps ONE entity of one kind: the workspace itself (`scope_kind =
 * 'workspace'`, the pre-0.7 row), the org (`workspace_id` NULL, `scope_kind = 'org'`),
 * or — within a workspace — a key, user, team or project (`scope_id` = the entity id,
 * or `'*'` for the DEFAULT that covers every entity of that kind without its own row,
 * Vercel-style). `windows` holds the multi-window spec (`[{capMicroUsd, period}]`);
 * a NULL `windows` means the legacy single cap in `cap_micro_usd` / `period_seconds`.
 */
export type BudgetRowScopeKind = Exclude<BudgetScopeKind, 'model' | 'attr'>;

export interface BudgetEntityConfig {
  scope?: { kind: BudgetRowScopeKind; id?: string };
  windows?: Array<{ capMicroUsd: number; period: unknown }>;
  capMicroUsd?: number;
  periodSeconds?: number;
}

export const BUDGET_ROW_SCOPE_KINDS: readonly BudgetRowScopeKind[] = [
  'workspace',
  'org',
  'key',
  'user',
  'team',
  'project',
];

/** Validate an entity `config` into the columns a budget row stores. A problem is a
 *  human-readable message (the control API returns it as a 400). */
export function budgetConfigToColumns(
  config: Record<string, unknown>,
  workspaceId: string,
):
  | {
      columns: {
        scopeKind: BudgetRowScopeKind;
        scopeId: string;
        capMicroUsd: number;
        periodSeconds: number | null;
        windows: BudgetSpec['windows'] | null;
      };
      problem?: undefined;
    }
  | { columns?: undefined; problem: string } {
  const parsed = parseBudgetConfig(config);
  if (parsed.spec === undefined) return { problem: parsed.problem };
  const spec = parsed.spec;
  const scopeRaw = config['scope'];
  let scopeKind: BudgetRowScopeKind = 'workspace';
  let scopeId: string = workspaceId;
  if (scopeRaw !== undefined && scopeRaw !== null) {
    if (typeof scopeRaw !== 'object') return { problem: 'scope must be an object { kind, id? }' };
    const s = scopeRaw as Record<string, unknown>;
    const kind = s['kind'];
    if (typeof kind !== 'string' || !BUDGET_ROW_SCOPE_KINDS.includes(kind as BudgetRowScopeKind)) {
      return { problem: `scope.kind must be one of ${BUDGET_ROW_SCOPE_KINDS.join(', ')}` };
    }
    scopeKind = kind as BudgetRowScopeKind;
    if (scopeKind === 'workspace') scopeId = workspaceId;
    else if (scopeKind === 'org')
      return { problem: 'an org budget is set on the org, not in a workspace document' };
    else {
      const id = s['id'];
      if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 256)) {
        return { problem: 'scope.id must be a non-empty string (or omitted for the default "*")' };
      }
      scopeId = typeof id === 'string' ? id : '*';
    }
  }
  const legacy = !Array.isArray(config['windows']);
  const first = spec.windows[0];
  return {
    columns: {
      scopeKind,
      scopeId,
      // Keep the legacy columns meaningful for one-window budgets (older readers).
      capMicroUsd: first?.capMicroUsd ?? 0,
      periodSeconds: legacy && first?.period.kind === 'fixed' ? first.period.seconds : null,
      windows: legacy ? null : spec.windows,
    },
  };
}

/** The entity `config` a row exports as (GitOps round-trip preserves the authored shape). */
export function budgetRowToConfig(r: {
  scopeKind: string;
  scopeId: string;
  workspaceId: string | null;
  capMicroUsd: number;
  periodSeconds: number | null;
  windows: unknown;
}): Record<string, unknown> {
  const scope =
    r.scopeKind === 'workspace'
      ? undefined
      : r.scopeKind === 'org'
        ? { kind: 'org' }
        : r.scopeId === '*'
          ? { kind: r.scopeKind }
          : { kind: r.scopeKind, id: r.scopeId };
  const base = scope ? { scope } : {};
  if (Array.isArray(r.windows)) return { ...base, windows: r.windows };
  return r.periodSeconds == null
    ? { ...base, capMicroUsd: r.capMicroUsd }
    : { ...base, capMicroUsd: r.capMicroUsd, periodSeconds: r.periodSeconds };
}

function rowToBudget(r: {
  capMicroUsd: number;
  periodSeconds: number | null;
  windows: unknown;
}): BudgetLike {
  if (Array.isArray(r.windows)) {
    const parsed = parseBudgetConfig({ windows: r.windows });
    if (parsed.spec) return parsed.spec;
  }
  return r.periodSeconds != null
    ? { capMicroUsd: r.capMicroUsd, periodSeconds: r.periodSeconds }
    : { capMicroUsd: r.capMicroUsd };
}

const ROW_COLS = {
  capMicroUsd: budget.capMicroUsd,
  periodSeconds: budget.periodSeconds,
  windows: budget.windows,
};

/** Reads budget caps for any scope string the RedisBudgetStore resolves: a bare
 *  workspace id, `org:<id>`, `key:<ws>:<id>`, `user:<ws>:<id>`, `team:<ws>:<g>`,
 *  `project:<ws>:<id>`. A per-entity row wins over the kind's DEFAULT (`'*'`) row.
 *  `model:` / `attr:` scopes are config-resolved and return null here. */
export function createBudgetCapResolver(
  db: Database,
): (scope: string) => Promise<BudgetLike | null> {
  return async (scope) => {
    const s = parseBudgetScope(scope);
    if (s.kind === 'model' || s.kind === 'attr') return null;
    if (s.kind === 'workspace') {
      const rows = await db
        .select(ROW_COLS)
        .from(budget)
        .where(and(eq(budget.workspaceId, s.entity), eq(budget.scopeKind, 'workspace')))
        .limit(1);
      return rows[0] ? rowToBudget(rows[0]) : null;
    }
    if (s.kind === 'org') {
      const rows = await db
        .select(ROW_COLS)
        .from(budget)
        .where(
          and(
            isNull(budget.workspaceId),
            eq(budget.scopeKind, 'org'),
            eq(budget.scopeId, s.entity),
          ),
        )
        .limit(1);
      return rows[0] ? rowToBudget(rows[0]) : null;
    }
    if (!s.workspaceId) return null;
    const rows = await db
      .select({ ...ROW_COLS, scopeId: budget.scopeId })
      .from(budget)
      .where(
        and(
          eq(budget.workspaceId, s.workspaceId),
          eq(budget.scopeKind, s.kind),
          sql`${budget.scopeId} in (${s.entity}, '*')`,
        ),
      )
      .limit(2);
    const own = rows.find((r) => r.scopeId === s.entity) ?? rows.find((r) => r.scopeId === '*');
    return own ? rowToBudget(own) : null;
  };
}

export interface BudgetHealDatum {
  scope: string;
  period: BudgetPeriod;
  ledgerMicroUsd: number;
}

/** For the boot-time self-heal: every budget row with a resettable window, with the
 *  ledger sum over the ACTIVE window of the scope it caps. Lifetime caps are skipped
 *  (their counter never rolls, so a full-ledger heal is out of scope); so are team
 *  budgets (the ledger does not record a request's groups) and `'*'` defaults (one
 *  default covers many entities; their counters heal from their own rows only). */
export async function loadBudgetHealData(
  db: Database,
  nowMs: number = Date.now(),
): Promise<BudgetHealDatum[]> {
  const rows = await db
    .select({
      workspaceId: budget.workspaceId,
      scopeKind: budget.scopeKind,
      scopeId: budget.scopeId,
      ...ROW_COLS,
    })
    .from(budget);
  const out: BudgetHealDatum[] = [];
  for (const r of rows) {
    const kind = r.scopeKind as BudgetRowScopeKind;
    if (kind === 'team' || r.scopeId === '*') continue;
    const spec = rowToBudget(r);
    const windows = 'windows' in spec ? spec.windows : [];
    const legacy =
      !('windows' in spec) && r.periodSeconds != null
        ? [
            {
              capMicroUsd: r.capMicroUsd,
              period: { kind: 'fixed' as const, seconds: r.periodSeconds },
            },
          ]
        : [];
    for (const w of [...windows, ...legacy]) {
      if (w.period.kind === 'none') continue;
      const since = isCalendar(w.period)
        ? new Date(windowStart(w.period, nowMs))
        : new Date(nowMs - (w.period.kind === 'fixed' ? w.period.seconds : 0) * 1000);
      const scopeFilter =
        kind === 'workspace' && r.workspaceId
          ? eq(spendLedger.workspaceId, r.workspaceId)
          : kind === 'org'
            ? eq(spendLedger.orgId, r.scopeId)
            : kind === 'key' && r.workspaceId
              ? and(
                  eq(spendLedger.workspaceId, r.workspaceId),
                  eq(spendLedger.principalId, r.scopeId),
                )
              : kind === 'user' && r.workspaceId
                ? and(
                    eq(spendLedger.workspaceId, r.workspaceId),
                    sql`${spendLedger.attributes} ->> 'user' = ${r.scopeId}`,
                  )
                : kind === 'project' && r.workspaceId
                  ? and(
                      eq(spendLedger.workspaceId, r.workspaceId),
                      sql`${spendLedger.attributes} ->> 'project' = ${r.scopeId}`,
                    )
                  : undefined;
      if (!scopeFilter) continue;
      const sum = await db
        .select({ sum: sql<string>`coalesce(sum(${spendLedger.costMicroUsd}), 0)` })
        .from(spendLedger)
        .where(and(scopeFilter, gte(spendLedger.createdAt, since)));
      const scope =
        kind === 'workspace'
          ? (r.workspaceId as string)
          : kind === 'org'
            ? `org:${r.scopeId}`
            : `${kind}:${r.workspaceId}:${r.scopeId}`;
      out.push({ scope, period: w.period, ledgerMicroUsd: Number(sum[0]?.sum ?? 0) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- org budgets

/** Validate an ORG budget config (`PUT /orgs/:id/budget`): the budget shape, with an
 *  optional `scope` that may only be `{ kind: 'org' }`. */
export function orgBudgetProblem(config: Record<string, unknown>): string | undefined {
  const scopeRaw = config['scope'];
  if (scopeRaw !== undefined && scopeRaw !== null) {
    const kind =
      typeof scopeRaw === 'object' ? (scopeRaw as Record<string, unknown>)['kind'] : undefined;
    if (kind !== 'org') return 'an org budget has scope { kind: "org" } (or no scope)';
  }
  return parseBudgetConfig(config).problem;
}

export interface OrgBudget {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

/** The org's budget row (`workspace_id` NULL), if any. */
export async function getOrgBudget(db: Database, orgId: string): Promise<OrgBudget | null> {
  const rows = await db
    .select()
    .from(budget)
    .where(and(isNull(budget.workspaceId), eq(budget.scopeKind, 'org'), eq(budget.scopeId, orgId)))
    .limit(1);
  const r = rows[0];
  return r ? { id: r.id, name: r.name, config: budgetRowToConfig(r) } : null;
}

/** Create or replace the org's budget. The caller validates with {@link orgBudgetProblem}
 *  first; an invalid config throws. Org budgets live outside the per-workspace GitOps
 *  document (they cap every workspace of the org together). */
export async function upsertOrgBudget(
  db: Database,
  orgId: string,
  name: string,
  config: Record<string, unknown>,
): Promise<OrgBudget> {
  const problem = orgBudgetProblem(config);
  if (problem) throw new Error(`org budget: ${problem}`);
  const parsed = parseBudgetConfig(config);
  if (parsed.spec === undefined) throw new Error(`org budget: ${parsed.problem}`);
  const legacy = !Array.isArray(config['windows']);
  const first = parsed.spec.windows[0];
  const cols = {
    capMicroUsd: first?.capMicroUsd ?? 0,
    periodSeconds: legacy && first?.period.kind === 'fixed' ? first.period.seconds : null,
    windows: legacy ? null : parsed.spec.windows,
  };
  const rows = await db
    .insert(budget)
    .values({ workspaceId: null, name, scopeKind: 'org', scopeId: orgId, ...cols })
    .onConflictDoUpdate({
      target: [budget.scopeKind, budget.scopeId],
      targetWhere: sql`${budget.workspaceId} is null`,
      set: { name, ...cols },
    })
    .returning();
  const r = rows[0];
  if (!r) throw new Error('org budget upsert returned no row');
  return { id: r.id, name: r.name, config: budgetRowToConfig(r) };
}

export async function deleteOrgBudget(db: Database, orgId: string): Promise<boolean> {
  const rows = await db
    .delete(budget)
    .where(and(isNull(budget.workspaceId), eq(budget.scopeKind, 'org'), eq(budget.scopeId, orgId)))
    .returning({ id: budget.id });
  return rows.length > 0;
}
