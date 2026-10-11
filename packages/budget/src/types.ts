import { type BudgetPeriod, parsePeriod } from './window';

/** The pre-0.7 budget shape: one cap, optionally over a FIXED window of
 *  `periodSeconds` that starts at the first spend (never calendar-aligned). Still
 *  accepted everywhere; normalised to a one-window {@link BudgetSpec}. */
export interface Budget {
  capMicroUsd: number;
  /** Fixed-window length in seconds (starts at the first spend); omit for a lifetime cap. */
  periodSeconds?: number;
}

/** One cap over one window. */
export interface BudgetWindow {
  capMicroUsd: number;
  period: BudgetPeriod;
}

/** A budget: one or more caps that must ALL admit (e.g. $10 per day AND $100 per
 *  month). At most one of the windows may be `none`/`fixed` (they share a counter). */
export interface BudgetSpec {
  windows: BudgetWindow[];
}

export type BudgetLike = Budget | BudgetSpec;

export function isBudgetSpec(b: BudgetLike): b is BudgetSpec {
  return Array.isArray((b as BudgetSpec).windows);
}

/** Normalise either shape to windows (legacy → one fixed/lifetime window). */
export function normalizeBudget(b: BudgetLike): BudgetSpec {
  if (isBudgetSpec(b)) return b;
  return {
    windows: [
      {
        capMicroUsd: b.capMicroUsd,
        period:
          b.periodSeconds && b.periodSeconds > 0
            ? { kind: 'fixed', seconds: b.periodSeconds }
            : { kind: 'none' },
      },
    ],
  };
}

/** Parse an untrusted budget config object (a DB entity's `config`, an env knob):
 *  `{ capMicroUsd, periodSeconds? }` or `{ windows: [{ capMicroUsd, period }] }`
 *  (period: none | daily | weekly | monthly | { seconds } | "30d" …). Returns a
 *  human-readable problem instead of a spec when invalid. */
export function parseBudgetConfig(
  v: unknown,
): { spec: BudgetSpec; problem?: undefined } | { spec?: undefined; problem: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return { problem: 'budget must be an object' };
  const o = v as Record<string, unknown>;
  const positive = (x: unknown): x is number =>
    typeof x === 'number' && Number.isFinite(x) && x > 0 && Number.isInteger(x);
  if (Array.isArray(o['windows'])) {
    if (o['windows'].length === 0) return { problem: 'windows must list at least one cap' };
    const windows: BudgetWindow[] = [];
    let counterWindows = 0;
    for (const [i, w] of (o['windows'] as unknown[]).entries()) {
      if (!w || typeof w !== 'object') return { problem: `windows[${i}] must be an object` };
      const ww = w as Record<string, unknown>;
      if (!positive(ww['capMicroUsd'])) {
        return { problem: `windows[${i}].capMicroUsd must be a positive integer (micro-USD)` };
      }
      const period = parsePeriod(ww['period'] ?? ww['periodSeconds'] ?? 'none');
      if (!period) {
        return {
          problem: `windows[${i}].period must be none | daily | weekly | monthly | { seconds } | "<n>d"`,
        };
      }
      if (period.kind === 'none' || period.kind === 'fixed') counterWindows += 1;
      windows.push({ capMicroUsd: ww['capMicroUsd'], period });
    }
    if (counterWindows > 1) {
      return { problem: 'at most one lifetime or fixed-seconds window per budget' };
    }
    return { spec: { windows } };
  }
  if (!positive(o['capMicroUsd'])) {
    return { problem: 'capMicroUsd must be a positive integer (micro-USD)' };
  }
  const ps = o['periodSeconds'];
  if (ps !== undefined && ps !== null && !positive(ps)) {
    return { problem: 'periodSeconds must be a positive integer' };
  }
  return {
    spec: normalizeBudget({
      capMicroUsd: o['capMicroUsd'],
      ...(positive(ps) ? { periodSeconds: ps } : {}),
    }),
  };
}

export interface BudgetDecision {
  allowed: boolean;
  /** The BINDING window's cap: on a rejection the window that rejected, otherwise
   *  the window with the highest utilization after this call. */
  capMicroUsd: number;
  /** reserved + committed in the binding window after this call. */
  usedMicroUsd: number;
  /** The binding window, when the budget has windows (always, for a spec). */
  window?: {
    period: BudgetPeriod;
    /** Epoch ms at which a calendar window resets; absent for lifetime/fixed. */
    resetsAtMs?: number;
  };
}

/**
 * Hard budget enforcement via reserve/commit. At admission the worst-case cost
 * is RESERVED (rejecting if it would breach any window's cap — TOCTOU-safe under
 * concurrency); at completion the reservation is replaced by the ACTUAL spend,
 * refunding the difference. The Postgres ledger is the durable source of truth;
 * these counters are a rebuildable projection. A `scope` is any budget scope string
 * (see {@link parseBudgetScope}): a workspace id, `org:<id>`, `key:<ws>:<id>`,
 * `user:<ws>:<id>`, `team:<ws>:<group>`, `project:<ws>:<id>`, `model:<m>`,
 * `attr:<k>:<v>`.
 */
export interface BudgetStore {
  /** Returns null when the scope has no budget (no enforcement). Otherwise a
   *  decision; when `allowed` is false, nothing was reserved. */
  reserve(
    scope: string,
    requestId: string,
    worstCaseMicroUsd: number,
  ): Promise<BudgetDecision | null>;
  commit(scope: string, requestId: string, actualMicroUsd: number): Promise<void>;
  /** Optional: re-stamp a live reservation's expiry so a long-running stream is not
   *  reaped by the orphan-sweep (which reclaims reservations older than the max
   *  lifetime so a crashed request can't strand its worst-case forever). Called
   *  throttled while a stream is in flight. Backends without an expiry-based sweep
   *  (in-memory) may omit this. */
  refresh?(scope: string, requestId: string): Promise<void>;
  /** Optional: rebuild a LOST committed counter from the durable ledger. The counters
   *  are "a rebuildable projection" of the ledger, but a counters-Redis flush resets
   *  committed to 0 and over-admits until the window rolls. Given the ledger sum over
   *  the active window, this rebuilds the counter ONLY when it is absent (flush
   *  recovery) — a live counter is authoritative for its window and is never
   *  overwritten. `period` selects the window counter (legacy callers pass seconds). */
  healCommitted?(
    scope: string,
    ledgerMicroUsd: number,
    period: number | BudgetPeriod,
  ): Promise<{ healed: boolean; committedMicroUsd: number }>;
}

export type CapResolver = (scope: string) => Promise<BudgetLike | null>;

// ---------------------------------------------------------------- scopes

export type BudgetScopeKind =
  'workspace' | 'org' | 'key' | 'user' | 'team' | 'project' | 'model' | 'attr';

export interface BudgetScope {
  kind: BudgetScopeKind;
  /** The entity the cap applies to (a workspace id, key id, user id, group, …). */
  entity: string;
  /** The workspace the scope belongs to, when the kind is workspace-partitioned. */
  workspaceId?: string;
}

/** Build a scope string. Workspace-partitioned kinds carry the workspace so a per-key
 *  / per-user cap and its DEFAULT (`scope_id = '*'`) resolve within one workspace. */
export function budgetScope(s: BudgetScope): string {
  switch (s.kind) {
    case 'workspace':
      return s.entity;
    case 'org':
      return `org:${s.entity}`;
    case 'model':
      return `model:${s.entity}`;
    case 'attr':
      return `attr:${s.entity}`;
    default:
      return `${s.kind}:${s.workspaceId ?? ''}:${s.entity}`;
  }
}

/** Parse a scope string back to its parts (a bare id is a workspace). */
export function parseBudgetScope(scope: string): BudgetScope {
  const sep = scope.indexOf(':');
  if (sep < 0) return { kind: 'workspace', entity: scope };
  const kind = scope.slice(0, sep);
  const rest = scope.slice(sep + 1);
  switch (kind) {
    case 'org':
      return { kind, entity: rest };
    case 'model':
      return { kind, entity: rest };
    case 'attr':
      return { kind, entity: rest };
    case 'key':
    case 'user':
    case 'team':
    case 'project': {
      const sep2 = rest.indexOf(':');
      if (sep2 < 0) return { kind, entity: rest };
      return { kind, workspaceId: rest.slice(0, sep2), entity: rest.slice(sep2 + 1) };
    }
    default:
      return { kind: 'workspace', entity: scope };
  }
}

/** The hierarchy kinds a request is checked against, in order. */
export const HIERARCHY_SCOPE_KINDS: readonly BudgetScopeKind[] = [
  'workspace',
  'org',
  'key',
  'user',
  'team',
  'project',
];
