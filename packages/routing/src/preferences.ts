import type { RouteTarget } from './types';

/**
 * Request-level routing preferences (P7): an OpenRouter-compatible `provider` object
 * and Vercel's `providerOptions.gateway`, carried in the request body.
 *
 * They can only NARROW or RE-ORDER what the operator's route and the deployment's
 * policies already allow: scope, the central model policy, residency and the circuit
 * breaker have all been applied before preferences run. A request can tighten ZDR
 * (`zdr: true`) but never relax it. The fields are stripped from the body before it
 * is forwarded (no upstream accepts them) and before the cache key is computed.
 */
export type RoutingSort = 'price' | 'latency' | 'throughput';

export interface RoutingPreferences {
  /** Providers (or target names) to try first, in this order. */
  order?: string[];
  /** Restrict to these providers / target names. */
  only?: string[];
  /** Skip these providers / target names. */
  ignore?: string[];
  /** With `order`: false ⇒ only the listed providers are tried (default true). */
  allowFallbacks?: boolean;
  /** Rank the remaining candidates by price, time-to-first-byte or throughput. */
  sort?: RoutingSort;
  /** Only zero-data-retention targets (can only tighten the deployment policy). */
  zdr?: boolean;
  /** Hard price ceilings in USD per million tokens. */
  maxPrice?: { prompt?: number; completion?: number };
}

export interface ExtractedPreferences {
  prefs: RoutingPreferences | undefined;
  /** True when a preference field was present and removed from the body. */
  stripped: boolean;
}

const asStringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean)
    : undefined;

const SORTS: Record<string, RoutingSort> = {
  price: 'price',
  cost: 'price',
  latency: 'latency',
  ttft: 'latency',
  throughput: 'throughput',
  tps: 'throughput',
};

function asSort(v: unknown): RoutingSort | undefined {
  if (typeof v === 'string') return SORTS[v.toLowerCase()];
  if (v && typeof v === 'object' && typeof (v as { by?: unknown }).by === 'string') {
    return SORTS[(v as { by: string }).by.toLowerCase()];
  }
  return undefined;
}

const asPrice = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Read and REMOVE `provider` / `providerOptions` from a parsed body. Unknown or
 *  malformed sub-fields are ignored (never an error: a preference is advisory). */
export function extractRoutingPreferences(body: Record<string, unknown>): ExtractedPreferences {
  const merged: RoutingPreferences = {};
  let stripped = false;
  let any = false;

  const take = (src: Record<string, unknown>, vercel: boolean): void => {
    const order = asStringList(src['order']);
    const only = asStringList(src['only']);
    const ignore = asStringList(src['ignore']);
    if (order) ((merged.order = order), (any = true));
    if (only) ((merged.only = only), (any = true));
    if (ignore) ((merged.ignore = ignore), (any = true));
    if (typeof src['allow_fallbacks'] === 'boolean') {
      merged.allowFallbacks = src['allow_fallbacks'];
      any = true;
    }
    const sort = asSort(src['sort']);
    if (sort) ((merged.sort = sort), (any = true));
    if (!vercel) {
      if (src['zdr'] === true) ((merged.zdr = true), (any = true));
      const mp = src['max_price'];
      if (mp && typeof mp === 'object') {
        const prompt = asPrice((mp as Record<string, unknown>)['prompt']);
        const completion = asPrice((mp as Record<string, unknown>)['completion']);
        if (prompt !== undefined || completion !== undefined) {
          merged.maxPrice = {
            ...(prompt !== undefined ? { prompt } : {}),
            ...(completion !== undefined ? { completion } : {}),
          };
          any = true;
        }
      }
    }
  };

  const provider = body['provider'];
  if (provider !== undefined) {
    if (provider && typeof provider === 'object' && !Array.isArray(provider)) {
      take(provider as Record<string, unknown>, false);
    }
    delete body['provider'];
    stripped = true;
  }
  const po = body['providerOptions'];
  if (po !== undefined) {
    const gw =
      po && typeof po === 'object' ? (po as Record<string, unknown>)['gateway'] : undefined;
    if (gw && typeof gw === 'object' && !Array.isArray(gw))
      take(gw as Record<string, unknown>, true);
    delete body['providerOptions'];
    stripped = true;
  }
  return { prefs: any ? merged : undefined, stripped };
}

export interface PreferenceContext {
  /** Per-MTok input/output rate of the requested model on this target, if priced. */
  rateOf?: (t: RouteTarget) => { input: number; output: number } | undefined;
  /** Time-to-first-byte EWMA in ms; 0 = not yet sampled (ranked first: exploration). */
  latencyOf?: (t: RouteTarget) => number;
}

export interface PreferenceOutcome {
  candidates: RouteTarget[];
  /** Why the result is empty, when it is. */
  reason?: string;
}

const matches = (t: RouteTarget, names: readonly string[]): boolean =>
  names.includes(t.provider.toLowerCase()) || names.includes(t.name.toLowerCase());

function stableSort(ts: RouteTarget[], key: (t: RouteTarget) => number): RouteTarget[] {
  return ts
    .map((t, i) => ({ t, i, k: key(t) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.t);
}

/** Apply preferences to an already-eligible, already-ordered candidate list. */
export function applyRoutingPreferences(
  candidates: readonly RouteTarget[],
  prefs: RoutingPreferences,
  ctx: PreferenceContext = {},
): PreferenceOutcome {
  let pool = [...candidates];
  if (prefs.only && prefs.only.length > 0) pool = pool.filter((t) => matches(t, prefs.only!));
  if (prefs.ignore && prefs.ignore.length > 0)
    pool = pool.filter((t) => !matches(t, prefs.ignore!));
  if (prefs.zdr) pool = pool.filter((t) => t.zdr === true);
  if (prefs.maxPrice && ctx.rateOf) {
    const { prompt, completion } = prefs.maxPrice;
    pool = pool.filter((t) => {
      const r = ctx.rateOf!(t);
      if (!r) return false; // an unpriced target cannot be shown to be within the ceiling
      if (prompt !== undefined && r.input > prompt) return false;
      if (completion !== undefined && r.output > completion) return false;
      return true;
    });
  }
  if (pool.length === 0) {
    return { candidates: [], reason: describeUnsatisfied(prefs, candidates) };
  }

  let rest = pool;
  const head: RouteTarget[] = [];
  if (prefs.order && prefs.order.length > 0) {
    for (const name of prefs.order) {
      for (const t of rest) {
        if (
          !head.includes(t) &&
          (t.provider.toLowerCase() === name || t.name.toLowerCase() === name)
        ) {
          head.push(t);
        }
      }
    }
    rest = rest.filter((t) => !head.includes(t));
    if (prefs.allowFallbacks === false) {
      if (head.length === 0)
        return { candidates: [], reason: describeUnsatisfied(prefs, candidates) };
      rest = [];
    }
  }
  if (prefs.sort) {
    if (prefs.sort === 'price' && ctx.rateOf) {
      const rate = ctx.rateOf;
      rest = stableSort(rest, (t) => {
        const r = rate(t);
        return r ? r.input + r.output : Number.POSITIVE_INFINITY;
      });
    } else if (ctx.latencyOf) {
      // 'latency' — and 'throughput', which is not sampled yet, degrades to it.
      const lat = ctx.latencyOf;
      rest = stableSort(rest, (t) => lat(t));
    }
  }
  return { candidates: [...head, ...rest] };
}

function describeUnsatisfied(
  prefs: RoutingPreferences,
  candidates: readonly RouteTarget[],
): string {
  const available = [...new Set(candidates.map((t) => t.provider))].sort().join(', ') || 'none';
  const asked = [
    prefs.only && prefs.only.length > 0 ? `only=[${prefs.only.join(', ')}]` : undefined,
    prefs.ignore && prefs.ignore.length > 0 ? `ignore=[${prefs.ignore.join(', ')}]` : undefined,
    prefs.order && prefs.allowFallbacks === false
      ? `order=[${prefs.order.join(', ')}] without fallbacks`
      : undefined,
    prefs.zdr ? 'zdr' : undefined,
    prefs.maxPrice ? 'max_price' : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  return `no provider satisfies the routing preferences (${asked}); available: ${available}`;
}
