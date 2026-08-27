import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
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
