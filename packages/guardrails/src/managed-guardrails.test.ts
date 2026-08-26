import { describe, expect, it } from 'vitest';
import { AzureContentSafetyPlugin } from './azure-content-safety';
import { CompositeGuardrailPlugin, composePlugins } from './composite';
import { OpenAIModerationPlugin } from './moderation';
import type { GuardrailPlugin, GuardrailPluginResult } from './types';

const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('OpenAIModerationPlugin', () => {
  it('blocks flagged content with category findings, passes clean content', async () => {
    const flagged = new OpenAIModerationPlugin({
      apiKey: 'k',
      fetchImpl: jsonFetch({
        results: [{ flagged: true, categories: { hate: true, violence: false } }],
      }),
    });
    const r = await flagged.inspect('bad', 'input');
    expect(r.action).toBe('blocked');
    expect(r.findings.map((f) => f.category)).toContain('hate');

    const clean = new OpenAIModerationPlugin({
      apiKey: 'k',
      fetchImpl: jsonFetch({ results: [{ flagged: false }] }),
    });
    expect((await clean.inspect('hi', 'input')).action).toBe('none');
  });

  it('fails open by default, closed when configured', async () => {
    const boom = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    expect(
      (await new OpenAIModerationPlugin({ apiKey: 'k', fetchImpl: boom }).inspect('x', 'input'))
        .action,
    ).toBe('none');
    expect(
      (
        await new OpenAIModerationPlugin({
          apiKey: 'k',
          failClosed: true,
          fetchImpl: boom,
        }).inspect('x', 'input')
      ).action,
    ).toBe('blocked');
  });
});

describe('AzureContentSafetyPlugin', () => {
  it('blocks when a category severity meets the threshold', async () => {
    const plugin = new AzureContentSafetyPlugin({
      endpoint: 'https://cs.example.com',
      apiKey: 'k',
      severityThreshold: 4,
      fetchImpl: jsonFetch({
        categoriesAnalysis: [
          { category: 'Hate', severity: 6 },
          { category: 'Violence', severity: 1 },
        ],
      }),
    });
    const r = await plugin.inspect('x', 'input');
    expect(r.action).toBe('blocked');
    expect(r.findings.map((f) => f.category)).toContain('azure:Hate');
  });

  it('passes when all severities are below the threshold', async () => {
    const plugin = new AzureContentSafetyPlugin({
      endpoint: 'https://cs.example.com',
      apiKey: 'k',
      severityThreshold: 4,
      fetchImpl: jsonFetch({ categoriesAnalysis: [{ category: 'Hate', severity: 2 }] }),
    });
    expect((await plugin.inspect('x', 'input')).action).toBe('none');
  });
});

describe('CompositeGuardrailPlugin', () => {
  const plugin = (result: GuardrailPluginResult): GuardrailPlugin => ({
    name: 'stub',
    inspect: async () => result,
  });

  it('short-circuits on the first block', async () => {
    const c = new CompositeGuardrailPlugin([
      plugin({ action: 'none', findings: [] }),
      plugin({
        action: 'blocked',
        findings: [{ category: 'x', start: 0, end: 1, source: 'plugin', confidence: 1 }],
      }),
      plugin({ action: 'masked', findings: [], maskedText: 'should-not-reach' }),
    ]);
    const r = await c.inspect('t', 'input');
    expect(r.action).toBe('blocked');
  });

  it('chains masks so later plugins see the masked text', async () => {
    const seen: string[] = [];
    const recorder = (out: string): GuardrailPlugin => ({
      name: 'r',
      inspect: async (text) => {
        seen.push(text);
        return { action: 'masked', findings: [], maskedText: out };
      },
    });
    const c = new CompositeGuardrailPlugin([recorder('A'), recorder('B')]);
    const r = await c.inspect('orig', 'input');
    expect(seen).toEqual(['orig', 'A']); // second saw the first's mask
    expect(r).toMatchObject({ action: 'masked', maskedText: 'B' });
  });

  it('composePlugins collapses 0/1/n', () => {
    expect(composePlugins([])).toBeUndefined();
    const p = plugin({ action: 'none', findings: [] });
    expect(composePlugins([p])).toBe(p);
    expect(composePlugins([p, p])).toBeInstanceOf(CompositeGuardrailPlugin);
  });
});
