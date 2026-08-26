/**
 * Credentials-safe CORS for the admin surface. Because the admin UI calls with
 * `credentials: 'include'`, a wildcard `Access-Control-Allow-Origin` is both
 * rejected by browsers and unsafe — so we reflect an EXACT allowlisted origin,
 * set `Allow-Credentials: true`, and always `Vary: Origin`. An empty allowlist
 * means no CORS headers at all (the same-origin proxy deployment is unaffected).
 */
export interface CorsConfig {
  /** Exact origins permitted (e.g. "https://admin.example.com"). Empty = off. */
  origins: ReadonlySet<string>;
  /** Methods advertised on preflight. */
  allowMethods?: string;
  /** Request headers advertised on preflight. */
  allowHeaders?: string;
  /** Preflight cache lifetime. */
  maxAgeSeconds?: number;
}

/** True when the request Origin is in the exact-origin allowlist. */
export function corsAllows(origin: string | undefined, cfg: CorsConfig): boolean {
  return origin !== undefined && cfg.origins.has(origin);
}

/** CORS headers to attach to a real (non-preflight) response — empty when the
 *  origin is not allowlisted, so unrelated/same-origin responses are untouched. */
export function corsResponseHeaders(
  origin: string | undefined,
  cfg: CorsConfig,
): Record<string, string> {
  if (!corsAllows(origin, cfg)) return {};
  return {
    'access-control-allow-origin': origin as string,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

/** Full 204 preflight header set for an allowlisted OPTIONS request. */
export function corsPreflightHeaders(
  origin: string | undefined,
  cfg: CorsConfig,
): Record<string, string> {
  if (!corsAllows(origin, cfg)) return {};
  return {
    ...corsResponseHeaders(origin, cfg),
    'access-control-allow-methods': cfg.allowMethods ?? 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': cfg.allowHeaders ?? 'authorization,content-type',
    'access-control-max-age': String(cfg.maxAgeSeconds ?? 600),
  };
}

/** True when this is a CORS preflight we should short-circuit with a 204. */
export function isCorsPreflight(
  method: string,
  origin: string | undefined,
  cfg: CorsConfig,
): boolean {
  return method.toUpperCase() === 'OPTIONS' && corsAllows(origin, cfg);
}
