import { describe, expect, it } from 'vitest';
import {
  computeAnthropicCost,
  computeCost,
  lookupRate,
  normalizeModelId,
  toMicroUsd,
  type NormalizedUsage,
} from './index';

describe('pricing', () => {
  it('normalizes Bedrock prefixes and dated snapshots to the base model id', () => {
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeModelId('claude-opus-5')).toBe('claude-opus-5');
    // The Messages API reports dated ids; pricing is keyed by the alias.
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    // A minor version like -4-8 must NOT be mistaken for a date suffix.
    expect(normalizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('prices a dated model id via alias normalization', () => {
    const c = computeAnthropicCost('claude-haiku-4-5-20251001', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(c.priced).toBe(true);
    expect(c.totalUsd).toBeCloseTo(6, 6); // $1 in + $5 out
  });

  it('prices known models and skips unknown ones', () => {
    expect(lookupRate('claude-opus-5')).toEqual({ input: 5, output: 25 });
    expect(lookupRate('gpt-4')).toBeUndefined();
  });
});

describe('computeAnthropicCost', () => {
  it('meters from the raw usage object with cache-inclusive input', () => {
    // 1M uncached input, 1M output on Opus-5 => $5 + $25 = $30.
    const c = computeAnthropicCost('claude-opus-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(c.priced).toBe(true);
    expect(c.totalUsd).toBeCloseTo(30, 6);
    expect(c.totalInputTokens).toBe(1_000_000);
  });

  it('applies cache read/write multipliers on the input rate', () => {
    // Sonnet 4.6 input $3/MTok. read x0.1 => $0.30; write5m x1.25 => $3.75 per MTok.
    const c = computeAnthropicCost('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(c.cacheReadUsd).toBeCloseTo(0.3, 6);
    expect(c.cacheWriteUsd).toBeCloseTo(3.75, 6);
    expect(c.totalInputTokens).toBe(2_000_000);
  });

  it('honors the per-TTL cache-creation breakdown when present', () => {
    // Opus-5 input $5. 1M @1h x2.0 => $10.
    const c = computeAnthropicCost('claude-opus-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
    });
    expect(c.cacheWriteUsd).toBeCloseTo(10, 6);
  });

  it('still meters tokens for an unpriced model', () => {
    const c = computeAnthropicCost('some-future-model', {
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(c.priced).toBe(false);
    expect(c.totalUsd).toBe(0);
    expect(c.outputTokens).toBe(50);
  });

  it('converts USD to micro-dollars for the ledger', () => {
    expect(toMicroUsd(30)).toBe(30_000_000);
    expect(toMicroUsd(0.0000005)).toBe(1);
  });
});

describe('computeCost (provider-generic)', () => {
  it('prices OpenAI usage with the cached-input discount and no cache-write charge', () => {
    // gpt-4o-mini: $0.15 in / $0.60 out; cached read at 0.5x.
    const c = computeCost('openai', 'gpt-4o-mini', {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 1_000_000,
      seen: true,
    });
    expect(c.priced).toBe(true);
    expect(c.inputUsd).toBeCloseTo(0.15, 6);
    expect(c.cacheReadUsd).toBeCloseTo(0.075, 6);
    expect(c.cacheWriteUsd).toBe(0);
    expect(c.outputUsd).toBeCloseTo(0.6, 6);
    expect(c.totalInputTokens).toBe(2_000_000);
  });

  it('reports prompt-cache dollars saved for cache_read tokens', () => {
    // gpt-4o-mini input $0.15/MTok, cache-read at 0.5x. 1M cache-read tokens cost
    // $0.075 vs $0.15 full ⇒ $0.075 saved.
    const c = computeCost('openai', 'gpt-4o-mini', {
      inputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
      seen: true,
    });
    expect(c.cacheReadUsd).toBeCloseTo(0.075, 6);
    expect(c.cacheSavedUsd).toBeCloseTo(0.075, 6);
  });

  it('prices Gemini and Vertex from the seed (no longer $0)', () => {
    const usage = {
      inputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 1_000_000,
      seen: true,
    };
    const g = computeCost('gemini', 'gemini-2.5-flash', usage); // $0.30 in / $2.50 out
    expect(g.priced).toBe(true);
    expect(g.totalUsd).toBeCloseTo(2.8, 6);
    // Vertex shares the Gemini rates, and a models/ prefix normalizes to the alias.
    const v = computeCost('vertex', 'models/gemini-2.5-pro', usage); // $1.25 / $10
    expect(v.priced).toBe(true);
    expect(v.totalUsd).toBeCloseTo(11.25, 6);
  });

  it('normalizes OpenAI dated snapshots to the alias', () => {
    const c = computeCost('openai', 'gpt-4o-mini-2024-07-18', {
      inputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
      seen: true,
    });
    expect(c.priced).toBe(true);
    expect(c.inputUsd).toBeCloseTo(0.15, 6);
  });

  it('meters tokens for an unknown provider', () => {
    const c = computeCost('mystery', 'x', {
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 5,
      seen: true,
    });
    expect(c.priced).toBe(false);
    expect(c.outputTokens).toBe(5);
  });
});

describe('seed pricing (2026-10)', () => {
  const usage = (over: Partial<NormalizedUsage>): NormalizedUsage => ({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    seen: true,
    ...over,
  });
  const oneM = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });

  it('prices every current Anthropic model, by API id and by Bedrock id', () => {
    const current = [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-5-5',
      'claude-haiku-4-5',
    ];
    for (const m of current) {
      expect(computeCost('anthropic', m, oneM).priced, m).toBe(true);
      expect(computeCost('anthropic', `${m}-20260401`, oneM).priced, `${m} dated`).toBe(true);
      expect(
        computeCost('bedrock', `us.anthropic.${m}-20260401-v1:0`, oneM).priced,
        `${m} bedrock`,
      ).toBe(true);
    }
  });

  it('prices every current OpenAI model including embeddings', () => {
    const current = [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2',
      'gpt-5.1',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-4.1',
      'gpt-4o',
      'o3',
      'o4-mini',
      'text-embedding-3-small',
      'text-embedding-3-large',
    ];
    for (const m of current) expect(computeCost('openai', m, oneM).priced, m).toBe(true);
    const e = computeCost('openai', 'text-embedding-3-small', usage({ inputTokens: 1_000_000 }));
    expect(e.totalUsd).toBeCloseTo(0.02, 6);
  });

  it('applies per-model cache-read multipliers', () => {
    const read = usage({ cacheReadTokens: 1_000_000 });
    expect(computeCost('anthropic', 'claude-opus-5-5', read).cacheReadUsd).toBeCloseTo(0.2, 6);
    expect(computeCost('anthropic', 'claude-fable-5-1', read).cacheReadUsd).toBeCloseTo(0.25, 6);
    expect(computeCost('anthropic', 'claude-sonnet-5-5', read).cacheReadUsd).toBeCloseTo(0.2, 6);
    expect(computeCost('anthropic', 'claude-fable-5', read).cacheReadUsd).toBeCloseTo(1, 6);
    expect(computeCost('openai', 'gpt-5', read).cacheReadUsd).toBeCloseTo(0.125, 6);
    expect(computeCost('openai', 'gpt-4.1', read).cacheReadUsd).toBeCloseTo(0.5, 6);
    expect(computeCost('openai', 'o3', read).cacheReadUsd).toBeCloseTo(0.5, 6);
    expect(computeCost('openai', 'gpt-5-pro', read).cacheReadUsd).toBeCloseTo(15, 6);
    // Cache writes keep the Anthropic provider default (1.25x / 2x) under a per-model read.
    const write = usage({ cacheWrite5mTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 });
    expect(computeCost('anthropic', 'claude-opus-5-5', write).cacheWriteUsd).toBeCloseTo(13, 6);
  });

  it('bills Sonnet 5 at the $2/$10 list price (was seeded at $3/$15)', () => {
    const c = computeCost('anthropic', 'claude-sonnet-5', oneM);
    expect(c.inputUsd).toBeCloseTo(2, 6);
    expect(c.outputUsd).toBeCloseTo(10, 6);
  });

  it('bills the whole request at the long-context tier past the threshold', () => {
    // Haiku 5.5: $0.10/$0.50 up to 100K input, $0.50/$2.50 above.
    const short = computeCost('anthropic', 'claude-haiku-5-5', usage({ inputTokens: 50_000 }));
    expect(short.inputUsd).toBeCloseTo(0.005, 9);
    const long = computeCost(
      'anthropic',
      'claude-haiku-5-5',
      usage({ inputTokens: 150_000, outputTokens: 1_000 }),
    );
    expect(long.inputUsd).toBeCloseTo(0.075, 9);
    expect(long.outputUsd).toBeCloseTo(0.0025, 9);
    // Cache-read tokens count toward the threshold (total billable input).
    const viaCache = computeCost(
      'anthropic',
      'claude-haiku-5-5',
      usage({ inputTokens: 10_000, cacheReadTokens: 100_000 }),
    );
    expect(viaCache.inputUsd).toBeCloseTo(0.005, 9);
    // gpt-5.6-sol: $4/$20 up to 272K input, $8/$30 above; cached input stays 0.1x.
    const sol = computeCost(
      'openai',
      'gpt-5.6-sol',
      usage({ inputTokens: 300_000, cacheReadTokens: 100_000, outputTokens: 1_000 }),
    );
    expect(sol.inputUsd).toBeCloseTo(2.4, 6);
    expect(sol.cacheReadUsd).toBeCloseTo(0.08, 6);
    expect(sol.outputUsd).toBeCloseTo(0.03, 6);
  });
});

describe('long-context tier under a catalog override', () => {
  it('applies the seed tier when the catalog resolves a flat rate for the same model', () => {
    // models.dev carries no tier data, so a catalog row is flat; the provider still bills
    // the whole request at the tier rate past the threshold.
    const resolve = (provider: string, model: string) =>
      provider === 'anthropic' && model === 'claude-haiku-5-5'
        ? { input: 0.1, output: 0.5 }
        : undefined;
    const usage = {
      inputTokens: 150_000,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 1_000,
      seen: true,
    };
    const c = computeCost('anthropic', 'claude-haiku-5-5', usage, resolve);
    expect(c.priced).toBe(true);
    expect(c.inputUsd).toBeCloseTo(0.075, 9); // 150K x $0.50/MTok, not $0.10
    expect(c.outputUsd).toBeCloseTo(0.0025, 9); // 1K x $2.50/MTok, not $0.50
    // Below the threshold the override's flat rate applies as-is.
    const short = computeCost(
      'anthropic',
      'claude-haiku-5-5',
      { ...usage, inputTokens: 50_000 },
      resolve,
    );
    expect(short.inputUsd).toBeCloseTo(0.005, 9);
  });
});

describe('long-context tier scaled to a divergent catalog base', () => {
  const usage = (inputTokens: number) => ({
    inputTokens,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 1_000,
    seen: true,
  });

  it('keeps the operator catalog price governing: the seed lends only the threshold and multiplier', () => {
    // A negotiated Bedrock rate below list: Haiku 5.5 seed is $0.10/$0.50 with ×5 above
    // 100K; the catalog says $0.08/$0.40 — so above 100K the request bills at $0.40/$2.00
    // (the catalog base ×5), never at the seed's absolute $0.50/$2.50.
    const below = (p: string, m: string) =>
      p === 'bedrock' && m.includes('claude-haiku-5-5') ? { input: 0.08, output: 0.4 } : undefined;
    const long = computeCost(
      'bedrock',
      'us.anthropic.claude-haiku-5-5-20251001-v1:0',
      usage(150_000),
      below,
    );
    expect(long.inputUsd).toBeCloseTo(0.06, 9);
    expect(long.outputUsd).toBeCloseTo(0.002, 9);
    const short = computeCost(
      'bedrock',
      'us.anthropic.claude-haiku-5-5-20251001-v1:0',
      usage(99_000),
      below,
    );
    expect(short.inputUsd).toBeCloseTo(0.00792, 9);
    // A chargeback markup above list must not invert the tier (the per-token rate can
    // never DROP past the threshold).
    const above = () => ({ input: 0.6, output: 3 });
    const marked = computeCost('anthropic', 'claude-haiku-5-5', usage(150_000), above);
    expect(marked.inputUsd).toBeCloseTo(0.45, 9); // 150K × $3.00/MTok (0.6 × 5)
    const markedShort = computeCost('anthropic', 'claude-haiku-5-5', usage(99_000), above);
    expect(marked.inputUsd / 150_000).toBeGreaterThan(markedShort.inputUsd / 99_000);
    // Azure reuses the OpenAI seed: a gpt-5.4 catalog row of $2/$12 bills $4/MTok input
    // past 272K (seed ×2), not the OpenAI list $5.
    const azure = computeCost('azure', 'gpt-5.4', usage(300_000), () => ({ input: 2, output: 12 }));
    expect(azure.inputUsd).toBeCloseTo(1.2, 9);
  });
});
