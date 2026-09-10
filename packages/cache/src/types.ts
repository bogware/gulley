/** A request as the cache sees it. `scope` partitions the cache so a response is
 *  never shared across principals/workspaces or across models. */
export interface CacheableRequest {
  scope: string;
  provider: string;
  model: string;
  path: string;
  body: Buffer;
  /** Extra request attributes that change response semantics (e.g. an
   *  `anthropic-beta` header); folded into the exact key. */
  variant?: string;
}

/** A stored upstream response, replayed verbatim on a hit. */
export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  /** Full response bytes (SSE or JSON) exactly as returned upstream. */
  body: Buffer;
  streamed: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAtMs: number;
}

export type CacheStatus = 'hit-exact' | 'hit-semantic' | 'miss' | 'bypass';

/** Exact-match store (deterministic key -> bytes). Implemented in-memory here;
 *  Postgres and Redis adapters live in @gulley/storage. */
export interface ExactCacheStore {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void>;
}

/** Produces embedding vectors for the semantic tier. An optional `signal` lets a
 *  caller (e.g. the smart-routing classifier's timeout) cancel a slow embed. */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

export interface VectorMatch {
  /** The exact-cache key of the matched entry. */
  id: string;
  score: number;
}

/** Approximate-nearest-neighbor index over embeddings, partitioned by scope.
 *  In-memory (brute force) here; pgvector / Redis Stack adapters in storage. */
export interface VectorIndex {
  /** Insert/update an embedding. `ttlSeconds`, when given, bounds the entry's lifetime
   *  so it self-reclaims in step with the exact-cache entry — REQUIRED for a Redis
   *  vector backend (noeviction; an un-expired hash would grow without bound). Backends
   *  with their own reclamation (pgvector cascade sweep, in-memory) may ignore it. */
  upsert(scope: string, id: string, embedding: number[], ttlSeconds?: number): Promise<void>;
  query(scope: string, embedding: number[], topK: number): Promise<VectorMatch[]>;
}
