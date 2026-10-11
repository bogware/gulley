import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelCatalog } from './catalog';
import { watchCatalogFile } from './watch';

const rows = (input: number) => [{ provider: 'anthropic', model: 'claude-x', input, output: 1 }];

let bumps = 0;
/** Write, then push mtime forward by whole seconds so a coarse-grained filesystem
 *  clock (1–2 s on some) still sees a change. */
function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  bumps += 1;
  const t = new Date(Date.now() + bumps * 5_000);
  utimesSync(path, t, t);
}

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watchCatalogFile', () => {
  const stops: Array<() => void> = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gulley-watch-'));
    dirs.push(dir);
    return join(dir, 'catalog.json');
  }

  it('reloads on an mtime change and keeps the old catalog across a bad write', async () => {
    const path = tmp();
    write(path, JSON.stringify(rows(1)));
    const seen: ModelCatalog[] = [];
    const logs: string[] = [];
    const stop = watchCatalogFile(path, (c) => seen.push(c), {
      intervalMs: 20,
      log: (m) => logs.push(m),
    });
    stops.push(stop);

    await sleep(80);
    expect(seen).toHaveLength(0); // unchanged file → no reload

    write(path, JSON.stringify(rows(2)));
    await waitFor(() => seen.length === 1);
    expect(seen[0]?.lookup('anthropic', 'claude-x')?.input).toBe(2);
    expect(logs.at(-1)).toMatch(/reloaded .* \(1 models\)/);

    // A half-written / malformed file: logged, previous catalog kept, nothing thrown.
    write(path, '{ "not": "json');
    await waitFor(() => logs.some((l) => /failed; keeping previous catalog/.test(l)));
    expect(seen).toHaveLength(1);

    // A malformed ROW (valid JSON) is also rejected whole.
    write(path, JSON.stringify([{ provider: 'anthropic', model: 'claude-x', input: 'x' }]));
    await waitFor(() => logs.filter((l) => /failed; keeping previous/.test(l)).length >= 2);
    expect(seen).toHaveLength(1);

    // The next good write recovers.
    write(path, JSON.stringify(rows(3)));
    await waitFor(() => seen.length === 2);
    expect(seen[1]?.lookup('anthropic', 'claude-x')?.input).toBe(3);

    stop();
    write(path, JSON.stringify(rows(4)));
    await sleep(80);
    expect(seen).toHaveLength(2); // stopped → no further reloads
  });

  it('reloads INTO an existing instance, keeping its overrides', async () => {
    const path = tmp();
    write(path, JSON.stringify(rows(1)));
    const cat = new ModelCatalog(rows(1));
    cat.setOverrides([{ provider: 'bedrock', model: 'claude-opus-5-5', input: 3, output: 15 }]);
    const seen: ModelCatalog[] = [];
    stops.push(watchCatalogFile(path, (c) => seen.push(c), { intervalMs: 20, into: cat }));

    write(path, JSON.stringify(rows(2)));
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toBe(cat);
    expect(cat.lookup('anthropic', 'claude-x')?.input).toBe(2);
    expect(cat.lookup('bedrock', 'claude-opus-5-5')?.input).toBe(3);
  });

  it('tolerates a file that appears later or disappears', async () => {
    const path = tmp();
    const seen: ModelCatalog[] = [];
    const logs: string[] = [];
    stops.push(
      watchCatalogFile(path, (c) => seen.push(c), { intervalMs: 20, log: (m) => logs.push(m) }),
    );
    await sleep(60);
    expect(seen).toHaveLength(0);
    write(path, JSON.stringify(rows(1)));
    await waitFor(() => seen.length === 1);
    rmSync(path);
    await waitFor(() => logs.some((l) => /disappeared; keeping previous/.test(l)));
    expect(seen).toHaveLength(1);
    write(path, JSON.stringify(rows(2)));
    await waitFor(() => seen.length === 2);
  });

  it('rejects a non-positive interval up front', () => {
    expect(() => watchCatalogFile('x', () => {}, { intervalMs: 0 })).toThrow(RangeError);
    expect(() => watchCatalogFile('x', () => {}, { intervalMs: Number.NaN })).toThrow(RangeError);
  });
});
