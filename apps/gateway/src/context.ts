import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  AzureAdapter,
  BedrockAdapter,
  BedrockGuardrailPlugin,
  type CustomProviderConfig,
  OpenAIAdapter,
  OpenAIUsageExtractor,
  PassthroughAdapter,
  resolveCustomProvider,
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
import { loadCatalogFromFile } from '@gulley/catalog';
import {
  type AuthzRuleConfig,
  CelAuthorizer,
  type CelTransformConfig,
  CelTransformer,
  ExternalAuthorizer,
} from '@gulley/cel';
import { assertEgressAllowed } from '@gulley/egress';
import {
  type HeaderModifierConfig,
  RequestMirror,
  type RequestMirrorConfig,
} from '@gulley/http-edge';
import type { RateResolver } from '@gulley/cost';
import { type BasicAuthConfig, type BasicUserScope, parseHtpasswd } from '@gulley/auth';
import { OidcProvider } from '@gulley/oidc';
import { readFileSync } from 'node:fs';
import type { JwtAuthConfig } from './jwt-auth';
import {
  auditOnlyPolicies,
  AzureContentSafetyPlugin,
  composePlugins,
  GuardrailEngine,
  type GuardrailPlugin,
  ModelArmorPlugin,
  NativeDetector,
  OpenAIModerationPlugin,
  WebhookGuardrailPlugin,
} from '@gulley/guardrails';
import { GatewayMetrics } from '@gulley/metrics';
import { BatchingRequestLog } from '@gulley/pipeline';
import {
  InMemoryRateLimitStore,
  RateLimiter,
  type RateLimitStore,
  RedisRateLimitStore,
} from '@gulley/ratelimit';
import {
  CircuitBreaker,
  LoadScoreboard,
  type ModelRouteRule,
  ModelRouter,
  OutlierDetector,
  type RouteTarget,
  type RoutingStrategy,
} from '@gulley/routing';
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
import {
  type AccessLogConfig,
  AccessLogFieldEngine,
  initTelemetry,
  type Telemetry,
} from '@gulley/telemetry';
import type { Config } from './config';
import type { GatewayContext, ProviderRoute } from './routes/messages';

/** Native guardrail engine (audit-only default). Per-route policy overrides live
 *  on the route; this is the global default applied to every proxied request. */
export function buildGuardrails(config: Config): GuardrailEngine | undefined {
  if (!config.GUARDRAILS_ENABLED) return undefined;

  // Compose the configured external plugins (webhook DLP + managed services)
  // behind the single plugin seam, layered after the native detectors.
  const plugins: GuardrailPlugin[] = [];
  if (config.GUARDRAILS_WEBHOOK_URL) {
    plugins.push(
      new WebhookGuardrailPlugin({
        url: config.GUARDRAILS_WEBHOOK_URL,
        failMode: config.GUARDRAILS_WEBHOOK_FAIL_CLOSED ? 'closed' : 'open',
        allowInternal: config.GUARDRAILS_WEBHOOK_ALLOW_INTERNAL,
      }),
    );
  }
  if (config.GUARDRAILS_MODERATION_API_KEY) {
    plugins.push(
      new OpenAIModerationPlugin({
        apiKey: config.GUARDRAILS_MODERATION_API_KEY,
        baseUrl: config.GUARDRAILS_MODERATION_BASE_URL,
        model: config.GUARDRAILS_MODERATION_MODEL,
      }),
    );
  }
  if (config.GUARDRAILS_AZURE_CS_ENDPOINT && config.GUARDRAILS_AZURE_CS_KEY) {
    plugins.push(
      new AzureContentSafetyPlugin({
        endpoint: config.GUARDRAILS_AZURE_CS_ENDPOINT,
        apiKey: config.GUARDRAILS_AZURE_CS_KEY,
        severityThreshold: config.GUARDRAILS_AZURE_CS_SEVERITY,
      }),
    );
  }
  if (config.GUARDRAILS_BEDROCK_GUARDRAIL_ID && config.GUARDRAILS_BEDROCK_API_KEY) {
    plugins.push(
      new BedrockGuardrailPlugin({
        guardrailId: config.GUARDRAILS_BEDROCK_GUARDRAIL_ID,
        apiKey: config.GUARDRAILS_BEDROCK_API_KEY,
        region: config.GUARDRAILS_BEDROCK_REGION,
      }),
    );
  }
  if (
    config.GUARDRAILS_MODEL_ARMOR_PROJECT &&
    config.GUARDRAILS_MODEL_ARMOR_LOCATION &&
    config.GUARDRAILS_MODEL_ARMOR_TEMPLATE &&
    config.GUARDRAILS_MODEL_ARMOR_ACCESS_TOKEN
  ) {
    plugins.push(
      new ModelArmorPlugin({
        projectId: config.GUARDRAILS_MODEL_ARMOR_PROJECT,
        location: config.GUARDRAILS_MODEL_ARMOR_LOCATION,
        template: config.GUARDRAILS_MODEL_ARMOR_TEMPLATE,
        accessToken: config.GUARDRAILS_MODEL_ARMOR_ACCESS_TOKEN,
      }),
    );
  }

  return new GuardrailEngine(
    [new NativeDetector({ entropy: config.GUARDRAILS_ENTROPY })],
    auditOnlyPolicies(),
    composePlugins(plugins),
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
    routes.push({
      clientPaths: ['/v1/embeddings', '/openai/v1/embeddings'],
      createExtractor: () => new OpenAIUsageExtractor(),
      strategy: {
        mode: 'single',
        target: {
          name: 'openai',
          provider: 'openai',
          adapter,
          credential,
          upstreamPath: '/v1/embeddings',
        },
      },
      cacheable: false,
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

/**
 * Register custom / OpenAI-compatible providers (hosted presets and local
 * runtimes like Ollama/Jan/LM Studio) from `CUSTOM_PROVIDERS`. Each gets a
 * namespaced `/{provider}/v1/chat/completions` route; declared models become
 * model-router rules so a shared `/v1/chat/completions` request can be dispatched
 * by model, and are surfaced by `/v1/models`.
 */
export function buildCustomProviders(config: Config): {
  routes: ProviderRoute[];
  modelRules: ModelRouteRule[];
  models: string[];
} {
  const routes: ProviderRoute[] = [];
  const modelRules: ModelRouteRule[] = [];
  const models: string[] = [];
  if (!config.CUSTOM_PROVIDERS) return { routes, modelRules, models };

  let entries: CustomProviderConfig[];
  try {
    const parsed: unknown = JSON.parse(config.CUSTOM_PROVIDERS);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    entries = parsed as CustomProviderConfig[];
  } catch {
    throw new Error('CUSTOM_PROVIDERS must be a JSON array of provider entries');
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    const r = resolveCustomProvider(entry);
    if (seen.has(r.provider)) throw new Error(`duplicate custom provider label: ${r.provider}`);
    seen.add(r.provider);
    const credential: UpstreamCredential = { scheme: 'bearer', value: r.apiKey };
    const adapter = new PassthroughAdapter({ name: r.provider, baseUrl: r.baseUrl });
    const target: RouteTarget = {
      name: r.provider,
      provider: r.provider,
      adapter,
      credential,
      upstreamPath: r.chatPath,
    };
    const strategy: RoutingStrategy = { mode: 'single', target };
    routes.push({
      clientPaths: [`/${r.provider}/v1/chat/completions`],
      createExtractor: () => new OpenAIUsageExtractor(),
      strategy,
    });
    if (r.embeddingsPath) {
      routes.push({
        clientPaths: [`/${r.provider}/v1/embeddings`],
        createExtractor: () => new OpenAIUsageExtractor(),
        strategy: {
          mode: 'single',
          target: {
            name: r.provider,
            provider: r.provider,
            adapter,
            credential,
            upstreamPath: r.embeddingsPath,
          },
        },
        cacheable: false,
      });
    }
    for (const m of r.models) {
      models.push(m);
      modelRules.push({ pattern: m, strategy, provider: r.provider });
    }
  }
  return { routes, modelRules, models };
}

export function createProductionContext(config: Config): GatewayContext {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to run the data plane');
  if (!config.GULLEY_KEY_PEPPER) throw new Error('GULLEY_KEY_PEPPER is required to validate keys');

  const routes = buildRoutes(config);
  const custom = buildCustomProviders(config);
  routes.push(...custom.routes);

  // If no built-in OpenAI route claimed the shared chat path but custom/local
  // providers exist, expose /v1/chat/completions with the first as the default
  // target; the model router dispatches per requested model to the right backend.
  if (
    !routes.some((r) => r.clientPaths.includes('/v1/chat/completions')) &&
    custom.routes.length > 0
  ) {
    const first = custom.routes[0] as ProviderRoute;
    routes.push({
      clientPaths: ['/v1/chat/completions', '/openai/v1/chat/completions'],
      createExtractor: () => new OpenAIUsageExtractor(),
      strategy: first.strategy,
    });
  }

  if (routes.length === 0) {
    throw new Error(
      'no providers configured — set ANTHROPIC_UPSTREAM_API_KEY / OPENAI_UPSTREAM_API_KEY or CUSTOM_PROVIDERS',
    );
  }
  const modelRouter = custom.modelRules.length > 0 ? new ModelRouter(custom.modelRules) : undefined;
  const catalogModels = custom.models.length > 0 ? [...new Set(custom.models)] : undefined;

  // Optional models.dev-derived pricing catalog (operator-maintained file loaded
  // on boot); absent = seed rate tables only.
  let rateResolver: RateResolver | undefined;
  if (config.MODELS_CATALOG_FILE) {
    try {
      rateResolver = loadCatalogFromFile(config.MODELS_CATALOG_FILE).resolver();
    } catch (err) {
      throw new Error(`failed to load MODELS_CATALOG_FILE: ${(err as Error).message}`);
    }
  }

  // Optional CEL authorization rules (strict-compiled against the known surface).
  let authorizer: CelAuthorizer | undefined;
  if (config.CEL_AUTHZ) {
    let rules: AuthzRuleConfig[];
    try {
      const parsed: unknown = JSON.parse(config.CEL_AUTHZ);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      rules = parsed as AuthzRuleConfig[];
    } catch {
      throw new Error('CEL_AUTHZ must be a JSON array of { expr, effect, name? }');
    }
    authorizer = new CelAuthorizer(rules, { declaredVars: ['request', 'principal'] });
  }

  let transformer: CelTransformer | undefined;
  if (config.CEL_TRANSFORM) {
    let cfg: CelTransformConfig;
    try {
      const parsed: unknown = JSON.parse(config.CEL_TRANSFORM);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      cfg = parsed as CelTransformConfig;
    } catch {
      throw new Error('CEL_TRANSFORM must be a JSON object of header/body mutations');
    }
    transformer = new CelTransformer(cfg, { declaredVars: ['request', 'principal'] });
  }

  let externalAuthorizer: ExternalAuthorizer | undefined;
  if (config.EXTERNAL_AUTHZ_URL) {
    // SSRF-guard the policy-service URL at boot (same posture as the DLP webhook),
    // unless the operator opts into an internal endpoint.
    if (!config.EXTERNAL_AUTHZ_ALLOW_INTERNAL) assertEgressAllowed(config.EXTERNAL_AUTHZ_URL);
    externalAuthorizer = new ExternalAuthorizer({
      url: config.EXTERNAL_AUTHZ_URL,
      cacheKeyExpr: config.EXTERNAL_AUTHZ_CACHE_KEY,
      ttlMs: config.EXTERNAL_AUTHZ_TTL_MS,
      timeoutMs: config.EXTERNAL_AUTHZ_TIMEOUT_MS,
      failMode: config.EXTERNAL_AUTHZ_FAIL_OPEN ? 'allow' : 'deny',
    });
  }

  // Inbound JWT auth mode (data plane) — clients can present their IdP's JWT.
  let jwtAuth: JwtAuthConfig | undefined;
  if (config.JWT_ISSUER && config.JWT_AUDIENCE) {
    jwtAuth = {
      provider: new OidcProvider(config.JWT_ISSUER),
      audience: config.JWT_AUDIENCE,
      workspaceClaim: config.JWT_WORKSPACE_CLAIM,
      orgClaim: config.JWT_ORG_CLAIM,
      modelsClaim: config.JWT_MODELS_CLAIM,
      providersClaim: config.JWT_PROVIDERS_CLAIM,
      defaultWorkspaceId: config.JWT_DEFAULT_WORKSPACE_ID,
      defaultOrgId: config.JWT_DEFAULT_ORG_ID,
    };
  }

  const basicAuth = buildBasicAuth(config);

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
    outlier: config.OUTLIER_ENABLED
      ? new OutlierDetector({
          latencyFactor: config.OUTLIER_LATENCY_FACTOR,
          minSamples: config.OUTLIER_MIN_SAMPLES,
          minEjectLatencyMs: config.OUTLIER_MIN_EJECT_MS,
          baseEjectMs: config.OUTLIER_BASE_EJECT_MS,
          maxEjectMs: config.OUTLIER_MAX_EJECT_MS,
        })
      : undefined,
    budgets,
    telemetry,
    guardrails: buildGuardrails(config),
    cache: config.CACHE_ENABLED ? buildCache(config, db) : undefined,
    rateLimiter,
    metrics,
    modelRouter,
    models: catalogModels,
    rateResolver,
    retryMaxAttempts: config.RETRY_MAX_ATTEMPTS,
    retryBackoffMs: config.RETRY_BACKOFF_MS,
    authorizer,
    externalAuthorizer,
    externalAuthzSendBody: config.EXTERNAL_AUTHZ_SEND_BODY,
    transformer,
    jwtAuth,
    basicAuth,
    scoreboard: config.LB_LEAST_LOAD ? new LoadScoreboard() : undefined,
    sessionAffinityHeader: config.LB_SESSION_AFFINITY_HEADER,
    accessLog: buildAccessLog(config.ACCESS_LOG_FIELDS),
    tracePropagation: config.TRACE_PROPAGATION
      ? { sampleRatio: config.TRACE_SAMPLE_RATIO }
      : undefined,
    responseBufferLimit: config.RESPONSE_BUFFER_LIMIT_BYTES,
    bufferFailClosed: config.BUFFER_FAIL_CLOSED,
    headerModifier: config.HEADER_MODIFIER
      ? (JSON.parse(config.HEADER_MODIFIER) as HeaderModifierConfig)
      : undefined,
    mirror: buildMirror(config),
  };
}

/** Build the shadow-traffic mirror, SSRF-guarding its target at boot. */
export function buildMirror(config: Config): RequestMirror | undefined {
  if (!config.REQUEST_MIRROR) return undefined;
  const cfg = JSON.parse(config.REQUEST_MIRROR) as RequestMirrorConfig;
  if (!config.REQUEST_MIRROR_ALLOW_INTERNAL) assertEgressAllowed(cfg.url);
  return new RequestMirror(cfg);
}

/** Build the access-log field engine, FAIL-OPEN: a bad JSON/CEL config disables
 *  the access log (with a warning) rather than crashing the data plane — an
 *  observability knob must never take down proxying. */
export function buildAccessLog(raw: string | undefined): AccessLogFieldEngine | undefined {
  if (!raw) return undefined;
  try {
    return new AccessLogFieldEngine(JSON.parse(raw) as AccessLogConfig);
  } catch (err) {
    console.warn(
      `[gulley] ACCESS_LOG_FIELDS is invalid; access log disabled: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/** Build the inbound HTTP Basic auth config from an htpasswd source, or undefined
 *  when Basic is not configured. Fails fast at boot on a misconfiguration. */
export function buildBasicAuth(config: Config): BasicAuthConfig | undefined {
  const body = config.BASIC_AUTH_HTPASSWD_FILE
    ? readFileSync(config.BASIC_AUTH_HTPASSWD_FILE, 'utf8')
    : config.BASIC_AUTH_HTPASSWD;
  if (!body) return undefined;

  if (!config.BASIC_AUTH_DEFAULT_ORG_ID || !config.BASIC_AUTH_DEFAULT_WORKSPACE_ID) {
    throw new Error(
      'BASIC_AUTH requires BASIC_AUTH_DEFAULT_ORG_ID and BASIC_AUTH_DEFAULT_WORKSPACE_ID',
    );
  }
  const htpasswd = parseHtpasswd(body);
  if (htpasswd.size === 0) throw new Error('BASIC_AUTH htpasswd source has no entries');

  let users: Map<string, BasicUserScope> | undefined;
  if (config.BASIC_AUTH_USER_SCOPES) {
    const parsed = JSON.parse(config.BASIC_AUTH_USER_SCOPES) as Record<string, BasicUserScope>;
    users = new Map(Object.entries(parsed));
  }
  // "*" allows all; a comma-list allows those ids; unset ⇒ deny-by-default in the
  // resolver (a user with no override reaches nothing).
  const defaultList = (v: string | undefined): readonly string[] | '*' | undefined =>
    v === undefined
      ? undefined
      : v.trim() === '*'
        ? '*'
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  return {
    htpasswd,
    users,
    defaultOrgId: config.BASIC_AUTH_DEFAULT_ORG_ID,
    defaultWorkspaceId: config.BASIC_AUTH_DEFAULT_WORKSPACE_ID,
    defaultAllowedProviders: defaultList(config.BASIC_AUTH_DEFAULT_ALLOWED_PROVIDERS),
    defaultAllowedModels: defaultList(config.BASIC_AUTH_DEFAULT_ALLOWED_MODELS),
  };
}
