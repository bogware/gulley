import { cosineSimilarity } from '@gulley/cache';
import type { CentroidIndex, ClassifierEmbedder, SmartRoutingPolicy } from '@gulley/routing';
import { type CentroidStore, centroidSha } from '@gulley/storage';

/**
 * In-memory labeled-centroid store for `embedding-nearest-label` (M16). Per scope
 * (a policy name), a flat list of `{ label, embedding }` exemplar vectors;
 * `nearest` ranks them by cosine similarity. Rebuilt from config `exemplars` on
 * each reconcile; {@link buildPersistentCentroids} backs it with a durable
 * `classifier_centroid` store so replicas reuse embeddings instead of re-embedding
 * (M18). Fine for CI/tests and modest exemplar sets.
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

/**
 * Like {@link buildEmbeddingCentroids}, but reads/writes a durable
 * {@link CentroidStore} so exemplars embedded by one replica are reused by the
 * next instead of every replica re-embedding on boot. Persisted points short-
 * circuit the embedder; only new/changed exemplars are embedded, then persisted.
 *
 * Fail-open at every layer: a store `load` failure degrades to embedding
 * everything; a `save` failure is ignored (the index is already built in memory);
 * a per-exemplar `embed` failure skips just that exemplar. So a database hiccup
 * never aborts the reconcile — it only forgoes the optimization for that pass.
 */
export async function buildPersistentCentroids(
  policies: readonly SmartRoutingPolicy<string>[],
  embedder: ClassifierEmbedder,
  store: CentroidStore,
  model: string,
): Promise<InMemoryCentroidIndex> {
  const index = new InMemoryCentroidIndex();
  const embeddingPolicies = policies.filter(
    (p) => p.classifier.mode === 'embedding-nearest-label' && p.classifier.exemplars,
  );
  const scopes = embeddingPolicies.map((p) => p.name);

  // key = `${scope}\0${label}\0${exemplarSha}` — an exact persisted point.
  const persisted = new Map<string, number[]>();
  try {
    for (const row of await store.load(scopes, model)) {
      persisted.set(`${row.scope}\0${row.label}\0${row.exemplarSha}`, row.embedding);
    }
  } catch {
    /* fail-open: treat as nothing persisted and embed everything */
  }

  const byText = new Map<string, number[]>(); // within-build memo (a text reused across labels)
  const fresh: Array<{ scope: string; label: string; exemplar: string; embedding: number[] }> = [];
  for (const policy of embeddingPolicies) {
    for (const [label, texts] of Object.entries(policy.classifier.exemplars ?? {})) {
      for (const text of texts) {
        const key = `${policy.name}\0${label}\0${centroidSha(text)}`;
        const hit = persisted.get(key);
        if (hit) {
          index.add(policy.name, label, hit); // reuse persisted embedding — no embed
          continue;
        }
        let vec = byText.get(text);
        if (!vec) {
          try {
            vec = await embedder.embed(text);
          } catch {
            continue; // skip a failed exemplar; fail-open
          }
          byText.set(text, vec);
        }
        index.add(policy.name, label, vec);
        persisted.set(key, vec); // don't queue the same (scope,label,text) twice this build
        fresh.push({ scope: policy.name, label, exemplar: text, embedding: vec });
      }
    }
  }

  if (fresh.length > 0) {
    try {
      await store.save(model, fresh);
    } catch {
      /* best-effort persist — the in-memory index is already complete */
    }
  }
  return index;
}
