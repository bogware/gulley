/**
 * Console <-> route-group helpers for the Route groups page. A `routes` entity's
 * `config` IS a route group — the shape the gateway applies (`routeGroupSchema` in
 * `@gulley/routing`): `clientPath`, `mode`, `providers` (>=2, in preference order),
 * and the optional `select` / `weights` / `onStatusCodes` / `hedgeDelayMs` /
 * `modelMap`. The control-api validates every write against that schema (a 400
 * naming the field); these helpers keep the form honest before the round trip and
 * are pure so they can be unit-tested.
 */
export type RouteGroupMode = 'fallback' | 'loadbalance';
export type RouteGroupSelect = 'least-load' | 'cheapest' | 'fastest';

export const ROUTE_GROUP_MODES: ReadonlyArray<{ value: RouteGroupMode; label: string }> = [
  { value: 'fallback', label: 'fallback — try providers in order' },
  { value: 'loadbalance', label: 'loadbalance — weighted pick' },
];
export const ROUTE_GROUP_SELECTS: readonly RouteGroupSelect[] = [
  'least-load',
  'cheapest',
  'fastest',
];

/** The client-path families the built-in providers serve (free text is still allowed:
 *  a group matches a path equal to, or ending with, its clientPath). */
export const COMMON_CLIENT_PATHS = [
  '/v1/messages',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/embeddings',
] as const;

export interface RouteGroupForm {
  name: string;
  clientPath: string;
  mode: RouteGroupMode;
  /** Comma-separated provider names, in preference order. */
  providers: string;
  select: '' | RouteGroupSelect;
  /** JSON object `{ provider: weight }`, or blank. */
  weights: string;
  /** Comma-separated upstream status codes, or blank. */
  onStatusCodes: string;
  /** Integer ms, or blank (the global HEDGE_DELAY_MS applies). */
  hedgeDelayMs: string;
  /** JSON object `{ provider: { clientModel: upstreamModel } }`, or blank. */
  modelMap: string;
}

export const EMPTY_ROUTE_GROUP_FORM: RouteGroupForm = {
  name: '',
  clientPath: '',
  mode: 'fallback',
  providers: '',
  select: '',
  weights: '',
  onStatusCodes: '',
  hedgeDelayMs: '',
  modelMap: '',
};

/** Legacy = the pre-route-group console shape (`{ strategy | mode, targets[] }`,
 *  no clientPath). The gateway never read it; the page lists it for conversion. */
export function isLegacyRouteConfig(cfg: Record<string, unknown>): boolean {
  return cfg['clientPath'] === undefined;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Prefill the form from an entity. A legacy entity yields its name and (when
 *  recognisable) its mode — the rest is left for the operator to fill in. */
export function formFromEntity(name: string, cfg: Record<string, unknown>): RouteGroupForm {
  const strategy = cfg['strategy'];
  const nestedMode = isObj(strategy) ? strategy['mode'] : strategy;
  const mode: RouteGroupMode =
    (cfg['mode'] ?? nestedMode) === 'loadbalance' ? 'loadbalance' : 'fallback';
  const select = str(cfg['select']) as RouteGroupSelect;
  return {
    name,
    clientPath: str(cfg['clientPath']),
    mode,
    providers: Array.isArray(cfg['providers'])
      ? (cfg['providers'] as unknown[]).map(String).join(', ')
      : '',
    select: ROUTE_GROUP_SELECTS.includes(select) ? select : '',
    weights: isObj(cfg['weights']) ? JSON.stringify(cfg['weights']) : '',
    onStatusCodes: Array.isArray(cfg['onStatusCodes'])
      ? (cfg['onStatusCodes'] as unknown[]).join(', ')
      : '',
    hedgeDelayMs: typeof cfg['hedgeDelayMs'] === 'number' ? String(cfg['hedgeDelayMs']) : '',
    modelMap: isObj(cfg['modelMap']) ? JSON.stringify(cfg['modelMap'], null, 2) : '',
  };
}

export type BuiltRouteGroup =
  { ok: true; config: Record<string, unknown> } | { ok: false; error: string };

function parseJsonObject(
  label: string,
  text: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${label} must be a JSON object.` };
  }
  if (!isObj(parsed)) return { ok: false, error: `${label} must be a JSON object.` };
  return { ok: true, value: parsed };
}

/** The entity `config` for the form — the route-group shape, or the first problem
 *  in the operator's words (the server re-validates against the real schema). */
export function configFromForm(form: RouteGroupForm): BuiltRouteGroup {
  const clientPath = form.clientPath.trim();
  if (!clientPath) return { ok: false, error: 'Client path is required (e.g. /v1/messages).' };
  const providers = list(form.providers);
  if (providers.length < 2) {
    return {
      ok: false,
      error: 'A route group needs at least two providers (comma-separated, in preference order).',
    };
  }
  const config: Record<string, unknown> = { clientPath, mode: form.mode, providers };
  if (form.select) config['select'] = form.select;

  const weights = parseJsonObject('Weights', form.weights);
  if (!weights.ok) return weights;
  if (weights.value) {
    for (const [k, v] of Object.entries(weights.value)) {
      if (typeof v !== 'number' || !(v > 0))
        return { ok: false, error: `Weights: "${k}" must be a positive number.` };
    }
    config['weights'] = weights.value;
  }

  if (form.onStatusCodes.trim()) {
    const codes = list(form.onStatusCodes).map(Number);
    if (codes.some((c) => !Number.isInteger(c)))
      return { ok: false, error: 'Failover status codes must be integers (e.g. 429, 503).' };
    config['onStatusCodes'] = codes;
  }

  if (form.hedgeDelayMs.trim()) {
    const n = Number(form.hedgeDelayMs);
    if (!Number.isInteger(n) || n < 0)
      return { ok: false, error: 'Hedge delay must be a non-negative integer (ms).' };
    config['hedgeDelayMs'] = n;
  }

  const modelMap = parseJsonObject('Model map', form.modelMap);
  if (!modelMap.ok) return modelMap;
  if (modelMap.value) {
    for (const [provider, m] of Object.entries(modelMap.value)) {
      if (!isObj(m) || Object.values(m).some((v) => typeof v !== 'string')) {
        return {
          ok: false,
          error: `Model map: "${provider}" must map client model ids to upstream model ids (strings).`,
        };
      }
    }
    config['modelMap'] = modelMap.value;
  }
  return { ok: true, config };
}

/** One-line summary of a group's optional knobs for the list. */
export function groupOptionsLabel(cfg: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof cfg['select'] === 'string') parts.push(`select ${cfg['select']}`);
  if (isObj(cfg['weights'])) {
    parts.push(
      `weights ${Object.entries(cfg['weights'])
        .map(([k, v]) => `${k}:${String(v)}`)
        .join(' ')}`,
    );
  }
  if (Array.isArray(cfg['onStatusCodes']))
    parts.push(`on ${(cfg['onStatusCodes'] as unknown[]).join(',')}`);
  if (typeof cfg['hedgeDelayMs'] === 'number') parts.push(`hedge ${cfg['hedgeDelayMs']}ms`);
  if (isObj(cfg['modelMap'])) parts.push(`modelMap ${Object.keys(cfg['modelMap']).join(',')}`);
  return parts.length > 0 ? parts.join(' · ') : 'defaults';
}
