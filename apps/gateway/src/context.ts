import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  AzureAdapter,
  BedrockAdapter,
  OpenAIAdapter,
  OpenAIUsageExtractor,
  type UpstreamCredential,
} from '@gulley/providers';
import {
  createDatabase,
  PostgresAuditSink,
  PostgresKeyStore,
  PostgresLedger,
  PostgresRequestLog,
} from '@gulley/storage';
import type { Config } from './config';
import type { GatewayContext, ProviderRoute } from './routes/messages';

function anthropicCredential(key: string): UpstreamCredential {
  // sk-ant-... API keys use x-api-key; OAuth / enterprise tokens use bearer.
  return key.startsWith('sk-ant-')
    ? { scheme: 'x-api-key', value: key }
    : { scheme: 'bearer', value: key };
}

/** Assemble provider routes from config. A provider is registered only when its
 *  upstream key is present, so partial configurations work. */
export function buildRoutes(config: Config): ProviderRoute[] {
  const routes: ProviderRoute[] = [];

  if (config.ANTHROPIC_UPSTREAM_API_KEY) {
    routes.push({
      provider: 'anthropic',
      clientPaths: ['/v1/messages', '/anthropic/v1/messages'],
      upstreamPath: '/v1/messages',
      adapter: new AnthropicAdapter({ baseUrl: config.ANTHROPIC_BASE_URL }),
      credential: anthropicCredential(config.ANTHROPIC_UPSTREAM_API_KEY),
      createExtractor: () => new AnthropicUsageExtractor(),
    });
  }

  if (config.OPENAI_UPSTREAM_API_KEY) {
    const adapter = new OpenAIAdapter({ baseUrl: config.OPENAI_BASE_URL });
    const credential: UpstreamCredential = {
      scheme: 'bearer',
      value: config.OPENAI_UPSTREAM_API_KEY,
    };
    routes.push({
      provider: 'openai',
      clientPaths: ['/v1/chat/completions', '/openai/v1/chat/completions'],
      upstreamPath: '/v1/chat/completions',
      adapter,
      credential,
      createExtractor: () => new OpenAIUsageExtractor(),
    });
    routes.push({
      provider: 'openai',
      clientPaths: ['/v1/responses', '/openai/v1/responses'],
      upstreamPath: '/v1/responses',
      adapter,
      credential,
      createExtractor: () => new OpenAIUsageExtractor(),
    });
  }

  if (config.BEDROCK_UPSTREAM_API_KEY) {
    routes.push({
      provider: 'bedrock',
      clientPaths: ['/bedrock/v1/messages'],
      upstreamPath: '/v1/messages',
      adapter: new BedrockAdapter({ region: config.BEDROCK_REGION }),
      credential: { scheme: 'bearer', value: config.BEDROCK_UPSTREAM_API_KEY },
      createExtractor: () => new AnthropicUsageExtractor(),
      alwaysStream: true,
    });
  }

  if (config.AZURE_ENDPOINT && config.AZURE_UPSTREAM_API_KEY) {
    const adapter = new AzureAdapter({ baseUrl: config.AZURE_ENDPOINT });
    const credential: UpstreamCredential = {
      scheme: 'api-key',
      value: config.AZURE_UPSTREAM_API_KEY,
    };
    routes.push({
      provider: 'azure',
      clientPaths: ['/azure/v1/chat/completions', '/azure/openai/v1/chat/completions'],
      upstreamPath: '/openai/v1/chat/completions',
      adapter,
      credential,
      createExtractor: () => new OpenAIUsageExtractor(),
    });
    routes.push({
      provider: 'azure',
      clientPaths: ['/azure/v1/responses', '/azure/openai/v1/responses'],
      upstreamPath: '/openai/v1/responses',
      adapter,
      credential,
      createExtractor: () => new OpenAIUsageExtractor(),
    });
  }

  return routes;
}

export function createProductionContext(config: Config): GatewayContext {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to run the data plane');
  if (!config.GULLEY_KEY_PEPPER) throw new Error('GULLEY_KEY_PEPPER is required to validate keys');

  const routes = buildRoutes(config);
  if (routes.length === 0) {
    throw new Error(
      'no providers configured — set ANTHROPIC_UPSTREAM_API_KEY and/or OPENAI_UPSTREAM_API_KEY',
    );
  }

  const db = createDatabase(config.DATABASE_URL);
  return {
    routes,
    keyStore: new PostgresKeyStore(db),
    pepper: config.GULLEY_KEY_PEPPER,
    ledger: new PostgresLedger(db),
    requestLog: new PostgresRequestLog(db),
    audit: new PostgresAuditSink(db),
  };
}
