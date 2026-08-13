import { exactKey, semanticText } from './key';
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
export class CacheEngine {
  constructor(private readonly opts: CacheEngineOptions) {}

  get semanticEnabled(): boolean {
    return this.opts.semantic !== undefined;
  }

  async lookup(req: CacheableRequest): Promise<CacheLookup> {
    const key = exactKey(req);

    const exactHit = await this.opts.exact.get(key);
    if (exactHit) return { status: 'hit-exact', exactKey: key, response: exactHit };

    const sem = this.opts.semantic;
    if (sem) {
      const text = semanticText(req.body);
      if (text) {
        const embedding = await sem.embed.embed(text);
        const [top] = await sem.index.query(req.scope, embedding, 1);
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
      await sem.index.upsert(req.scope, lookup.exactKey, lookup.embedding);
    }
  }
}
