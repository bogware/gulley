/**
 * Parse a provider's "how long until you can retry" signal from response
 * headers, normalized to milliseconds. Every upstream Gulley proxies spells this
 * differently: RFC 7231 `Retry-After` (delta-seconds OR an HTTP-date), Azure's
 * `retry-after-ms`, OpenAI's `x-ratelimit-reset-*` (Go-style durations like
 * "6m0s" or bare seconds), and Anthropic's `anthropic-ratelimit-*-reset` (RFC3339
 * timestamps). One helper feeds three consumers: the client-facing `Retry-After`
 * we echo, pre-failover backoff, and circuit-breaker cooldown.
 */
export type HeaderBag = Record<string, string | string[] | undefined>;

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};
const GO_DURATION = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s : undefined;
}

/** Parse a Go-style duration ("6m0s", "1s", "88ms") or a bare number (= seconds). */
export function parseDurationMs(raw: string): number | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000); // bare number = seconds
  GO_DURATION.lastIndex = 0;
  let ms = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = GO_DURATION.exec(s)) !== null) {
    matched = true;
    ms += parseFloat(m[1] as string) * (UNIT_MS[m[2] as string] ?? 0);
  }
  return matched ? Math.round(ms) : undefined;
}

/** ms from `nowMs` until an absolute time (RFC3339 / HTTP-date); undefined if unparseable. */
function msUntil(raw: string, nowMs: number): number | undefined {
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - nowMs);
}

const looksAbsolute = (s: string): boolean => /\d{4}-\d\d-\d\d|gmt|utc/i.test(s);

/**
 * Best backoff in milliseconds from a set of response headers, or undefined if
 * none present. Authoritative `Retry-After` / `retry-after-ms` win; otherwise the
 * soonest rate-limit-reset bucket is used. `nowMs` is injectable for testing.
 */
/** Ceiling on any parsed backoff. An upstream (or a fronting proxy) can express a
 *  reset as an epoch timestamp or hours away; unbounded, one such header pinned a
 *  retry sleep (and, via the breaker's cooldown floor, ejected the target fleet-wide)
 *  for that long. Anything above this is clamped; the value still ranks candidates. */
export const MAX_RETRY_AFTER_MS = 300_000;

/** A bare number that is far too large to be a delta is an epoch: seconds if it is
 *  around 1e9 (2001–2286), milliseconds if around 1e12. */
function bareNumberToMs(n: number, nowMs: number): number {
  if (n >= 1e11) return Math.max(0, n - nowMs); // epoch milliseconds
  if (n >= 1e8) return Math.max(0, n * 1000 - nowMs); // epoch seconds
  return n * 1000; // delta-seconds
}

const clamp = (ms: number | undefined): number | undefined =>
  ms === undefined ? undefined : Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);

export function parseRetryAfterMs(
  headers: HeaderBag,
  nowMs: number = Date.now(),
): number | undefined {
  return clamp(parseRetryAfterMsUnclamped(headers, nowMs));
}

function parseRetryAfterMsUnclamped(headers: HeaderBag, nowMs: number): number | undefined {
  const ms = headerValue(headers, 'retry-after-ms');
  if (ms && /^\d+$/.test(ms.trim())) return Number(ms.trim());

  const ra = headerValue(headers, 'retry-after');
  if (ra) {
    const t = ra.trim();
    if (/^\d+$/.test(t)) return bareNumberToMs(Number(t), nowMs); // delta-seconds (or epoch)
    const abs = msUntil(t, nowMs); // HTTP-date form
    if (abs !== undefined) return abs;
  }

  const candidates: number[] = [];
  // OpenAI-style durations (also DeepInfra/Groq/etc. via the compat layer).
  for (const name of [
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'x-ratelimit-reset',
  ]) {
    const v = headerValue(headers, name);
    if (!v) continue;
    // A bare integer here is the GitHub convention: an epoch-seconds reset.
    const d = looksAbsolute(v)
      ? msUntil(v, nowMs)
      : /^\d+$/.test(v.trim())
        ? bareNumberToMs(Number(v.trim()), nowMs)
        : parseDurationMs(v);
    if (d !== undefined) candidates.push(d);
  }
  // Anthropic RFC3339 reset timestamps.
  for (const name of [
    'anthropic-ratelimit-unified-reset',
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-input-tokens-reset',
    'anthropic-ratelimit-output-tokens-reset',
  ]) {
    const v = headerValue(headers, name);
    if (!v) continue;
    const abs = looksAbsolute(v) ? msUntil(v, nowMs) : parseDurationMs(v);
    if (abs !== undefined) candidates.push(abs);
  }

  return candidates.length ? Math.min(...candidates) : undefined;
}
