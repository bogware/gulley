import { describe, expect, it } from 'vitest';
import {
  computeAnthropicCost,
  computeCost,
  lookupRate,
  normalizeModelId,
  toMicroUsd,
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
    // Sonnet-5 input $3/MTok. read x0.1 => $0.30; write5m x1.25 => $3.75 per MTok.
    const c = computeAnthropicCost('claude-sonnet-5', {
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
