import { describe, expect, it } from 'vitest';

import { extractVariables, MissingVariablesError, renderPrompt } from './render';
import { InMemoryPromptRegistry, PromptNameConflictError, verifyChain } from './registry';

describe('renderPrompt', () => {
  it('substitutes placeholders and tolerates surrounding whitespace', () => {
    expect(renderPrompt('Hi {{name}}, from {{ team }}', { name: 'Ada', team: 'infra' })).toBe(
      'Hi Ada, from infra',
    );
  });

  it('throws listing every missing variable', () => {
    try {
      renderPrompt('{{a}} {{b}} {{a}}', { a: 'x' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingVariablesError);
      expect((e as MissingVariablesError).missing).toEqual(['b']);
    }
  });

  it('extractVariables returns a sorted, deduped set', () => {
    expect(extractVariables('{{z}} {{a}} {{z}}')).toEqual(['a', 'z']);
    expect(extractVariables('no vars here')).toEqual([]);
  });
});

describe('renderPrompt — own properties only', () => {
  it('does not resolve prototype members as variables', () => {
    expect(() => renderPrompt('{{constructor}}', {})).toThrow(MissingVariablesError);
    expect(renderPrompt('{{constructor}}', { constructor: 'x' })).toBe('x');
  });
});

describe('InMemoryPromptRegistry', () => {
  const args = (body: string, by = 'admin') => ({ body, createdBy: by });

  it('creates v1 with derived variables and a genesis chain link', async () => {
    const r = new InMemoryPromptRegistry();
    const t = await r.create('ws_1', 'greeting', args('Hello {{name}}'));
    expect(t.versions).toHaveLength(1);
    const v1 = t.versions[0]!;
    expect(v1.version).toBe(1);
    expect(v1.variables).toEqual(['name']);
    expect(v1.prevHash).toBeNull();
    expect(v1.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a duplicate name in the same workspace but allows it across workspaces', async () => {
    const r = new InMemoryPromptRegistry();
    await r.create('ws_1', 'greeting', args('a'));
    await expect(r.create('ws_1', 'greeting', args('b'))).rejects.toThrow(PromptNameConflictError);
    await expect(r.create('ws_2', 'greeting', args('b'))).resolves.toBeDefined();
  });

  it('appends versions that chain to the previous head', async () => {
    const r = new InMemoryPromptRegistry();
    const t = await r.create('ws_1', 'p', args('v1 {{x}}'));
    const v2 = (await r.addVersion(t.id, args('v2 {{x}} {{y}}')))!;
    expect(v2.version).toBe(2);
    expect(v2.prevHash).toBe(t.versions[0]!.hash);
    expect(v2.variables).toEqual(['x', 'y']);
    expect((await r.head(t.id))!.version).toBe(2);
    expect((await r.version(t.id, 1))!.body).toBe('v1 {{x}}');
  });

  it('verifies an intact chain and detects tampering of the body, the author or the timestamp', async () => {
    const r = new InMemoryPromptRegistry();
    const t = await r.create('ws_1', 'p', args('one'));
    await r.addVersion(t.id, args('two', 'bob'));
    await r.addVersion(t.id, args('three'));
    expect(await r.verifyChain(t.id)).toEqual({ verified: true, count: 3 });

    // Tamper with the historical v2 body — the recompute must fail at v2.
    const live = (await r.get(t.id))!;
    const v2 = live.versions[1]!;
    const body = v2.body;
    v2.body = 'HACKED';
    expect((await r.verifyChain(t.id))!.brokenAt).toBe(2);
    v2.body = body;
    expect((await r.verifyChain(t.id))!.verified).toBe(true);
    // Rewriting WHO authored it (or when) is tampering too.
    v2.createdBy = 'alice';
    expect((await r.verifyChain(t.id))!.brokenAt).toBe(2);
    v2.createdBy = 'bob';
    v2.createdAt = '1999-01-01T00:00:00.000Z';
    expect((await r.verifyChain(t.id))!.brokenAt).toBe(2);
  });

  it('lists secret-free summaries scoped to workspaces', async () => {
    const r = new InMemoryPromptRegistry();
    await r.create('ws_1', 'a', args('x'));
    const b = await r.create('ws_2', 'b', args('y'));
    await r.addVersion(b.id, args('y2'));
    expect(await r.list('*')).toHaveLength(2);
    const only2 = await r.list(['ws_2']);
    expect(only2).toHaveLength(1);
    expect(only2[0]).toMatchObject({ name: 'b', latestVersion: 2 });
    expect(only2[0]).not.toHaveProperty('body');
  });

  it('deletes a template', async () => {
    const r = new InMemoryPromptRegistry();
    const t = await r.create('ws_1', 'p', args('x'));
    expect(await r.delete(t.id)).toBe(true);
    expect(await r.get(t.id)).toBeUndefined();
    expect(await r.verifyChain(t.id)).toBeUndefined();
  });

  it('verifyChain flags a reordered/renumbered version', async () => {
    const r = new InMemoryPromptRegistry();
    const t = await r.create('ws_1', 'p', args('one'));
    await r.addVersion(t.id, args('two'));
    (await r.get(t.id))!.versions[1]!.version = 5; // break monotonicity
    expect(verifyChain((await r.get(t.id))!.versions).verified).toBe(false);
  });
});
