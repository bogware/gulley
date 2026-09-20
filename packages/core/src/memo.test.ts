import { describe, expect, it } from 'vitest';
import { LuaScript, type ScriptRedis } from './lua';
import { memoizeAsync } from './memo';

describe('memoizeAsync', () => {
  it('serves a fresh value within the TTL and re-resolves after it', async () => {
    let t = 0;
    let calls = 0;
    const f = memoizeAsync(
      async (k: string) => {
        calls += 1;
        return `${k}:${calls}`;
      },
      { ttlMs: 100, now: () => t },
    );
    expect(await f('a')).toBe('a:1');
    expect(await f('a')).toBe('a:1');
    t = 150;
    expect(await f('a')).toBe('a:2');
    expect(calls).toBe(2);
  });

  it('serves the stale value while the resolver fails, then rethrows past the stale window', async () => {
    let t = 0;
    let fail = false;
    const errors: unknown[] = [];
    const f = memoizeAsync(
      async () => {
        if (fail) throw new Error('db down');
        return 'v';
      },
      { ttlMs: 10, staleOnErrorMs: 1_000, now: () => t, onError: (e) => errors.push(e) },
    );
    expect(await f('k')).toBe('v');
    fail = true;
    t = 50; // past TTL, inside the stale window
    expect(await f('k')).toBe('v');
    expect(errors).toHaveLength(1);
    t = 5_000; // past the stale window
    await expect(f('k')).rejects.toThrow('db down');
  });

  it('coalesces concurrent misses into one resolver call', async () => {
    let calls = 0;
    const f = memoizeAsync(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return calls;
    });
    const [a, b, c] = await Promise.all([f('x'), f('x'), f('x')]);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });
});

describe('LuaScript', () => {
  it('runs EVALSHA and falls back to EVAL exactly once on NOSCRIPT', async () => {
    const calls: string[] = [];
    let loaded = false;
    const redis: ScriptRedis = {
      async eval(script) {
        calls.push('eval');
        loaded = true;
        return script.length;
      },
      async evalsha() {
        calls.push('evalsha');
        if (!loaded) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
        return 42;
      },
    };
    const s = new LuaScript('return 1');
    expect(s.sha).toMatch(/^[0-9a-f]{40}$/);
    await s.run(redis, 0);
    await s.run(redis, 0);
    expect(calls).toEqual(['evalsha', 'eval', 'evalsha']);
  });

  it('uses EVAL when the client has no evalsha, and propagates other errors', async () => {
    const plain: ScriptRedis = { eval: async () => 'ok' };
    expect(await new LuaScript('x').run(plain, 0)).toBe('ok');
    const broken: ScriptRedis = {
      eval: async () => 'never',
      evalsha: async () => {
        throw new Error('ERR value is not an integer');
      },
    };
    await expect(new LuaScript('x').run(broken, 0)).rejects.toThrow(/not an integer/);
  });
});
