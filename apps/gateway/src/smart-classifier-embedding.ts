import { cosineSimilarity } from '@gulley/cache';
import type { CentroidIndex, ClassifierEmbedder, SmartRoutingPolicy } from '@gulley/routing';

/**
 * In-memory labeled-centroid store for `embedding-nearest-label` (M16). Per scope
 * (a policy name), a flat list of `{ label, embedding }` exemplar vectors;
 * `nearest` ranks them by cosine similarity. Rebuilt from config `exemplars` on
 * each reconcile — a persistent `classifier_centroid` table is a future
 * optimization (so replicas don't each re-embed). Fine for CI/tests and modest
 * exemplar sets.
 */
export class InMemoryCentroidIndex implements CentroidIndex {
  private readonly byScope = new Map<string, Array<{ label: string; embedding: number[] }>>();

  add(scope: string, label: string, embedding: number[]): void {
    let list = this.byScope.get(scope);
    if (!list) {
      list = [];
      this.byScope.set(scope, list);
    }
    list.push({ label, embedding });
  }

  async nearest(
    scope: string,
    embedding: number[],
    topK: number,
  ): Promise<Array<{ label: string; score: number }>> {
    const list = this.byScope.get(scope) ?? [];
    return list
      .map((c) => ({ label: c.label, score: cosineSimilarity(embedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Number of stored exemplars for a scope (observability/tests). */
  size(scope: string): number {
    return this.byScope.get(scope)?.length ?? 0;
  }
}

/** A text→embedding memo so a reconcile does not re-embed unchanged exemplars.
 *  Held by the reconciler across reconciles (the embedder is fixed per process). */
export type EmbeddingCache = Map<string, number[]>;

/**
 * Build the centroid index for every `embedding-nearest-label` policy from its
 * `exemplars`. Each exemplar text is embedded (memoized across reconciles) and
 * stored under `policy.name → category`. A per-exemplar embedding failure is
 * skipped (fail-open: a policy with no centroids abstains → the model router).
 */
export async function buildEmbeddingCentroids(
  policies: readonly SmartRoutingPolicy<string>[],
  embedder: ClassifierEmbedder,
  cache: EmbeddingCache = new Map(),
): Promise<InMemoryCentroidIndex> {
  const index = new InMemoryCentroidIndex();
  for (const policy of policies) {
    if (policy.classifier.mode !== 'embedding-nearest-label' || !policy.classifier.exemplars) {
      continue;
    }
    for (const [category, texts] of Object.entries(policy.classifier.exemplars)) {
      for (const text of texts) {
        let vec = cache.get(text);
        if (!vec) {
          try {
            vec = await embedder.embed(text);
          } catch {
            continue; // skip a failed exemplar; fail-open
          }
          cache.set(text, vec);
        }
        index.add(policy.name, category, vec);
      }
    }
  }
  return index;
}
