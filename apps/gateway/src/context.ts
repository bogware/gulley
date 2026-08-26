import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  AzureAdapter,
  BedrockAdapter,
  OpenAIAdapter,
  OpenAIUsageExtractor,
  type UpstreamCredential,
} from '@gulley/providers';
import { InMemoryBudgetStore, RedisBudgetStore } from '@gulley/budget';
import {
  CacheEngine,
  type EmbeddingProvider,
  type ExactCacheStore,
  InMemoryExactCache,
  InMemoryVectorIndex,
  OpenAIEmbeddingProvider,
  type VectorIndex,
} from '@gulley/cache';
import { auditOnlyPolicies, GuardrailEngine, NativeDetector } from '@gulley/guardrails';
import { GatewayMetrics } from '@gulley/metrics';
import { BatchingRequestLog } from '@gulley/pipeline';
import {
  InMemoryRateLimitStore,
  RateLimiter,
  type RateLimitStore,
  RedisRateLimitStore,
} from '@gulley/ratelimit';
import { CircuitBreaker } from '@gulley/routing';
import {
  createBudgetCapResolver,
  createDatabase,
  createRateLimitResolver,
  createRedisClient,
  type Database,
  PostgresAuditSink,
  PostgresExactCache,
  PostgresKeyStore,
  PostgresLedger,
  PostgresRequestLog,
  PostgresVectorIndex,
  RedisExactCache,
  RedisVectorIndex,
} from '@gulley/storage';
import { initTelemetry, type Telemetry } from '@gulley/telemetry';
import type { Config } from './config';
import type { GatewayContext, ProviderRoute } from './routes/messages';

/** Native guardrail engine (audit-only default). Per-route policy overrides live
 *  on the route; this is the global default applied to every proxied request. */
export function buildGuardrails(config: Config): GuardrailEngine | undefined {
  if (!config.GUARDRAILS_ENABLED) return undefined;
  return new GuardrailEngine(
    [new NativeDetector({ entropy: config.GUARDRAILS_ENTROPY })],
    auditOnlyPolicies(),
  );
}

/** Assemble the two-tier cache from config: pluggable exact store + optional
 *  semantic tier (embeddings + vector index). pgvector is the vector default. */
export function buildCache(config: Config, db: Database): CacheEngine {
  let exact: ExactCacheStore;
  switch (config.CACHE_EXACT_BACKEND) {
    case 'memory':
      exact = new InMemoryExactCache();
      break;
    case 'redis':
      if (!config.REDIS_CACHE_URL)
        throw new Error('REDIS_CACHE_URL required for the redis exact cache');
      exact = new RedisExactCache(createRedisClient(config.REDIS_CACHE_URL));
      break;
    default:
      exact = new PostgresExactCache(db);
  }

  let semantic: { embed: EmbeddingProvider; index: VectorIndex; threshold: number } | undefined;
  if (config.CACHE_SEMANTIC_ENABLED) {
    if (!config.EMBEDDINGS_API_KEY)
      throw new Error('EMBEDDINGS_API_KEY required for the semantic cache');
    const embed = new OpenAIEmbeddingProvider({
      apiKey: config.EMBEDDINGS_API_KEY,
      model: config.EMBEDDINGS_MODEL,
      dimensions: config.EMBEDDINGS_DIMENSIONS,
      baseUrl: config.EMBEDDINGS_BASE_URL,
    });
    let index: VectorIndex;
    switch (config.CACHE_VECTOR_BACKEND) {
      case 'memory':
        index = new InMemoryVectorIndex();
        break;
      case 'redis':
        if (!config.REDIS_VECTOR_URL)
          throw new Error('REDIS_VECTOR_URL required for the redis vector index');
        index = new RedisVectorIndex(
          createRedisClient(config.REDIS_VECTOR_URL),
          config.EMBEDDINGS_DIMENSIONS,
        );
        break;
      default:
        index = new PostgresVectorIndex(db);
    }
    semantic = { embed, index, threshold: config.CACHE_SIMILARITY_THRESHOLD };
  }

  return new CacheEngine({ exact, semantic, ttlSeconds: config.CACHE_TTL_SECONDS });
}

function anthropicCredential(key: string): UpstreamCredential {
  // sk-ant-... API keys use x-api-key; OAuth / enterprise tokens use bearer.
  return key.startsWith('sk-ant-')
    ? { scheme: 'x-api-key', value: key }
    : { scheme: 'bearer', value: key };
}

/** Assemble provider routes (each a single-target strategy in v1) from config.
 *  A provider is registered only when its upstream key is present. */
export function buildRoutes(config: Config): ProviderRoute[] {
  const routes: ProviderRoute[] = [];

  if (config.ANTHROPIC_UPSTREAM_API_KEY) {
    routes.push({
      clientPaths: ['/v1/messages', '/anthropic/v1/messages'],
      createExtractor: () => new AnthropicUsageExtractor(),
      strategy: {
        mode: 'single',
        target: {
          name: 'anthropic',
          provider: 'anthropic',
          adapter: new AnthropicAdapter({ baseUrl: config.ANTHROPIC_BASE_URL }),
          credential: anthropicCredential(config.ANTHROPIC_UPSTREAM_API_KEY),
          upstreamPath: '/v1/messages',
        },
      },
    });
  }

  if (config.OPENAI_UPSTREAM_API_KEY) {
    const adapter = new OpenAIAdapter({ baseUrl: config.OPENAI_BASE_URL });
    const credential: UpstreamCredential = {
      scheme: 'bearer',
      value: config.OPENAI_UPSTREAM_API_KEY,
    };
    routes.push({
      clientPaths: ['/v1/chat/completions', '/openai/v1/chat/completions'],
      createExtractor: () => new OpenAIUsageExtractor(),
      strategy: {
        mode: 'single',
        target: {
          name: 'openai',
          provider: 'openai',
          adapter,
          credential,
          upstreamPath: '/v1/chat/completions',
        },
      },
    });
    routes.push({
      clientPaths: ['/v1/responses', '/openai/v1/responses'],
      createExtractor: () => new OpenAIUsageExtractor(),
      strategy: {
        mode: 'single',
        target: {
          name: 'openai',
          provider: 'openai',
          adapter,
          credential,
          upstreamPath: '/v1/responses',
        },
      },
    });
  }

  if (config.BEDROCK_UPSTREAM_API_KEY) {
    routes.push({
      clientPaths: ['/bedrock/v1/messages'],
      createExtractor: () => new AnthropicUsageExtractor(),
      strategy: {
        mode: 'single',
        target: {
          name: 'bedrock',
          provider: 'bedrock',
          adapter: new BedrockAdapter({ region: config.BEDROCK_REGION }),
          credential: { scheme: 'bearer', value: config.BEDROCK_UPSTREAM_API_KEY },
          upstreamPath: '/v1/messages',
          alwaysStream: true,
        },
      },
    });
  }

  if (config.AZURE_ENDPOINT && config.AZURE_UPSTREAM_API_KEY) {
    const adapter = new AzureAdapter({ baseUrl: config.AZURE_ENDPOINT });
    const credential: UpstreamCredential = {
      scheme: 'api-key',
      value: config.AZURE_UPSTREAM_API_KEY,
    };
    routes.push({
      clientPaths: ['/azure/v1/chat/completions', '/azure/openai/v1/chat/completions'],
      createExtractor: () => new OpenAIUsageExtractor(),
      strategy: {
        mode: 'single',
        target: {
          name: 'azure',
          provider: 'azure',
          adapter,
          credential,
          upstreamPath: '/openai/v1/chat/completions',
        },
      },
    });
    routes.push({
      clientPaths: ['/azure/v1/responses', '/azure/openai/v1/responses'],
      createExtractor: () => new OpenAIUsageExtractor(),
      strategy: {
        mode: 'single',
        target: {
          name: 'azure',
          provider: 'azure',
          adapter,
          credential,
          upstreamPath: '/openai/v1/responses',
        },
      },
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
  // Budgets need Redis counters; without them, enforcement is simply disabled.
  const budgets = config.REDIS_COUNTERS_URL
    ? new RedisBudgetStore(
        createRedisClient(config.REDIS_COUNTERS_URL),
        createBudgetCapResolver(db),
      )
    : new InMemoryBudgetStore(new Map());
  const otel = initTelemetry({
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: config.OTEL_SERVICE_NAME,
  });

  // Prometheus metrics tee off the single telemetry event, so one recordRequest
  // call feeds both OTel spans and the /metrics counters/histograms.
  const metrics = config.METRICS_ENABLED ? new GatewayMetrics() : undefined;
  const telemetry: Telemetry = metrics
    ? {
        recordRequest: (d) => {
          otel.recordRequest(d);
          metrics.record(d);
        },
        forceFlush: () => otel.forceFlush(),
        shutdown: () => otel.shutdown(),
      }
    : otel;

  // Rate limiting shares the counters Redis with budgets (global, cross-replica);
  // without it, limits fall back to per-replica in-memory counters.
  let rateLimiter: RateLimiter | undefined;
  if (config.RATELIMIT_ENABLED) {
    const store: RateLimitStore = config.REDIS_COUNTERS_URL
      ? new RedisRateLimitStore(createRedisClient(config.REDIS_COUNTERS_URL))
      : new InMemoryRateLimitStore();
    rateLimiter = new RateLimiter({
      store,
      resolve: createRateLimitResolver(db),
      failOpen: config.RATELIMIT_FAIL_OPEN,
    });
  }

  // Batch operational request-log writes off the hot-path teardown; the durable
  // spend ledger stays synchronous. Flushed on the SIGTERM drain via flushLogs.
  const requestLog = new BatchingRequestLog(new PostgresRequestLog(db), {
    maxBatch: config.LOG_BATCH_MAX,
    intervalMs: config.LOG_BATCH_INTERVAL_MS,
  });

  return {
    routes,
    keyStore: new PostgresKeyStore(db),
    pepper: config.GULLEY_KEY_PEPPER,
    ledger: new PostgresLedger(db),
    requestLog,
    flushLogs: () => requestLog.close(),
    audit: new PostgresAuditSink(db),
    breaker: new CircuitBreaker(),
    budgets,
    telemetry,
    guardrails: buildGuardrails(config),
    cache: config.CACHE_ENABLED ? buildCache(config, db) : undefined,
    rateLimiter,
    metrics,
  };
}
