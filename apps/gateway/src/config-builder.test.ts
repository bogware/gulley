import type { ConfigDocument } from '@gulley/config';
import { MapSecretResolver } from '@gulley/core';
import { describe, expect, it } from 'vitest';
import { buildRoutesFromDocument, routesForProvider } from './config-builder';

const ARN_A = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic';
const ARN_O = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai';

const doc: ConfigDocument = {
  apiVersion: 'gulley/v1',
  orgs: [
    {
      name: 'Acme',
      workspaces: [
        {
          name: 'prod',
          providers: [
            {
              kind: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              enabled: true,
              credential: { secretArn: ARN_A, secretVersion: 'v1' } as never,
            },
            {
              kind: 'openai',
              baseUrl: null,
              enabled: true,
              credential: { secretArn: ARN_O, secretVersion: 'v1' } as never,
            },
            // disabled → skipped
            {
              kind: 'anthropic',
              baseUrl: null,
              enabled: false,
              credential: { secretArn: ARN_A, secretVersion: 'v1' } as never,
            },
          ],
          routes: [],
          policies: [],
          budgets: [],
          rateLimits: [],
          guardrails: [],
          modelAliases: [],
          virtualKeys: [],
        },
      ],
    },
  ],
};

describe('routesForProvider', () => {
  it('maps a kind to its adapter + client paths, resolving the credential scheme', () => {
    const a = routesForProvider('anthropic', null, 'sk-ant-abc');
    expect(a[0]?.clientPaths).toContain('/v1/messages');
    expect(a[0]?.strategy).toMatchObject({
      target: { provider: 'anthropic', credential: { scheme: 'x-api-key', value: 'sk-ant-abc' } },
    });
    // A non-sk-ant token uses bearer.
    const oauth = routesForProvider('anthropic', null, 'oauth-token');
    expect(oauth[0]?.strategy).toMatchObject({ target: { credential: { scheme: 'bearer' } } });
    // OpenAI yields chat/responses/embeddings.
    expect(routesForProvider('openai', null, 'k').flatMap((r) => r.clientPaths)).toEqual(
      expect.arrayContaining(['/v1/chat/completions', '/v1/responses', '/v1/embeddings']),
    );
    // Unknown kind → no routes (skipped, not an error).
    expect(routesForProvider('mystery', null, 'k')).toEqual([]);
  });
});

describe('buildRoutesFromDocument', () => {
  it('builds routes for enabled providers, resolving ARNs via the resolver', async () => {
    const resolver = new MapSecretResolver(
      new Map([
        [ARN_A, 'sk-ant-secret'],
        [ARN_O, 'sk-openai-secret'],
      ]),
    );
    const routes = await buildRoutesFromDocument(doc, resolver);
    const providers = routes
      .map((r) => r.strategy)
      .map((s) => (s.mode === 'single' ? s.target.provider : ''));
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    // The disabled provider contributed nothing; only 1 anthropic route + 3 openai.
    expect(providers.filter((p) => p === 'anthropic')).toHaveLength(1);
    expect(providers.filter((p) => p === 'openai')).toHaveLength(3);
  });

  it('REJECTS when a credential ARN cannot be resolved (reconcile aborts atomically)', async () => {
    const resolver = new MapSecretResolver(new Map([[ARN_A, 'sk-ant-secret']])); // openai ARN missing
    await expect(buildRoutesFromDocument(doc, resolver)).rejects.toThrow(/no secret value/);
  });
});
