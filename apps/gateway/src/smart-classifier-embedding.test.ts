import type { SmartRoutingPolicy } from '@gulley/routing';
import { type CentroidStore, centroidSha } from '@gulley/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEmbeddingCentroids,
  buildPersistentCentroids,
  type EmbeddingCache,
  InMemoryCentroidIndex,
} from './smart-classifier-embedding';

describe('InMemoryCentroidIndex', () => {
  it('ranks stored exemplars by cosine similarity', async () => {
    const idx = new InMemoryCentroidIndex();
    idx.add('p', 'code', [1, 0, 0]);
    idx.add('p', 'prose', [0, 1, 0]);
    const near = await idx.nearest('p', [0.9, 0.1, 0], 2);
    expect(near[0]?.label).toBe('code');
    expect(near[0]!.score).toBeGreaterThan(near[1]!.score);
  });

  it('returns [] for an unknown scope', async () => {
    expect(await new InMemoryCentroidIndex().nearest('nope', [1], 1)).toEqual([]);
  });
});

const embPolicy = (exemplars: Record<string, string[]>): SmartRoutingPolicy => ({
  name: 'p',
  objective: 'domain-skill',
  classifier: { mode: 'embedding-nearest-label', exemplars },
  categoryRoutes: { code: 'a', prose: 'b' },
  selector: {},
});

describe('buildEmbeddingCentroids', () => {
  it('embeds each exemplar under its policy name + category', async () => {
    const embed = vi.fn(async (t: string) => (t.includes('function') ? [1, 0] : [0, 1]));
    const idx = await buildEmbeddingCentroids(
      [embPolicy({ code: ['write a function'], prose: ['tell a story'] })],
      { embed },
    );
    expect(idx.size('p')).toBe(2);
    expect((await idx.nearest('p', [1, 0], 1))[0]?.label).toBe('code');
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('memoizes across builds via the shared cache (no re-embed of unchanged exemplars)', async () => {
    const embed = vi.fn(async () => [1, 0]);
    const cache: EmbeddingCache = new Map();
    await buildEmbeddingCentroids([embPolicy({ code: ['x'] })], { embed }, cache);
    await buildEmbeddingCentroids([embPolicy({ code: ['x'] })], { embed }, cache);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('skips a failed exemplar (fail-open)', async () => {
    const embed = vi.fn(async (t: string) => {
      if (t === 'bad') throw new Error('embedder down');
      return [1, 0];
    });
    const idx = await buildEmbeddingCentroids([embPolicy({ code: ['good', 'bad'] })], { embed });
    expect(idx.size('p')).toBe(1); // only 'good' was embedded
  });

  it('ignores non-embedding policies and embedding policies without exemplars', async () => {
    const embed = vi.fn(async () => [1, 0]);
    const idx = await buildEmbeddingCentroids(
      [
        {
          name: 'r',
          objective: 'cost-tier',
          classifier: { mode: 'rules-then-llm' },
          categoryRoutes: {},
          selector: {},
        },
        {
          name: 'e',
          objective: 'domain-skill',
          classifier: { mode: 'embedding-nearest-label' },
          categoryRoutes: {},
          selector: {},
        },
      ],
      { embed },
    );
    expect(embed).not.toHaveBeenCalled();
    expect(idx.size('r')).toBe(0);
    expect(idx.size('e')).toBe(0);
  });
});

class FakeCentroidStore implements CentroidStore {
  rows: Array<{
    scope: string;
    label: string;
    model: string;
    exemplarSha: string;
    embedding: number[];
  }> = [];
  async load(scopes: string[], model: string): ReturnType<CentroidStore['load']> {
    return this.rows
      .filter((r) => r.model === model && scopes.includes(r.scope))
      .map(({ scope, label, exemplarSha, embedding }) => ({
        scope,
        label,
        exemplarSha,
        embedding,
      }));
  }
  async save(
    model: string,
    rows: ReadonlyArray<{ scope: string; label: string; exemplar: string; embedding: number[] }>,
  ): Promise<void> {
    for (const r of rows) {
      const exemplarSha = centroidSha(r.exemplar);
      const dup = this.rows.some(
        (x) =>
          x.scope === r.scope &&
          x.label === r.label &&
          x.model === model &&
          x.exemplarSha === exemplarSha,
      );
      if (!dup)
        this.rows.push({
          scope: r.scope,
          label: r.label,
          model,
          exemplarSha,
          embedding: r.embedding,
        });
    }
  }
}

describe('buildPersistentCentroids', () => {
  it('embeds + persists on first build, then reuses persisted embeddings on the next', async () => {
    const embed = vi.fn(async (t: string) => (t.includes('function') ? [1, 0] : [0, 1]));
    const store = new FakeCentroidStore();
    const policies = [embPolicy({ code: ['write a function'], prose: ['tell a story'] })];

    const idx1 = await buildPersistentCentroids(policies, { embed }, store, 'm1');
    expect(embed).toHaveBeenCalledTimes(2); // first replica embeds both exemplars
    expect(store.rows).toHaveLength(2); // and persists them
    expect(idx1.size('p')).toBe(2);

    embed.mockClear();
    const idx2 = await buildPersistentCentroids(policies, { embed }, store, 'm1'); // fresh replica
    expect(embed).not.toHaveBeenCalled(); // reused from the store — no re-embed
    expect(idx2.size('p')).toBe(2);
    expect((await idx2.nearest('p', [1, 0], 1))[0]?.label).toBe('code');
  });

  it('re-embeds when the embedding model changes (model is part of the key)', async () => {
    const embed = vi.fn(async () => [1, 0]);
    const store = new FakeCentroidStore();
    await buildPersistentCentroids([embPolicy({ code: ['x'] })], { embed }, store, 'm1');
    embed.mockClear();
    await buildPersistentCentroids([embPolicy({ code: ['x'] })], { embed }, store, 'm2');
    expect(embed).toHaveBeenCalledTimes(1); // a different model is a miss, not a reuse
  });

  it('embeds a shared exemplar once per build even across labels', async () => {
    const embed = vi.fn(async () => [1, 0]);
    const store = new FakeCentroidStore();
    const idx = await buildPersistentCentroids(
      [embPolicy({ code: ['shared'], prose: ['shared'] })],
      { embed },
      store,
      'm1',
    );
    expect(embed).toHaveBeenCalledTimes(1); // within-build memo reuses the vector
    expect(idx.size('p')).toBe(2); // but it is added under both labels
    expect(store.rows).toHaveLength(2); // and persisted under both (scope,label)
  });

  it('fails open when the store load throws (embeds everything)', async () => {
    const embed = vi.fn(async () => [1, 0]);
    const store: CentroidStore = {
      load: async () => {
        throw new Error('db down');
      },
      save: async () => {},
    };
    const idx = await buildPersistentCentroids([embPolicy({ code: ['x'] })], { embed }, store, 'm');
    expect(embed).toHaveBeenCalledTimes(1);
    expect(idx.size('p')).toBe(1);
  });

  it('fails open when the store save throws (index still built)', async () => {
    const embed = vi.fn(async () => [1, 0]);
    const store: CentroidStore = {
      load: async () => [],
      save: async () => {
        throw new Error('db down');
      },
    };
    const idx = await buildPersistentCentroids([embPolicy({ code: ['x'] })], { embed }, store, 'm');
    expect(idx.size('p')).toBe(1);
  });

  it('returns the ANN index (not the in-memory one) but still embeds + persists', async () => {
    const embed = vi.fn(async () => [1, 0]);
    const store = new FakeCentroidStore();
    const annIndex = {
      nearest: vi.fn(async () => [{ label: 'from-ann', score: 0.99 }]),
    };
    const idx = await buildPersistentCentroids(
      [embPolicy({ code: ['write a function'] })],
      { embed },
      store,
      'm1',
      annIndex,
    );
    // The embed+persist work still ran (the ANN table is populated by save)...
    expect(embed).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    // ...but the SERVED index is the ANN one, not an InMemoryCentroidIndex.
    expect(idx).toBe(annIndex);
    expect((await idx.nearest('p', [1, 0], 1))[0]?.label).toBe('from-ann');
  });
});
