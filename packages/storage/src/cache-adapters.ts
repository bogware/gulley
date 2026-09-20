import type { CachedResponse, ExactCacheStore, VectorIndex, VectorMatch } from '@gulley/cache';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from './db';
import {
  type BatchSweepOptions,
  type BatchSweepResult,
  deleteExpiredBatch,
  MAINTENANCE_LOCK,
  sweepInBatches,
} from './maintenance';
import { cacheEntry, semanticVector } from './schema';

function scopeOf(key: string): string {
  return key.split(':', 1)[0] ?? '';
}

/** Postgres exact cache — the durable, multi-node default. Body is base64 so
 *  binary SSE survives; reads filter out expired rows, and {@link sweepExpired}
 *  reclaims them (without it, unique/expired keys grow the table + pgvector index
 *  unbounded — only the Redis tier's native TTL reclaims otherwise). */
export class PostgresExactCache implements ExactCacheStore {
  constructor(private readonly db: Database) {}

  /** Delete expired rows (semantic_vector rows cascade) in bounded batches under an
   *  advisory lock. Returns rows removed. A single unbounded DELETE used to run under
   *  the data plane's statement_timeout: once the backlog grew past what 8 s could
   *  clear it was cancelled every tick (zero progress, error swallowed) and the table
   *  — full response bodies plus the HNSW index — grew without bound. */
  async sweepExpired(now: Date = new Date(), opts: BatchSweepOptions = {}): Promise<number> {
    return (await this.sweepExpiredDetailed(now, opts)).removed;
  }

  async sweepExpiredDetailed(
    now: Date = new Date(),
    opts: BatchSweepOptions = {},
  ): Promise<BatchSweepResult> {
    return sweepInBatches(this.db, { lockId: MAINTENANCE_LOCK.cacheSweep, ...opts }, (tx, n) =>
      deleteExpiredBatch(tx, 'cache_entry', 'expires_at', now, n),
    );
  }

  async get(key: string): Promise<CachedResponse | null> {
    const rows = await this.db
      .select()
      .from(cacheEntry)
      .where(and(eq(cacheEntry.key, key), gt(cacheEntry.expiresAt, new Date())))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      statusCode: r.statusCode,
      headers: r.headers as Record<string, string | string[]>,
      body: Buffer.from(r.body, 'base64'),
      streamed: r.streamed,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      createdAtMs: r.createdAt.getTime(),
    };
  }

  async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const body = value.body.toString('base64');
    await this.db
      .insert(cacheEntry)
      .values({
        key,
        scope: scopeOf(key),
        model: value.model,
        statusCode: value.statusCode,
        streamed: value.streamed,
        headers: value.headers,
        body,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: cacheEntry.key,
        // Refresh EVERY value column: a re-stored key previously kept its first
        // headers/token counts/created_at and replayed stale ones.
        set: {
          model: value.model,
          statusCode: value.statusCode,
          streamed: value.streamed,
          headers: value.headers,
          body,
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          createdAt: sql`now()`,
          expiresAt,
        },
      });
  }
}

/** Postgres pgvector index — the prod default for the semantic tier. Cosine
 *  distance via the `<=>` operator; an HNSW index (migration 0003) makes it ANN. */
export class PostgresVectorIndex implements VectorIndex {
  constructor(private readonly db: Database) {}

  async upsert(
    scope: string,
    id: string,
    embedding: number[],
    _ttlSeconds?: number,
  ): Promise<void> {
    // Postgres vectors are reclaimed by the cascade sweep (semantic_vector rows are
    // deleted when their exact-cache row expires), so no per-row TTL is applied here.
    await this.db
      .insert(semanticVector)
      .values({ key: id, scope, embedding })
      .onConflictDoUpdate({ target: semanticVector.key, set: { embedding, scope } });
  }

  async query(scope: string, embedding: number[], topK: number): Promise<VectorMatch[]> {
    const literal = `[${embedding.join(',')}]`;
    const result = await this.db.execute(sql`
      SELECT key, 1 - (embedding <=> ${literal}::vector) AS score
      FROM semantic_vector
      WHERE scope = ${scope}
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${topK}
    `);
    const rows = result as unknown as Array<{ key: string; score: number }>;
    return rows.map((r) => ({ id: r.key, score: Number(r.score) }));
  }
}

/** Redis exact cache — works on plain Redis (no modules). JSON envelope with the
 *  body base64-encoded; TTL enforced natively via `EX`. */
export class RedisExactCache implements ExactCacheStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'cache:exact:',
  ) {}

  async get(key: string): Promise<CachedResponse | null> {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) return null;
    const o = JSON.parse(raw) as Omit<CachedResponse, 'body'> & { body: string };
    return { ...o, body: Buffer.from(o.body, 'base64') };
  }

  async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    const payload = JSON.stringify({ ...value, body: value.body.toString('base64') });
    await this.redis.set(this.prefix + key, payload, 'EX', ttlSeconds);
  }
}

/**
 * Redis Stack (RediSearch) vector index — a seam for deployments that prefer
 * Redis over pgvector. Requires the RediSearch module and an FT index over a
 * FLAT/HNSW `embedding` field plus a `scope` TAG. `ensureIndex` creates it if
 * absent. Validated in local acceptance against redis-stack; pgvector is the
 * default. See docs/ARCHITECTURE.md §caching.
 */
export class RedisVectorIndex implements VectorIndex {
  private ensured = false;

  constructor(
    private readonly redis: Redis,
    private readonly dimensions = 256,
    private readonly indexName = 'gulley_semantic',
    private readonly prefix = 'cache:vec:',
  ) {}

  private async ensureIndex(): Promise<void> {
    if (this.ensured) return;
    try {
      await this.redis.call(
        'FT.CREATE',
        this.indexName,
        'ON',
        'HASH',
        'PREFIX',
        '1',
        this.prefix,
        'SCHEMA',
        'scope',
        'TAG',
        'embedding',
        'VECTOR',
        'HNSW',
        '6',
        'TYPE',
        'FLOAT32',
        'DIM',
        String(this.dimensions),
        'DISTANCE_METRIC',
        'COSINE',
      );
    } catch (err) {
      // Only "already exists" means the index is there. Any other failure (connection
      // refused, timeout, no RediSearch module) must NOT latch, or every later
      // FT.SEARCH fails "no such index" until the process restarts.
      if (!/index already exists/i.test((err as Error).message ?? '')) throw err;
    }
    this.ensured = true;
  }

  private static toBlob(embedding: number[]): Buffer {
    return Buffer.from(new Float32Array(embedding).buffer);
  }

  async upsert(scope: string, id: string, embedding: number[], ttlSeconds?: number): Promise<void> {
    await this.ensureIndex();
    const key = this.prefix + id;
    const fields = { scope, key: id, embedding: RedisVectorIndex.toBlob(embedding) };
    // The vector Redis runs `noeviction`, so an un-expired hash grows without bound.
    // Give each vector the exact-cache entry's lifetime via a pipelined HSET+EXPIRE —
    // RediSearch drops expired hash keys from the FT index automatically, so orphaned
    // vectors self-reclaim (no bespoke sweeper needed).
    if (ttlSeconds && ttlSeconds > 0) {
      await this.redis.pipeline().hset(key, fields).expire(key, Math.ceil(ttlSeconds)).exec();
    } else {
      await this.redis.hset(key, fields);
    }
  }

  async query(scope: string, embedding: number[], topK: number): Promise<VectorMatch[]> {
    await this.ensureIndex();
    const tag = scope.replace(/([,.<>{}[\]"':;!@#$%^&*()\-+=~ ])/g, '\\$1');
    const res = (await this.redis.call(
      'FT.SEARCH',
      this.indexName,
      `(@scope:{${tag}})=>[KNN ${topK} @embedding $vec AS score]`,
      'PARAMS',
      '2',
      'vec',
      RedisVectorIndex.toBlob(embedding),
      'SORTBY',
      'score',
      'RETURN',
      '2',
      'key',
      'score',
      'DIALECT',
      '2',
    )) as unknown[];
    return parseFtSearch(res);
  }
}

/** Parse an `FT.SEARCH` reply ([total, docId, [field, val, ...], ...]) into
 *  matches. Score field is cosine DISTANCE; convert to similarity. */
function parseFtSearch(res: unknown[]): VectorMatch[] {
  const out: VectorMatch[] = [];
  for (let i = 1; i < res.length; i += 2) {
    const fields = res[i + 1];
    if (!Array.isArray(fields)) continue;
    let key = '';
    let distance = 1;
    for (let j = 0; j < fields.length; j += 2) {
      const name = String(fields[j]);
      const value = String(fields[j + 1]);
      if (name === 'key') key = value;
      else if (name === 'score') distance = Number(value);
    }
    if (key) out.push({ id: key, score: 1 - distance });
  }
  return out;
}
