import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './db';
import { classifierCentroid } from './schema';

/** A persisted classifier centroid point: one embedded exemplar, tagged with the
 *  policy scope + category label it belongs to. `exemplarSha` identifies the
 *  exemplar text (so a reconcile can match config exemplars to persisted rows
 *  without storing the raw prompt). */
export interface PersistedCentroid {
  scope: string;
  label: string;
  exemplarSha: string;
  embedding: number[];
}

/** The persistence port the smart-routing reconciler uses to avoid re-embedding
 *  exemplars on every replica. `PostgresCentroidStore` is the production impl;
 *  tests supply an in-memory fake. */
export interface CentroidStore {
  /** All persisted points for the given policy scopes under one embedding model. */
  load(scopes: string[], model: string): Promise<PersistedCentroid[]>;
  /** Upsert freshly-embedded points (idempotent on scope+label+model+exemplar). */
  save(
    model: string,
    rows: ReadonlyArray<{ scope: string; label: string; exemplar: string; embedding: number[] }>,
  ): Promise<void>;
}

/** Stable identifier for an exemplar text — sha256 hex. Shared by the store (on
 *  write) and the reconciler (to match config exemplars to persisted rows), so
 *  both sides MUST derive the key the same way. */
export function centroidSha(exemplar: string): string {
  return createHash('sha256').update(exemplar, 'utf8').digest('hex');
}

/**
 * Postgres-backed {@link CentroidStore}. Embeddings are stored as jsonb `number[]`
 * (not pgvector): the reconciler loads every row for the active policies and ranks
 * by cosine in memory, so no SQL ANN operator is needed and any embedding
 * dimension works. Writes are idempotent — the embedding for a given
 * (exemplar, model) is deterministic, so a re-seen row is left as-is.
 */
export class PostgresCentroidStore implements CentroidStore {
  constructor(private readonly db: Database) {}

  async load(scopes: string[], model: string): Promise<PersistedCentroid[]> {
    if (scopes.length === 0) return [];
    const rows = await this.db
      .select({
        scope: classifierCentroid.scope,
        label: classifierCentroid.label,
        exemplarSha: classifierCentroid.exemplarSha,
        embedding: classifierCentroid.embedding,
      })
      .from(classifierCentroid)
      .where(and(eq(classifierCentroid.model, model), inArray(classifierCentroid.scope, scopes)));
    return rows.map((r) => ({
      scope: r.scope,
      label: r.label,
      exemplarSha: r.exemplarSha,
      embedding: r.embedding,
    }));
  }

  async save(
    model: string,
    rows: ReadonlyArray<{ scope: string; label: string; exemplar: string; embedding: number[] }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      scope: r.scope,
      label: r.label,
      model,
      exemplarSha: centroidSha(r.exemplar),
      embedding: r.embedding,
      // Dual-write the pgvector column so the ANN index (PostgresCentroidIndex) is
      // populated. save() is the ONLY writer of this table, so the two columns can
      // never drift. On PGlite (no pgvector) the column degrades to text and the
      // literal is stored harmlessly.
      embeddingVec: r.embedding,
    }));
    await this.db
      .insert(classifierCentroid)
      .values(values)
      .onConflictDoNothing({
        target: [
          classifierCentroid.scope,
          classifierCentroid.label,
          classifierCentroid.model,
          classifierCentroid.exemplarSha,
        ],
      });
  }
}

/**
 * pgvector-backed nearest-exemplar index (M22 C). Request-time `nearest` is an
 * indexed ANN query (`<=>` cosine distance + the HNSW index from migration 0012)
 * over `classifier_centroid.embedding_vec`, filtered by scope AND embedding model —
 * O(log N) instead of the {@link InMemoryCentroidIndex}'s O(N) in-JS cosine, so it
 * scales to large exemplar sets without shipping every vector to every replica.
 *
 * Structurally a `CentroidIndex` (the smart router consumes it as one). Fail-open:
 * any DB error returns `[]`, so `classifyRequest` abstains (→ model router) rather
 * than erroring — the same never-throw contract as the in-memory path.
 */
export class PostgresCentroidIndex {
  constructor(
    private readonly db: Database,
    private readonly model: string,
  ) {}

  async nearest(
    scope: string,
    embedding: number[],
    topK: number,
  ): Promise<Array<{ label: string; score: number }>> {
    try {
      const literal = `[${embedding.join(',')}]`;
      const result = await this.db.execute(sql`
        SELECT label, 1 - (embedding_vec <=> ${literal}::vector) AS score
        FROM classifier_centroid
        WHERE scope = ${scope} AND model = ${this.model} AND embedding_vec IS NOT NULL
        ORDER BY embedding_vec <=> ${literal}::vector
        LIMIT ${topK}
      `);
      const rows = result as unknown as Array<{ label: string; score: number }>;
      return rows.map((r) => ({ label: r.label, score: Number(r.score) }));
    } catch {
      return []; // fail open — classifyRequest abstains rather than throwing
    }
  }
}
