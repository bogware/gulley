import type { VectorIndex, VectorMatch } from './types';

/** Cosine similarity in [-1, 1]; 0 when either vector is zero-length. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Entry {
  embedding: number[];
  /** Epoch ms; Infinity when stored without a TTL. */
  expiresAtMs: number;
}

export interface InMemoryVectorIndexOptions {
  /** Upper bound on vectors per scope (oldest-inserted evicted). Default 5_000. */
  maxPerScope?: number;
  now?: () => number;
}

/**
 * Brute-force in-memory vector index, partitioned by scope. Correct and fine for
 * CI/tests and modest single-node caches; pgvector (HNSW) is the prod default.
 * Honours the TTL it is given (lazy purge on query/upsert) and bounds each scope,
 * since the backend is selectable in production config.
 */
export class InMemoryVectorIndex implements VectorIndex {
  private readonly byScope = new Map<string, Map<string, Entry>>();
  private readonly maxPerScope: number;
  private readonly now: () => number;

  constructor(opts: InMemoryVectorIndexOptions = {}) {
    this.maxPerScope = Math.max(1, opts.maxPerScope ?? 5_000);
    this.now = opts.now ?? (() => Date.now());
  }

  async upsert(scope: string, id: string, embedding: number[], ttlSeconds?: number): Promise<void> {
    let m = this.byScope.get(scope);
    if (!m) {
      m = new Map();
      this.byScope.set(scope, m);
    }
    m.delete(id);
    m.set(id, {
      embedding,
      expiresAtMs: ttlSeconds && ttlSeconds > 0 ? this.now() + ttlSeconds * 1000 : Infinity,
    });
    while (m.size > this.maxPerScope) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  async query(scope: string, embedding: number[], topK: number): Promise<VectorMatch[]> {
    const m = this.byScope.get(scope);
    if (!m) return [];
    const t = this.now();
    const scored: VectorMatch[] = [];
    for (const [id, e] of m) {
      if (e.expiresAtMs <= t) {
        m.delete(id);
        continue;
      }
      scored.push({ id, score: cosineSimilarity(embedding, e.embedding) });
    }
    if (m.size === 0) this.byScope.delete(scope);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Test/inspection helper: live vectors in a scope. */
  size(scope: string): number {
    return this.byScope.get(scope)?.size ?? 0;
  }
}
