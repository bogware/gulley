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

/**
 * Brute-force in-memory vector index, partitioned by scope. Correct and fine for
 * CI/tests and modest single-node caches; pgvector (HNSW) is the prod default.
 */
export class InMemoryVectorIndex implements VectorIndex {
  private readonly byScope = new Map<string, Map<string, number[]>>();

  async upsert(
    scope: string,
    id: string,
    embedding: number[],
    _ttlSeconds?: number,
  ): Promise<void> {
    // In-memory index is CI/test-scale; no TTL needed (it dies with the process).
    let m = this.byScope.get(scope);
    if (!m) {
      m = new Map();
      this.byScope.set(scope, m);
    }
    m.set(id, embedding);
  }

  async query(scope: string, embedding: number[], topK: number): Promise<VectorMatch[]> {
    const m = this.byScope.get(scope);
    if (!m) return [];
    const scored: VectorMatch[] = [];
    for (const [id, vec] of m) scored.push({ id, score: cosineSimilarity(embedding, vec) });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
