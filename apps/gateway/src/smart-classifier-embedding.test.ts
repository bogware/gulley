import type { SmartRoutingPolicy } from '@gulley/routing';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEmbeddingCentroids,
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
