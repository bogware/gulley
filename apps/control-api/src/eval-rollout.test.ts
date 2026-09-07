import { describe, expect, it } from 'vitest';
import {
  decideRollout,
  type EvalResult,
  type EvalSuite,
  runScorer,
  scoreCase,
  type RolloutTarget,
} from './eval-rollout';

const base: EvalResult = {
  outputText: '',
  stopReason: 'end_turn',
  inputTokens: 10,
  outputTokens: 20,
  costMicroUsd: 100,
  latencyMs: 500,
  guardrailFlagged: false,
};

describe('runScorer', () => {
  it('contains (present/absent)', () => {
    expect(
      runScorer({ kind: 'contains', text: 'yes' }, { ...base, outputText: 'oh yes!' }).pass,
    ).toBe(true);
    expect(
      runScorer({ kind: 'contains', text: 'no' }, { ...base, outputText: 'oh yes!' }).pass,
    ).toBe(false);
    expect(
      runScorer(
        { kind: 'contains', text: 'secret', expect: 'absent' },
        { ...base, outputText: 'clean' },
      ).pass,
    ).toBe(true);
  });

  it('regex, and fails closed on an invalid pattern', () => {
    expect(
      runScorer({ kind: 'regex', pattern: '^\\d+$' }, { ...base, outputText: '12345' }).pass,
    ).toBe(true);
    expect(
      runScorer({ kind: 'regex', pattern: '^\\d+$' }, { ...base, outputText: 'nope' }).pass,
    ).toBe(false);
    expect(runScorer({ kind: 'regex', pattern: '(' }, base).pass).toBe(false); // invalid → fail closed
  });

  it('json-valid with required keys', () => {
    expect(runScorer({ kind: 'json-valid' }, { ...base, outputText: '{"a":1}' }).pass).toBe(true);
    expect(runScorer({ kind: 'json-valid' }, { ...base, outputText: 'not json' }).pass).toBe(false);
    expect(
      runScorer({ kind: 'json-valid', requireKeys: ['a', 'b'] }, { ...base, outputText: '{"a":1}' })
        .pass,
    ).toBe(false);
    expect(
      runScorer(
        { kind: 'json-valid', requireKeys: ['a', 'b'] },
        { ...base, outputText: '{"a":1,"b":2}' },
      ).pass,
    ).toBe(true);
  });

  it('cost / latency / output-token ceilings', () => {
    expect(runScorer({ kind: 'max-cost-micro-usd', limit: 100 }, base).pass).toBe(true);
    expect(runScorer({ kind: 'max-cost-micro-usd', limit: 99 }, base).pass).toBe(false);
    expect(
      runScorer({ kind: 'max-cost-micro-usd', limit: 100 }, { ...base, costMicroUsd: null }).pass,
    ).toBe(false);
    expect(runScorer({ kind: 'max-latency-ms', limit: 500 }, base).pass).toBe(true);
    expect(runScorer({ kind: 'max-latency-ms', limit: 499 }, base).pass).toBe(false);
    expect(runScorer({ kind: 'max-output-tokens', limit: 20 }, base).pass).toBe(true);
    expect(runScorer({ kind: 'max-output-tokens', limit: 19 }, base).pass).toBe(false);
  });

  it('not-refused / guardrail-clean', () => {
    expect(runScorer({ kind: 'not-refused' }, base).pass).toBe(true);
    expect(runScorer({ kind: 'not-refused' }, { ...base, stopReason: 'refusal' }).pass).toBe(false);
    expect(runScorer({ kind: 'guardrail-clean' }, base).pass).toBe(true);
    expect(runScorer({ kind: 'guardrail-clean' }, { ...base, guardrailFlagged: true }).pass).toBe(
      false,
    );
  });
});

describe('scoreCase', () => {
  const c = {
    id: 'c1',
    request: { messages: [{ role: 'user', content: 'hi' }] },
    scorers: [
      { scorer: { kind: 'contains', text: 'ok' } as const },
      { scorer: { kind: 'not-refused' } as const },
    ],
  };

  it('passes only when every scorer passes', () => {
    expect(scoreCase(c, { ...base, outputText: 'ok' }).pass).toBe(true);
    expect(scoreCase(c, { ...base, outputText: 'no' }).pass).toBe(false);
  });

  it('a run error fails the case without scoring (ran:false)', () => {
    const s = scoreCase(c, { ...base, error: 'upstream 503' });
    expect(s.ran).toBe(false);
    expect(s.pass).toBe(false);
    expect(s.error).toBe('upstream 503');
  });
});

const target: RolloutTarget = {
  workspaceId: 'ws1',
  orgId: 'org1',
  alias: 'default',
  fromModel: 'model-old',
  toModel: 'model-new',
};

const suite: EvalSuite = {
  id: 'suite1',
  name: 'smoke',
  cases: [
    {
      id: 'a',
      request: { messages: [{ role: 'user', content: '2+2?' }] },
      scorers: [{ scorer: { kind: 'contains', text: '4' } }],
    },
    {
      id: 'b',
      request: { messages: [{ role: 'user', content: 'ok?' }] },
      scorers: [{ scorer: { kind: 'not-refused' } }],
    },
  ],
};

const R = (text: string, over: Partial<EvalResult> = {}): EvalResult => ({
  ...base,
  outputText: text,
  ...over,
});

describe('decideRollout', () => {
  it('promotes when the candidate passes all cases and does not regress', () => {
    const incumbent = new Map([
      ['a', R('4')],
      ['b', R('sure')],
    ]);
    const candidate = new Map([
      ['a', R('4')],
      ['b', R('sure')],
    ]);
    const rep = decideRollout(suite, target, incumbent, candidate);
    expect(rep.decision).toBe('promote');
    expect(rep.candidate.passRate).toBe(1);
  });

  it('holds when the candidate regresses on a case the incumbent passed', () => {
    const incumbent = new Map([
      ['a', R('4')],
      ['b', R('sure')],
    ]);
    const candidate = new Map([
      ['a', R('four')],
      ['b', R('sure')],
    ]); // 'a' no longer contains "4"
    const rep = decideRollout(suite, target, incumbent, candidate);
    expect(rep.decision).toBe('hold');
    expect(rep.reasons.join(' ')).toMatch(/regressed on 1 case/);
  });

  it('holds when candidate pass-rate is below the threshold', () => {
    const incumbent = new Map([
      ['a', R('nope')],
      ['b', R('sure')],
    ]); // incumbent already fails 'a'
    const candidate = new Map([
      ['a', R('nope')],
      ['b', R('sure')],
    ]);
    const rep = decideRollout(suite, target, incumbent, candidate, { minPassRate: 1.0 });
    expect(rep.decision).toBe('hold'); // 50% < 100%
  });

  it('promotes an improvement even if the incumbent was failing (no regression possible)', () => {
    const incumbent = new Map([
      ['a', R('nope')],
      ['b', R('sure')],
    ]); // incumbent fails 'a'
    const candidate = new Map([
      ['a', R('4')],
      ['b', R('sure')],
    ]); // candidate fixes 'a'
    const rep = decideRollout(suite, target, incumbent, candidate, { minPassRate: 1.0 });
    expect(rep.decision).toBe('promote');
  });

  it('gates on a cost-regression band when configured', () => {
    const incumbent = new Map([
      ['a', R('4', { costMicroUsd: 100 })],
      ['b', R('sure', { costMicroUsd: 100 })],
    ]);
    const candidate = new Map([
      ['a', R('4', { costMicroUsd: 130 })],
      ['b', R('sure', { costMicroUsd: 130 })],
    ]);
    // +30% cost, band allows +5% → hold
    expect(
      decideRollout(suite, target, incumbent, candidate, { maxCostRegressionBps: 500 }).decision,
    ).toBe('hold');
    // band allows +50% → promote
    expect(
      decideRollout(suite, target, incumbent, candidate, { maxCostRegressionBps: 5000 }).decision,
    ).toBe('promote');
  });

  it('never promotes on an empty suite', () => {
    const empty: EvalSuite = { id: 's0', name: 'empty', cases: [] };
    const rep = decideRollout(empty, target, new Map(), new Map());
    expect(rep.decision).toBe('hold');
  });

  it('a candidate run error counts as a failed case (holds)', () => {
    const incumbent = new Map([
      ['a', R('4')],
      ['b', R('sure')],
    ]);
    const candidate = new Map([
      ['a', R('4')],
      ['b', R('', { error: 'timeout' })],
    ]);
    expect(decideRollout(suite, target, incumbent, candidate).decision).toBe('hold');
  });
});
