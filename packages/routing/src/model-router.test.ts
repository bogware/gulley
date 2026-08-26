import { describe, expect, it } from 'vitest';
import { ModelRouter } from './model-router';
import { hasShaping, shapeRequestBody } from './shaping';
import type { RouteTarget, RoutingStrategy } from './types';

const target = (name: string): RouteTarget =>
  ({ name, provider: 'anthropic', upstreamPath: '/v1/messages' }) as unknown as RouteTarget;
const strat = (name: string): RoutingStrategy => ({ mode: 'single', target: target(name) });

describe('ModelRouter', () => {
  it('prefers an exact rule over a glob', () => {
    const r = new ModelRouter([
      { pattern: 'claude-*', target: 'claude-sonnet-4-6' },
      { pattern: 'smart', target: 'claude-opus-4-8' },
    ]);
    expect(r.resolve('smart')?.resolved).toBe('claude-opus-4-8');
    expect(r.resolve('claude-3')?.resolved).toBe('claude-sonnet-4-6');
  });

  it('picks the most specific glob', () => {
    const r = new ModelRouter([
      { pattern: 'claude-*', target: 'broad' },
      { pattern: 'claude-3-5-*', target: 'narrow' },
    ]);
    expect(r.resolve('claude-3-5-haiku')?.resolved).toBe('narrow');
    expect(r.resolve('claude-4')?.resolved).toBe('broad');
  });

  it('carries a strategy override (virtual model) and returns undefined when unmatched', () => {
    const r = new ModelRouter([{ pattern: 'fast', strategy: strat('lb') }]);
    const res = r.resolve('fast');
    expect(res?.resolved).toBe('fast'); // no target → keep id
    expect(res?.strategy?.mode).toBe('single');
    expect(r.resolve('unknown-model')).toBeUndefined();
  });

  it('lists known exact models', () => {
    const r = new ModelRouter([{ pattern: 'b' }, { pattern: 'a' }, { pattern: '*', target: 'x' }]);
    expect(r.knownModels()).toEqual(['a', 'b']);
  });
});

describe('shapeRequestBody', () => {
  it('applies defaults only when absent, and overrides always', () => {
    const out = shapeRequestBody(
      { model: 'm', temperature: 0.9 },
      { defaults: { temperature: 0.2, max_tokens: 1024 }, overrides: { top_p: 0.5 } },
    );
    expect(out['temperature']).toBe(0.9); // present → default ignored
    expect(out['max_tokens']).toBe(1024); // absent → default applied
    expect(out['top_p']).toBe(0.5); // override
  });

  it('enriches a string system prompt', () => {
    const out = shapeRequestBody(
      { system: 'Be concise.' },
      { systemPrepend: 'You are Gulley.', systemAppend: 'Cite sources.' },
    );
    expect(out['system']).toBe('You are Gulley.\n\nBe concise.\n\nCite sources.');
  });

  it('enriches an array (block) system prompt', () => {
    const out = shapeRequestBody(
      { system: [{ type: 'text', text: 'Base.' }] },
      { systemPrepend: 'Prefix.' },
    );
    expect(out['system']).toEqual([
      { type: 'text', text: 'Prefix.' },
      { type: 'text', text: 'Base.' },
    ]);
  });

  it('hasShaping detects whether any shaping is configured', () => {
    expect(hasShaping({})).toBe(false);
    expect(hasShaping({ defaults: {} })).toBe(false);
    expect(hasShaping({ systemAppend: 'x' })).toBe(true);
  });
});
