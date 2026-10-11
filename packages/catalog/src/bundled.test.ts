import { existsSync, statSync } from 'node:fs';
import { computeCost } from '@gulley/cost';
import { describe, expect, it } from 'vitest';
import { BUNDLED_SNAPSHOT_PATH, bundledSnapshotPath, loadBundledSnapshot } from './bundled';

const usage = {
  inputTokens: 0,
  cacheReadTokens: 1_000_000,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  seen: true,
};

describe('bundled models.dev snapshot', () => {
  const cat = loadBundledSnapshot();

  it('ships in the tree, stays under the size budget, and loads', () => {
    expect(existsSync(BUNDLED_SNAPSHOT_PATH)).toBe(true);
    expect(statSync(BUNDLED_SNAPSHOT_PATH).size).toBeLessThan(400 * 1024);
    expect(cat.size).toBeGreaterThan(100);
    for (const provider of ['anthropic', 'openai', 'bedrock', 'azure', 'gemini', 'vertex']) {
      expect(cat.entriesFor(provider).length, provider).toBeGreaterThan(0);
    }
  });

  it('carries Haiku 5.5 with its long-context tier and limits', () => {
    const haiku = cat.entry('anthropic', 'claude-haiku-5-5');
    expect(haiku).toMatchObject({
      input: 0.1,
      output: 0.5,
      tier: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
      displayName: 'Claude Haiku 5.5',
    });
    expect(cat.lookup('anthropic', 'claude-haiku-5-5')?.tier?.aboveInputTokens).toBe(100_000);
  });

  it('normalises Bedrock ids to the Claude alias and ships only Anthropic Bedrock models', () => {
    expect(cat.lookup('bedrock', 'claude-opus-5-5')?.input).toBe(4);
    expect(cat.lookup('bedrock', 'us.anthropic.claude-opus-5-5')?.input).toBe(4);
    expect(cat.entry('bedrock', 'claude-opus-5-5')?.model).toBe('anthropic.claude-opus-5-5');
    const bedrock = cat.entriesFor('bedrock');
    expect(bedrock.length).toBeGreaterThan(5);
    expect(bedrock.every((e) => e.model.includes('anthropic.'))).toBe(true);
    // The Bedrock adapter speaks Anthropic Messages only: no Gemma/Qwen/Nova/Llama rows.
    expect(bedrock.some((e) => /gemma|qwen|nova|llama|writer|mistral/i.test(e.model))).toBe(false);
  });

  it('ships only Claude under vertex', () => {
    const vertex = cat.entriesFor('vertex');
    expect(vertex.length).toBeGreaterThan(0);
    expect(vertex.every((e) => e.model.startsWith('claude-'))).toBe(true);
  });

  it('prices Opus 5.5 cache reads at 0.05× (0.2 / 4)', () => {
    expect(cat.entry('anthropic', 'claude-opus-5-5')?.cache?.read).toBeCloseTo(0.05, 9);
    const c = computeCost('anthropic', 'claude-opus-5-5', usage, cat.resolver());
    expect(c.priced).toBe(true);
    expect(c.cacheReadUsd).toBeCloseTo(0.2, 9); // 1M cache-read tokens × $0.20/MTok
    expect(c.cacheSavedUsd).toBeCloseTo(3.8, 9);
  });

  it('resolves the path from GULLEY_CATALOG_SNAPSHOT at call time', () => {
    const prev = process.env['GULLEY_CATALOG_SNAPSHOT'];
    try {
      process.env['GULLEY_CATALOG_SNAPSHOT'] = '/definitely/not/here.json';
      expect(bundledSnapshotPath()).toBe('/definitely/not/here.json');
      expect(() => loadBundledSnapshot()).toThrow();
      delete process.env['GULLEY_CATALOG_SNAPSHOT'];
      expect(bundledSnapshotPath()).toBe(BUNDLED_SNAPSHOT_PATH);
    } finally {
      if (prev === undefined) delete process.env['GULLEY_CATALOG_SNAPSHOT'];
      else process.env['GULLEY_CATALOG_SNAPSHOT'] = prev;
    }
  });
});
