import { describe, expect, it, vi } from 'vitest';

import { PostgresCentroidIndex } from './centroid-store';
import type { Database } from './db';

/** A stub Database whose `execute` returns canned ANN rows and records the SQL. */
function stubDb(rows: unknown, onExecute?: (query: unknown) => void): Database {
  return {
    execute: vi.fn(async (query: unknown) => {
      onExecute?.(query);
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  } as unknown as Database;
}

describe('PostgresCentroidIndex.nearest', () => {
  it('maps ANN rows to {label, score} and binds scope + model into the query', async () => {
    const params: unknown[] = [];
    const db = stubDb([{ label: 'code', score: 0.91 }], (q) => {
      // drizzle sql`` carries its interpolated params — assert scope + model are bound.
      params.push(...((q as { queryChunks?: unknown[] }).queryChunks ?? []));
    });
    const idx = new PostgresCentroidIndex(db, 'text-embedding-3-small');
    const out = await idx.nearest('policy-A', [0.1, 0.2, 0.3], 1);
    expect(out).toEqual([{ label: 'code', score: 0.91 }]);
    const flat = JSON.stringify(params);
    expect(flat).toContain('policy-A');
    expect(flat).toContain('text-embedding-3-small');
  });

  it('coerces the score to a number', async () => {
    const db = stubDb([{ label: 'x', score: '0.5' }]);
    const out = await new PostgresCentroidIndex(db, 'm').nearest('s', [1, 2], 3);
    expect(out[0]).toEqual({ label: 'x', score: 0.5 });
  });

  it('fails open (returns []) when the query throws', async () => {
    const db = stubDb(new Error('connection reset'));
    const out = await new PostgresCentroidIndex(db, 'm').nearest('s', [1, 2], 1);
    expect(out).toEqual([]);
  });
});
