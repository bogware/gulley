import { exactKey, semanticText, streamTag } from './key';
import type {
  CacheableRequest,
  CachedResponse,
  CacheStatus,
  EmbeddingProvider,
  ExactCacheStore,
  VectorIndex,
} from './types';

export interface SemanticConfig {
  embed: EmbeddingProvider;
  index: VectorIndex;
  /** Cosine similarity at or above which a neighbor counts as a hit. */
  threshold: number;
}

export interface CacheEngineOptions {
  exact: ExactCacheStore;
  semantic?: SemanticConfig;
  ttlSeconds: number;
}

export interface CacheLookup {
  status: CacheStatus;
  exactKey: string;
  response?: CachedResponse;
  /** Present on a semantic miss — reuse it at store time to avoid re-embedding. */
  embedding?: number[];
}

/**
 * Two-tier lookup: exact first (a deterministic key hit), then semantic (nearest
 * neighbor above threshold). The vector id IS the exact key, so a semantic match
 * resolves straight to a stored exact entry. `store` persists both tiers.
 */
/** The semantic tier's partition — must include everything that changes the response
 *  (provider/model/path/variant/delivery mode), NOT just the tenant scope, so a
 *  paraphrase can never near-neighbor into a different model's, provider's or
 *  stream-mode's entry. Joined with the ASCII unit separator (U+001F): a character no
 *  scope, model, path or header value carries, AND one Postgres accepts in a `text`
 *  column — the previous NUL separator was rejected by the pgvector index
 *  (`invalid byte sequence for encoding "UTF8": 0x00`), which made every semantic
 *  lookup reject and, since the engine awaits it after the exact miss, bypassed the
 *  WHOLE cache on the production-default backend. */
export const VECTOR_SCOPE_SEPARATOR = '\u001f';
export function vectorScope(req: CacheableRequest): string {
  return [req.scope, req.provider, req.model, req.path, req.variant ?? '', streamTag(req)].join(
    VECTOR_SCOPE_SEPARATOR,
  );
}

export class CacheEngine {
  constructor(private readonly opts: CacheEngineOptions) {}

  get semanticEnabled(): boolean {
    return this.opts.semantic !== undefined;
  }

  private vectorScope(req: CacheableRequest): string {
    return vectorScope(req);
  }

  async lookup(req: CacheableRequest): Promise<CacheLookup> {
    const key = exactKey(req);

    const exactHit = await this.opts.exact.get(key);
    if (exactHit) return { status: 'hit-exact', exactKey: key, response: exactHit };

    const sem = this.opts.semantic;
    // The semantic tier runs only when configured AND the route hasn't opted out
    // (req.semantic === false) — the riskiest tier is per-route controllable.
    if (sem && req.semantic !== false) {
      const text = semanticText(req.body);
      if (text) {
        const embedding = await sem.embed.embed(text);
        // The partition keys on the REQUESTED provider/model/path/variant, so a
        // neighbor can only be another entry for the same requested model — a
        // paraphrase can never cross into a different model or provider.
        const [top] = await sem.index.query(this.vectorScope(req), embedding, 1);
        if (top && top.score >= sem.threshold) {
          const cached = await this.opts.exact.get(top.id);
          if (cached) return { status: 'hit-semantic', exactKey: key, response: cached };
        }
        return { status: 'miss', exactKey: key, embedding };
      }
    }
    return { status: 'miss', exactKey: key };
  }

  /** Persist a fresh response into both tiers. Callers must only store
   *  cacheable responses (2xx, not flagged by guardrails, no `no-store`). */
  async store(req: CacheableRequest, response: CachedResponse, lookup: CacheLookup): Promise<void> {
    await this.opts.exact.set(lookup.exactKey, response, this.opts.ttlSeconds);
    const sem = this.opts.semantic;
    if (sem && lookup.embedding) {
      // Give the vector entry the same lifetime as its exact-cache sibling so a Redis
      // vector backend self-reclaims (noeviction; otherwise the hash leaks forever).
      await sem.index.upsert(
        this.vectorScope(req),
        lookup.exactKey,
        lookup.embedding,
        this.opts.ttlSeconds,
      );
    }
  }
}
