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

describe('InMemoryPromptRegistry', () => {
  const args = (body: string, by = 'admin') => ({ body, createdBy: by });

  it('creates v1 with derived variables and a genesis chain link', () => {
    const r = new InMemoryPromptRegistry();
    const t = r.create('ws_1', 'greeting', args('Hello {{name}}'));
    expect(t.versions).toHaveLength(1);
    const v1 = t.versions[0]!;
    expect(v1.version).toBe(1);
    expect(v1.variables).toEqual(['name']);
    expect(v1.prevHash).toBeNull();
    expect(v1.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a duplicate name in the same workspace but allows it across workspaces', () => {
    const r = new InMemoryPromptRegistry();
    r.create('ws_1', 'greeting', args('a'));
    expect(() => r.create('ws_1', 'greeting', args('b'))).toThrow(PromptNameConflictError);
    expect(() => r.create('ws_2', 'greeting', args('b'))).not.toThrow();
  });

  it('appends versions that chain to the previous head', () => {
    const r = new InMemoryPromptRegistry();
    const t = r.create('ws_1', 'p', args('v1 {{x}}'));
    const v2 = r.addVersion(t.id, args('v2 {{x}} {{y}}'))!;
    expect(v2.version).toBe(2);
    expect(v2.prevHash).toBe(t.versions[0]!.hash);
    expect(v2.variables).toEqual(['x', 'y']);
    expect(r.head(t.id)!.version).toBe(2);
    expect(r.version(t.id, 1)!.body).toBe('v1 {{x}}');
  });

  it('verifies an intact chain and detects tampering', () => {
    const r = new InMemoryPromptRegistry();
    const t = r.create('ws_1', 'p', args('one'));
    r.addVersion(t.id, args('two'));
    r.addVersion(t.id, args('three'));
    expect(r.verifyChain(t.id)).toEqual({ verified: true, count: 3 });

    // Tamper with the historical v2 body — the recompute must fail at v2.
    r.get(t.id)!.versions[1]!.body = 'HACKED';
    const bad = r.verifyChain(t.id)!;
    expect(bad.verified).toBe(false);
    expect(bad.brokenAt).toBe(2);
  });

  it('lists secret-free summaries scoped to workspaces', () => {
    const r = new InMemoryPromptRegistry();
    r.create('ws_1', 'a', args('x'));
    const b = r.create('ws_2', 'b', args('y'));
    r.addVersion(b.id, args('y2'));
    expect(r.list('*')).toHaveLength(2);
    const only2 = r.list(['ws_2']);
    expect(only2).toHaveLength(1);
    expect(only2[0]).toMatchObject({ name: 'b', latestVersion: 2 });
    expect(only2[0]).not.toHaveProperty('body');
  });

  it('deletes a template', () => {
    const r = new InMemoryPromptRegistry();
    const t = r.create('ws_1', 'p', args('x'));
    expect(r.delete(t.id)).toBe(true);
    expect(r.get(t.id)).toBeUndefined();
    expect(r.verifyChain(t.id)).toBeUndefined();
  });

  it('verifyChain flags a reordered/renumbered version', () => {
    const r = new InMemoryPromptRegistry();
    const t = r.create('ws_1', 'p', args('one'));
    r.addVersion(t.id, args('two'));
    r.get(t.id)!.versions[1]!.version = 5; // break monotonicity
    expect(verifyChain(r.get(t.id)!.versions).verified).toBe(false);
  });
});
