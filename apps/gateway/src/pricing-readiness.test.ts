import { describe, expect, it } from 'vitest';
import { parseCascadePolicy } from './cascade';
import { unpricedModels } from './pricing-readiness';

describe('unpricedModels', () => {
  it('flags an alias target, a downshift model, a cascade escalation and a route-group map id with no rate', () => {
    const out = unpricedModels({
      providers: ['anthropic', 'openai', 'bedrock'],
      aliasRules: [
        { pattern: 'fast', target: 'claude-mystery-9' },
        { pattern: 'smart', target: 'claude-sonnet-5-5' },
      ],
      downshiftModel: 'claude-haiku-5-5',
      cascade: parseCascadePolicy(
        JSON.stringify([{ model: 'claude-haiku-*', escalateTo: 'gpt-99' }]),
      ),
      modelMaps: [
        { provider: 'bedrock', model: 'us.anthropic.claude-sonnet-5-5-20260401-v1:0' },
        { provider: 'bedrock', model: 'us.amazon.nova-9-v1:0' },
      ],
    });
    expect(out).toEqual(['bedrock/us.amazon.nova-9-v1:0', 'claude-mystery-9', 'gpt-99']);
  });

  it('skips glob patterns and models on free (local) providers', () => {
    const out = unpricedModels({
      providers: ['anthropic', 'ollama'],
      freeProviders: ['ollama'],
      aliasRules: [{ pattern: 'llama3', provider: 'ollama' }, { pattern: 'claude-*' }],
    });
    expect(out).toEqual([]);
  });

  it('prices a provider-hinted model only against that provider', () => {
    // gpt-5 is priced by OpenAI but the alias pins it to the Anthropic route.
    const out = unpricedModels({
      providers: ['anthropic', 'openai'],
      aliasRules: [{ pattern: 'gpt-5', provider: 'anthropic' }],
    });
    expect(out).toEqual(['anthropic/gpt-5']);
  });

  it('honours the catalog rate resolver', () => {
    const out = unpricedModels({
      providers: ['anthropic'],
      downshiftModel: 'claude-mystery-9',
      rateResolver: (_provider, model) =>
        model === 'claude-mystery-9' ? { input: 1, output: 2 } : undefined,
    });
    expect(out).toEqual([]);
  });

  it('reports nothing for a deployment with no paid provider at all', () => {
    const out = unpricedModels({
      providers: ['ollama'],
      freeProviders: ['ollama'],
      downshiftModel: 'whatever-local',
    });
    expect(out).toEqual([]);
  });
});
