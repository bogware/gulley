import type { IncomingHttpHeaders } from 'node:http';
import { type Principal, scopeGroups } from '@gulley/auth';
import {
  type BudgetDecision,
  type BudgetScopeKind,
  budgetScope,
  parseBudgetScope,
  periodLabel,
} from '@gulley/budget';

/**
 * Hierarchical hard budgets (K4): which scopes a request must be admitted by.
 *
 * The workspace cap is always checked. `BUDGET_SCOPES` selects the rest of the
 * hierarchy — org, key (the credential), user, team (the principal's groups) and
 * project (the `project` attribution) — each resolved to a `budget` row (its own, or
 * the kind's `'*'` default) by the storage cap resolver. Per-model and
 * per-attribution caps are separate knobs and are reserved after the hierarchy.
 */
export const DEFAULT_BUDGET_SCOPE_KINDS: ReadonlySet<BudgetScopeKind> = new Set<BudgetScopeKind>([
  'org',
  'key',
  'user',
  'team',
  'project',
]);
const SELECTABLE_KINDS: readonly string[] = ['org', 'key', 'user', 'team', 'project'];

/** The most `team:` scopes one request reserves (a principal with many groups). */
export const MAX_TEAM_BUDGET_SCOPES = 16;

/** Parse `BUDGET_SCOPES` (comma-separated kinds). `workspace` is always on and is
 *  accepted silently; unknown tokens are returned so the caller can warn. */
export function parseBudgetScopeKinds(raw: string | undefined): {
  kinds: Set<BudgetScopeKind>;
  unknown: string[];
} {
  if (raw === undefined) return { kinds: new Set(DEFAULT_BUDGET_SCOPE_KINDS), unknown: [] };
  const kinds = new Set<BudgetScopeKind>();
  const unknown: string[] = [];
  for (const tok of raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)) {
    if (tok === 'workspace') continue;
    if (SELECTABLE_KINDS.includes(tok)) kinds.add(tok as BudgetScopeKind);
    else unknown.push(tok);
  }
  return { kinds, unknown };
}

const USER_ID_MAX_LEN = 128;
const USER_ID_UNSAFE_RE = /[{}\p{Cc}\s]/u;

/** The end user a request is for: the `x-user-id` a federated service principal
 *  asserts when its federation permits on-behalf-of (K7) — the header is ignored for
 *  every other principal — else the user the credential IS (a brokered user grant, an
 *  IdP JWT). Undefined for an unbound credential such as a virtual key. */
export function endUserIdFor(
  principal: Principal,
  headers: IncomingHttpHeaders,
): string | undefined {
  if (principal.onBehalfOf) {
    const raw = headers['x-user-id'];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (
      typeof v === 'string' &&
      v.length > 0 &&
      v.length <= USER_ID_MAX_LEN &&
      !USER_ID_UNSAFE_RE.test(v)
    ) {
      return v;
    }
  }
  return principal.userId;
}

/** Every hierarchy scope this request must be admitted by, in enforcement order:
 *  workspace → org → key → user → team(s) → project. Deterministic, so the scope
 *  named by a rejection is stable for the same principal and request. */
export function hierarchyBudgetScopes(input: {
  principal: Principal;
  endUserId?: string;
  attribution?: Record<string, string>;
  kinds: ReadonlySet<BudgetScopeKind>;
}): string[] {
  const { principal, kinds } = input;
  const ws = principal.scope.workspaceId;
  const out: string[] = [ws];
  if (kinds.has('org') && principal.scope.orgId) {
    out.push(budgetScope({ kind: 'org', entity: principal.scope.orgId }));
  }
  if (kinds.has('key'))
    out.push(budgetScope({ kind: 'key', workspaceId: ws, entity: principal.id }));
  if (kinds.has('user') && input.endUserId) {
    out.push(budgetScope({ kind: 'user', workspaceId: ws, entity: input.endUserId }));
  }
  if (kinds.has('team')) {
    const seen = new Set<string>();
    for (const g of scopeGroups(principal.scope)) {
      if (!g || seen.has(g)) continue;
      seen.add(g);
      if (seen.size > MAX_TEAM_BUDGET_SCOPES) break;
      out.push(budgetScope({ kind: 'team', workspaceId: ws, entity: g }));
    }
  }
  const project = input.attribution?.['project'];
  if (kinds.has('project') && project) {
    out.push(budgetScope({ kind: 'project', workspaceId: ws, entity: project }));
  }
  return out;
}

export interface BudgetScopeDescription {
  kind: BudgetScopeKind;
  id: string;
  workspaceId?: string;
  /** "Workspace", "Organization", "Key vk_…", "User alice", "Team ml", … */
  label: string;
}

export function describeBudgetScope(scope: string): BudgetScopeDescription {
  const s = parseBudgetScope(scope);
  const label =
    s.kind === 'workspace'
      ? 'Workspace'
      : s.kind === 'org'
        ? 'Organization'
        : s.kind === 'key'
          ? `Key ${s.entity}`
          : s.kind === 'user'
            ? `User ${s.entity}`
            : s.kind === 'team'
              ? `Team ${s.entity}`
              : s.kind === 'project'
                ? `Project ${s.entity}`
                : s.kind === 'model'
                  ? `Model ${s.entity}`
                  : `Attribution ${s.entity}`;
  const workspaceId = s.kind === 'workspace' ? s.entity : s.workspaceId;
  return { kind: s.kind, id: s.entity, ...(workspaceId ? { workspaceId } : {}), label };
}

function usd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(micro > 0 && micro < 10_000 ? 4 : 2)}`;
}

export interface BudgetExceededResponse {
  status: 402;
  headers: Record<string, string>;
  body: {
    type: 'error';
    error: {
      type: 'quota_for_entity_exceeded';
      message: string;
      scope: { kind: BudgetScopeKind; id: string; workspace_id?: string };
      window: { period: string; resets_at?: string };
      cap_micro_usd: number;
      used_micro_usd: number;
      worst_case_micro_usd: number;
    };
  };
}

/** The typed 402 for a budget rejection: names the entity and the binding window,
 *  states current spend / limit / what this request needed, and — for a calendar
 *  window — when it resets (`retry-after` in seconds). `x-should-retry: false` tells
 *  SDKs that an immediate retry cannot succeed. */
export function budgetExceededResponse(
  scope: string,
  decision: BudgetDecision,
  worstCaseMicroUsd: number,
  nowMs: number = Date.now(),
): BudgetExceededResponse {
  const d = describeBudgetScope(scope);
  const period = decision.window ? periodLabel(decision.window.period) : 'lifetime';
  const resetsAtMs = decision.window?.resetsAtMs;
  const retryAfter =
    resetsAtMs !== undefined ? Math.max(1, Math.ceil((resetsAtMs - nowMs) / 1000)) : undefined;
  const resetsAt = resetsAtMs !== undefined ? new Date(resetsAtMs).toISOString() : undefined;
  const message =
    `${d.label} budget exceeded. Current spend: ${usd(decision.usedMicroUsd)}, ` +
    `limit: ${usd(decision.capMicroUsd)} (${period}); this request needs up to ` +
    `${usd(worstCaseMicroUsd)}.` +
    (resetsAt ? ` Resets at ${resetsAt}.` : '');
  return {
    status: 402,
    headers: {
      'x-should-retry': 'false',
      ...(retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
    },
    body: {
      type: 'error',
      error: {
        type: 'quota_for_entity_exceeded',
        message,
        scope: {
          kind: d.kind,
          id: d.id,
          ...(d.workspaceId ? { workspace_id: d.workspaceId } : {}),
        },
        window: { period, ...(resetsAt ? { resets_at: resetsAt } : {}) },
        cap_micro_usd: decision.capMicroUsd,
        used_micro_usd: decision.usedMicroUsd,
        worst_case_micro_usd: worstCaseMicroUsd,
      },
    },
  };
}
