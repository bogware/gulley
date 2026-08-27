import { describe, expect, it, vi } from 'vitest';
import {
  type ClassifierBreaker,
  type ClassifierCompleter,
  classifyRequest,
  runRules,
} from './smart-classifier';
import type { ClassifierSpec, SmartRoutingPolicy } from './smart-router';

function policy(classifier: ClassifierSpec, routes: Record<string, string>): SmartRoutingPolicy {
  return {
    name: 'p',
    objective: 'cost-tier',
    classifier,
    categoryRoutes: routes,
    selector: {},
  };
}

describe('runRules', () => {
  it('matches by maxChars, anyOf (case-insensitive), and regex; first match wins', () => {
    const rules = [
      { category: 'short', maxChars: 10 },
      { category: 'code', anyOf: ['function', 'SELECT'] },
      { category: 'q', regex: '\\?$' },
    ];
    expect(runRules(rules, 'hi')).toBe('short');
    expect(runRules(rules, 'please write a function for me')).toBe('code');
    expect(runRules(rules, 'run this select statement now')).toBe('code');
    expect(runRules(rules, 'is this a valid approach?')).toBe('q');
    expect(runRules(rules, 'a plain declarative sentence')).toBeUndefined();
  });

  it('skips a malformed regex rather than throwing', () => {
    expect(runRules([{ category: 'x', regex: '(' }], 'anything')).toBeUndefined();
  });
});

describe('classifyRequest — rules-then-llm', () => {
  it('returns a rule match without calling the model', async () => {
    const complete = vi.fn(async () => ({ text: 'unused' }));
    const cat = await classifyRequest(
      policy(
        { mode: 'rules-then-llm', rules: [{ category: 'cheap', maxChars: 50 }], model: 'm' },
        {
          cheap: 'small',
        },
      ),
      'short prompt',
      { completer: { complete } },
    );
    expect(cat).toBe('cheap');
    expect(complete).not.toHaveBeenCalled();
  });

  it('escalates to the model when no rule matches', async () => {
    const cat = await classifyRequest(
      policy(
        { mode: 'rules-then-llm', rules: [{ category: 'cheap', maxChars: 3 }], model: 'm' },
        {
          cheap: 'small',
          hard: 'frontier',
        },
      ),
      'a long enough prompt to skip the maxChars rule',
      { completer: { complete: async () => ({ text: 'hard' }) } },
    );
    expect(cat).toBe('hard');
  });

  it('abstains (undefined) when no rule matches and no model is configured', async () => {
    const cat = await classifyRequest(
      policy(
        { mode: 'rules-then-llm', rules: [{ category: 'cheap', maxChars: 3 }] },
        {
          cheap: 'small',
        },
      ),
      'a longer prompt',
      {},
    );
    expect(cat).toBeUndefined();
  });
});

describe('classifyRequest — llm-router', () => {
  const p = policy({ mode: 'llm-router', model: 'router-mini' }, { code: 'a', prose: 'b' });

  it('maps a completion to a candidate label (exact or contained)', async () => {
    expect(
      await classifyRequest(p, 'x', { completer: { complete: async () => ({ text: 'code' }) } }),
    ).toBe('code');
    expect(
      await classifyRequest(p, 'x', {
        completer: { complete: async () => ({ text: 'The category is: prose.' }) },
      }),
    ).toBe('prose');
  });

  it('abstains when the completion matches no label, or no completer is wired', async () => {
    expect(
      await classifyRequest(p, 'x', {
        completer: { complete: async () => ({ text: 'nonsense' }) },
      }),
    ).toBeUndefined();
    expect(await classifyRequest(p, 'x', {})).toBeUndefined();
  });

  it('abstains when the policy has no model', async () => {
    const noModel = policy({ mode: 'llm-router' }, { a: 'x' });
    expect(
      await classifyRequest(noModel, 'x', { completer: { complete: async () => ({ text: 'a' }) } }),
    ).toBeUndefined();
  });

  it('reports the sub-call usage to the spend sink for metering', async () => {
    const spends: unknown[] = [];
    const cat = await classifyRequest(
      p,
      'x',
      {
        completer: {
          complete: async () => ({
            text: 'code',
            usage: {
              provider: 'anthropic',
              model: 'router-mini',
              inputTokens: 12,
              outputTokens: 1,
            },
          }),
        },
      },
      undefined,
      (u) => spends.push(u),
    );
    expect(cat).toBe('code');
    expect(spends).toEqual([
      { provider: 'anthropic', model: 'router-mini', inputTokens: 12, outputTokens: 1 },
    ]);
  });
});

describe('classifyRequest — embedding-nearest-label', () => {
  const p = policy(
    { mode: 'embedding-nearest-label', labels: ['safe', 'risky'] },
    {
      safe: 'a',
      risky: 'b',
    },
  );
  const embedder = { embed: async () => [0.1, 0.2, 0.3] };

  it('returns the nearest label above the similarity threshold', async () => {
    const cat = await classifyRequest(p, 'x', {
      embedder,
      centroids: { nearest: async () => [{ label: 'risky', score: 0.8 }] },
      similarityThreshold: 0.6,
    });
    expect(cat).toBe('risky');
  });

  it('abstains below the threshold, or when a port is missing', async () => {
    expect(
      await classifyRequest(p, 'x', {
        embedder,
        centroids: { nearest: async () => [{ label: 'risky', score: 0.4 }] },
        similarityThreshold: 0.6,
      }),
    ).toBeUndefined();
    expect(await classifyRequest(p, 'x', { embedder })).toBeUndefined(); // no centroids
  });
});

describe('classifyRequest — resilience', () => {
  it('returns undefined and records a breaker failure on timeout', async () => {
    const records: Array<[string, boolean]> = [];
    const breaker: ClassifierBreaker = {
      isOpen: () => false,
      record: (k, ok) => records.push([k, ok]),
    };
    // A completer that never resolves on its own — it rejects only when aborted.
    const completer: ClassifierCompleter = {
      complete: (_m, _p, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
    const cat = await classifyRequest(
      policy({ mode: 'llm-router', model: 'm', timeoutMs: 15 }, { a: 'x' }),
      'x',
      { completer, breaker },
    );
    expect(cat).toBeUndefined();
    expect(records).toContainEqual(['smart:p', false]);
  });

  it('skips the classifier entirely when the breaker is open', async () => {
    const complete = vi.fn(async () => ({ text: 'a' }));
    const breaker: ClassifierBreaker = { isOpen: () => true, record: () => {} };
    const cat = await classifyRequest(policy({ mode: 'llm-router', model: 'm' }, { a: 'x' }), 'x', {
      completer: { complete },
      breaker,
    });
    expect(cat).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('records a breaker success on a clean classification', async () => {
    const records: Array<[string, boolean]> = [];
    const breaker: ClassifierBreaker = {
      isOpen: () => false,
      record: (k, ok) => records.push([k, ok]),
    };
    await classifyRequest(policy({ mode: 'llm-router', model: 'm' }, { a: 'x' }), 'x', {
      completer: { complete: async () => ({ text: 'a' }) },
      breaker,
    });
    expect(records).toContainEqual(['smart:p', true]);
  });
});
