import type { AuthzDecision } from './policy';
import { compile, type Program } from './program';

/**
 * External authorization hook: delegates the allow/deny decision to an operator's
 * HTTP policy service, sending the CEL-shaped `{ request, principal }` activation
 * as JSON and expecting `{ allow: boolean, reason?: string }` back. Decisions are
 * cached by a key (a CEL expression over the activation, or a sensible default)
 * with a TTL, and concurrent misses for the same key share ONE in-flight request
 * (single-flight) so a burst can't stampede the policy service. On timeout/error
 * the configured `failMode` decides, and those outcomes are NOT cached so a
 * recovered service is retried on the next request.
 */
export interface ExternalAuthzConfig {
  url: string;
  /** CEL expression → a string cache key over the activation. Default keys by
   *  principal id + model + provider. */
  cacheKeyExpr?: string;
  /** Decision cache TTL (ms). */
  ttlMs?: number;
  /** Request timeout (ms). */
  timeoutMs?: number;
  /** Decision when the policy service errors/times out. Default 'deny'. */
  failMode?: 'allow' | 'deny';
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CachedDecision {
  decision: AuthzDecision;
  expiresAt: number;
}

interface ServiceResponse {
  allow?: boolean;
  allowed?: boolean;
  reason?: string;
}

export class ExternalAuthorizer {
  private readonly cache = new Map<string, CachedDecision>();
  private readonly inflight = new Map<string, Promise<AuthzDecision>>();
  private readonly keyProgram: Program | undefined;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly failMode: 'allow' | 'deny';
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: ExternalAuthzConfig) {
    this.keyProgram = cfg.cacheKeyExpr ? compile(cfg.cacheKeyExpr, { strict: false }) : undefined;
    this.ttlMs = cfg.ttlMs ?? 30_000;
    this.timeoutMs = cfg.timeoutMs ?? 1000;
    this.failMode = cfg.failMode ?? 'deny';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? ((): number => Date.now());
  }

  async authorize(root: Record<string, unknown>): Promise<AuthzDecision> {
    const key = this.cacheKey(root);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.decision;

    let flight = this.inflight.get(key);
    if (!flight) {
      flight = this.fetchDecision(root, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, flight);
    }
    return flight;
  }

  private cacheKey(root: Record<string, unknown>): string {
    if (this.keyProgram) {
      try {
        return String(this.keyProgram.eval(root));
      } catch {
        /* fall through to the default key */
      }
    }
    const req = (root['request'] ?? {}) as Record<string, unknown>;
    const pr = (root['principal'] ?? {}) as Record<string, unknown>;
    return `${String(pr['id'])}|${String(req['model'])}|${String(req['provider'])}`;
  }

  private async fetchDecision(root: Record<string, unknown>, key: string): Promise<AuthzDecision> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(root),
        signal: ac.signal,
      });
      if (!res.ok) return this.onFailure();
      const body = (await res.json()) as ServiceResponse;
      const allowed = body.allow ?? body.allowed;
      if (typeof allowed !== 'boolean') return this.onFailure();
      const decision: AuthzDecision = { allowed, reason: body.reason ?? 'external' };
      // Cache only a genuine decision (never a fail-open/closed fallback).
      this.cache.set(key, { decision, expiresAt: this.now() + this.ttlMs });
      return decision;
    } catch {
      return this.onFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  private onFailure(): AuthzDecision {
    return this.failMode === 'allow'
      ? { allowed: true, reason: 'external:fail-open' }
      : { allowed: false, reason: 'external:fail-closed' };
  }
}
