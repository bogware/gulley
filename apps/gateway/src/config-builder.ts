import type { ConfigDocument, ConfigProvider } from '@gulley/config';
import type { SecretResolver } from '@gulley/core';
import { type ModelRouteRule, ModelRouter } from '@gulley/routing';
import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  AzureAdapter,
  BedrockAdapter,
  OpenAIAdapter,
  OpenAIUsageExtractor,
  type UpstreamCredential,
} from '@gulley/providers';
import type { ProviderRoute } from './routes/messages';

/** sk-ant-… keys use x-api-key; OAuth/enterprise tokens use bearer. */
function anthropicCredential(value: string): UpstreamCredential {
  return value.startsWith('sk-ant-') ? { scheme: 'x-api-key', value } : { scheme: 'bearer', value };
}

/**
 * Build the model router from the config document's `modelAliases` so
 * admin-configured aliases/pins take effect in the data plane (they were built only
 * from the CUSTOM_PROVIDERS env before, so DB-configured aliases were inert). An
 * alias entity maps a requested-model pattern (its `config.pattern`, else its name)
 * to an upstream `target` rewrite and/or a `provider` label. Single-tenant v1:
 * aliases across all workspaces are flattened into one global router.
 */
export function buildModelRouterFromDocument(doc: ConfigDocument): ModelRouter | undefined {
  const rules: ModelRouteRule[] = [];
  for (const org of doc.orgs) {
    for (const ws of org.workspaces) {
      for (const alias of ws.modelAliases ?? []) {
        const cfg = alias.config;
        const pattern =
          typeof cfg['pattern'] === 'string' ? (cfg['pattern'] as string) : alias.name;
        const rule: ModelRouteRule = { pattern };
        if (typeof cfg['target'] === 'string') rule.target = cfg['target'] as string;
        if (typeof cfg['provider'] === 'string') rule.provider = cfg['provider'] as string;
        rules.push(rule);
      }
    }
  }
  return rules.length > 0 ? new ModelRouter(rules) : undefined;
}

/**
 * The provider routes for one DB-configured provider — the document-sourced
 * sibling of context.ts's env `buildRoutes`. The credential value has already
 * been resolved from its ARN; this only maps a provider kind → adapter + paths.
 * An unknown kind yields no routes (skipped, not an error).
 */
export function routesForProvider(
  kind: string,
  baseUrl: string | null,
  value: string,
): ProviderRoute[] {
  switch (kind) {
    case 'anthropic':
      return [
        {
          clientPaths: ['/v1/messages', '/anthropic/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: {
            mode: 'single',
            target: {
              name: 'anthropic',
              provider: 'anthropic',
              adapter: new AnthropicAdapter({ baseUrl: baseUrl ?? 'https://api.anthropic.com' }),
              credential: anthropicCredential(value),
              upstreamPath: '/v1/messages',
            },
          },
        },
      ];
    case 'openai': {
      const adapter = new OpenAIAdapter({ baseUrl: baseUrl ?? 'https://api.openai.com' });
      const credential: UpstreamCredential = { scheme: 'bearer', value };
      const target = (upstreamPath: string) => ({
        name: 'openai',
        provider: 'openai',
        adapter,
        credential,
        upstreamPath,
      });
      return [
        {
          clientPaths: ['/v1/chat/completions', '/openai/v1/chat/completions'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/v1/chat/completions') },
        },
        {
          clientPaths: ['/v1/responses', '/openai/v1/responses'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/v1/responses') },
        },
        {
          clientPaths: ['/v1/embeddings', '/openai/v1/embeddings'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/v1/embeddings') },
          cacheable: false,
        },
      ];
    }
    case 'bedrock':
      return [
        {
          clientPaths: ['/bedrock/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: {
            mode: 'single',
            target: {
              name: 'bedrock',
              provider: 'bedrock',
              adapter: new BedrockAdapter({ region: baseUrl ?? 'us-east-1' }),
              credential: { scheme: 'bearer', value },
              upstreamPath: '/v1/messages',
              alwaysStream: true,
            },
          },
        },
      ];
    case 'azure': {
      if (!baseUrl) return [];
      const adapter = new AzureAdapter({ baseUrl });
      const credential: UpstreamCredential = { scheme: 'api-key', value };
      const target = (upstreamPath: string) => ({
        name: 'azure',
        provider: 'azure',
        adapter,
        credential,
        upstreamPath,
      });
      return [
        {
          clientPaths: ['/azure/v1/chat/completions', '/azure/openai/v1/chat/completions'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/openai/v1/chat/completions') },
        },
        {
          clientPaths: ['/azure/v1/responses', '/azure/openai/v1/responses'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/openai/v1/responses') },
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Build the gateway's provider routes from a config document, resolving each
 * enabled provider's credential ARN via `resolver`. A resolution failure REJECTS
 * (the caller must abort the reconcile and keep the old routes) — never a partial
 * table with a live route pointing at an unresolved credential.
 */
export async function buildRoutesFromDocument(
  doc: ConfigDocument,
  resolver: SecretResolver,
): Promise<ProviderRoute[]> {
  const routes: ProviderRoute[] = [];
  for (const org of doc.orgs) {
    for (const ws of org.workspaces) {
      for (const p of ws.providers as ConfigProvider[]) {
        if (!p.enabled || !p.credential) continue;
        const value = await resolver.resolve(p.credential);
        routes.push(...routesForProvider(p.kind, p.baseUrl ?? null, value));
      }
    }
  }
  return routes;
}
