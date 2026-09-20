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
import {
  type Budget,
  type BudgetStore,
  InMemoryBudgetStore,
  RedisBudgetStore,
} from '@gulley/budget';
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
import { GULLEY_VERSION, memoizeAsync } from '@gulley/core';
import { PRICING_AS_OF, type RateResolver } from '@gulley/cost';
import { type BasicAuthConfig, type BasicUserScope, parseHtpasswd } from '@gulley/auth';
import { OidcProvider } from '@gulley/oidc';
import { readFileSync } from 'node:fs';
import { BudgetAlerter } from './budget-alerts';
import { type JwtAuthConfig, parseGroupScopeMap } from './jwt-auth';
import { applyRouteGroups, parseRouteGroups } from './route-groups';
import { buildSecretResolver } from './secrets';
import { DbTenantCredentialResolver } from './tenant';
import { parseToolPolicy } from './tool-governance';
import { modelPolicyFromEnv } from './model-policy';
import { isEmptyResidencyPolicy, residencyPolicyFromEnv } from './residency-policy';
import { parseCascadePolicy } from './cascade';
import { RequestTracer } from './tracer';
import {
  AzureContentSafetyPlugin,
  composePlugins,
  type Detector,
  GuardrailEngine,
  type GuardrailPlugin,
  InjectionDetector,
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
  AdaptiveLimiter,
  CircuitBreaker,
  LoadScoreboard,
  type ModelRouteRule,
  ModelRouter,
  OutlierDetector,
  RedisBreakerSync,
  type RouteTarget,
  type RoutingStrategy,
} from '@gulley/routing';
import {
  createBudgetCapResolver,
  createDatabase,
  loadBudgetHealData,
  createRateLimitResolver,
  createRedisClient,
  checkEvictionPolicy,
  type Database,
  PostgresAuditSink,
  PostgresExactCache,
  PostgresGrantStore,
  PostgresKeyStore,
  PostgresLedger,
  PostgresMaskVaultStore,
  PostgresRequestLog,
  PostgresSubjectKeyStore,
  purgeRequestLogsOlderThan,
  retentionCutoff,
  PostgresVectorIndex,
  RedisExactCache,
  RedisVectorIndex,
  type BatchSweepResult,
} from '@gulley/storage';
import { resolveBrokerAccessToken } from '@gulley/oauth';
import {
  type Encryptor,
  InMemoryAesCipher,
  KmsEnvelopeEncryptor,
  ShreddableCipher,
} from '@gulley/crypto';
import {
  type AccessLogConfig,
  AccessLogFieldEngine,
  initAccessLogExporter,
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
        failClosed: config.GUARDRAILS_MODERATION_FAIL_CLOSED, // enforcement: fail closed by default
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
        failClosed: config.GUARDRAILS_MODEL_ARMOR_FAIL_CLOSED, // enforcement: fail closed by default
      }),
    );
  }

  const detectors: Detector[] = [new NativeDetector({ entropy: config.GUARDRAILS_ENTROPY })];
  if (config.GUARDRAILS_INJECTION_ENABLED) detectors.push(new InjectionDetector());

  return new GuardrailEngine(
    detectors,
    {
      input: {
        action: config.GUARDRAILS_INPUT_ACTION,
        minConfidence: config.GUARDRAILS_INPUT_MIN_CONFIDENCE,
      },
      output: {
        action: config.GUARDRAILS_OUTPUT_ACTION,
        minConfidence: config.GUARDRAILS_OUTPUT_MIN_CONFIDENCE,
      },
    },
    composePlugins(plugins),
  );
}

/** Structured logger the context build + maintenance loops write to. main.ts passes
 *  the process pino instance; the console fallback keeps tests/smoke scripts working. */
export interface BootLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
const consoleLog: BootLogger = {
  info: (obj, msg) => console.info(`[gulley] ${msg}`, obj),
  warn: (obj, msg) => console.warn(`[gulley] ${msg}`, obj),
  error: (obj, msg) => console.error(`[gulley] ${msg}`, obj),
};

/** Wraps a background job so every run is LOGGED and METERED (result ok|error|skipped,
 *  last-success timestamp). The previous `.catch(() => {})` timers made a permanently
 *  failing sweep (statement_timeout, schema drift) invisible until disk filled. */
export type MaintenanceRunner = (
  job: string,
  fn: () => Promise<number | BatchSweepResult | void>,
) => () => void;

export function makeMaintenanceRunner(
  log: BootLogger,
  metrics?: GatewayMetrics,
): MaintenanceRunner {
  return (job, fn) => () => {
    void (async () => {
      const started = Date.now();
      try {
        const r = await fn();
        const detail = typeof r === 'number' ? { removed: r } : r ? r : {};
        const skipped = typeof r === 'object' && r !== null && r.skipped === true;
        metrics?.recordMaintenance(job, skipped ? 'skipped' : 'ok');
        const removed = typeof r === 'number' ? r : (r?.removed ?? 0);
        if (removed > 0 || (typeof r === 'object' && r?.capped))
          log.info({ job, ...detail, durationMs: Date.now() - started }, 'maintenance run');
      } catch (err) {
        log.error({ err, job, durationMs: Date.now() - started }, 'maintenance run failed');
        metrics?.recordMaintenance(job, 'error');
      }
    })();
  };
}

/** An unref'd repeating timer with ±10% jitter, so a fleet of replicas does not fire
 *  the same sweep in lock-step (on top of the per-job advisory lock). Returns stop(). */
export function scheduleJittered(fn: () => void, intervalMs: number, jitter = 0.1): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const next = (): void => {
    if (stopped) return;
    const delay = Math.max(1_000, intervalMs * (1 + (Math.random() * 2 - 1) * jitter));
    timer = setTimeout(() => {
      fn();
      next();
    }, delay);
    timer.unref?.();
  };
  next();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Assemble the two-tier cache from config: pluggable exact store + optional
 *  semantic tier (embeddings + vector index). pgvector is the vector default. */
export function buildCache(
  config: Config,
  db: Database,
  log: BootLogger = consoleLog,
  maintenance?: MaintenanceRunner,
  stops?: Array<() => void>,
): CacheEngine {
  // Validate the semantic tier's prerequisites BEFORE any store/timer is allocated, so
  // a bad knob throws out of a clean function (health-only boot, no orphaned timer).
  if (config.CACHE_SEMANTIC_ENABLED) {
    if (!config.EMBEDDINGS_API_KEY)
      throw new Error('EMBEDDINGS_API_KEY required for the semantic cache');
    if (config.CACHE_VECTOR_BACKEND === 'redis' && !config.REDIS_VECTOR_URL)
      throw new Error('REDIS_VECTOR_URL required for the redis vector index');
  }
  if (config.CACHE_EXACT_BACKEND === 'redis' && !config.REDIS_CACHE_URL)
    throw new Error('REDIS_CACHE_URL required for the redis exact cache');
  const redisLog = (role: string) => (err: Error) =>
    log.warn({ err, role }, 'redis connection error');
  let exact: ExactCacheStore;
  switch (config.CACHE_EXACT_BACKEND) {
    case 'memory':
      exact = new InMemoryExactCache();
      break;
    case 'redis': {
      if (!config.REDIS_CACHE_URL)
        throw new Error('REDIS_CACHE_URL required for the redis exact cache');
      const cacheClient = createRedisClient(config.REDIS_CACHE_URL, {
        role: 'cache',
        onError: redisLog('cache'),
      });
      void checkEvictionPolicy(cacheClient, 'cache', log);
      exact = new RedisExactCache(cacheClient);
      break;
    }
    default: {
      const pg = new PostgresExactCache(db);
      exact = pg;
      if (config.CACHE_SWEEP_INTERVAL_SECONDS > 0) {
        const run = maintenance
          ? maintenance('cache_sweep', () => pg.sweepExpiredDetailed())
          : () => void pg.sweepExpired().catch(() => {});
        stops?.push(scheduleJittered(run, config.CACHE_SWEEP_INTERVAL_SECONDS * 1000));
      }
    }
  }

  let semantic: { embed: EmbeddingProvider; index: VectorIndex; threshold: number } | undefined;
  if (config.CACHE_SEMANTIC_ENABLED && config.EMBEDDINGS_API_KEY) {
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
      case 'redis': {
        if (!config.REDIS_VECTOR_URL)
          throw new Error('REDIS_VECTOR_URL required for the redis vector index');
        const vectorClient = createRedisClient(config.REDIS_VECTOR_URL, {
          role: 'vector',
          onError: redisLog('vector'),
        });
        void checkEvictionPolicy(vectorClient, 'vector', log);
        index = new RedisVectorIndex(vectorClient, config.EMBEDDINGS_DIMENSIONS);
        break;
      }
      default:
        index = new PostgresVectorIndex(db);
    }
    semantic = { embed, index, threshold: config.CACHE_SIMILARITY_THRESHOLD };
  }

  return new CacheEngine({ exact, semantic, ttlSeconds: config.CACHE_TTL_SECONDS });
}

/** Parse `BUDGET_MODEL_CAPS` (JSON map of model id → cap) into a scope→Budget map
 *  keyed by the `model:<model>` scope the hot path reserves against. Invalid entries
 *  are dropped (a bad cap must never silently disable the workspace cap). */
export function parseBudgetModelCaps(
  raw: string | undefined,
): Map<string, { capMicroUsd: number; periodSeconds?: number }> {
  const out = new Map<string, { capMicroUsd: number; periodSeconds?: number }>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BUDGET_MODEL_CAPS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('BUDGET_MODEL_CAPS must be a JSON object of model → { capMicroUsd }');
  }
  for (const [model, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const cap = (v as Record<string, unknown>)['capMicroUsd'];
    const period = (v as Record<string, unknown>)['periodSeconds'];
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      throw new Error(`BUDGET_MODEL_CAPS["${model}"].capMicroUsd must be a positive number`);
    }
    const entry: { capMicroUsd: number; periodSeconds?: number } = { capMicroUsd: cap };
    if (typeof period === 'number' && Number.isFinite(period) && period > 0) {
      entry.periodSeconds = period;
    }
    out.set(`model:${model}`, entry);
  }
  return out;
}

/** Default rolling window for a per-attribution cap when the operator omits
 *  `periodSeconds`. Unlike a workspace/model scope (a bounded, server-assigned or
 *  configured key set), the `attr:<key>:<value>` value comes from a client header,
 *  so its key cardinality is client-controlled. The counters Redis is `noeviction`,
 *  so a lifetime (TTL-less) attr cap would let distinct values accumulate keys that
 *  never expire — a slow key-exhaustion DoS. A window is therefore always applied:
 *  every attr-cap key gets an EXPIRE, bounding the working set and self-recovering. */
const DEFAULT_ATTR_CAP_PERIOD_SECONDS = 86_400;

/** Parse `BUDGET_ATTR_CAPS` (JSON map of attribution-key → cap) into an attrKey→Budget
 *  map. A daily-ish cap keyed by an SDLC attribution dimension (session, dev, repo…)
 *  — the runaway-agent control: a looping session or a heavy developer hits its own
 *  cap independent of the workspace cap. Reserved against `attr:<key>:<value>`.
 *  A rolling window is ALWAYS applied (see DEFAULT_ATTR_CAP_PERIOD_SECONDS): the
 *  key value is client-controlled, so a TTL-less counter on the noeviction Redis
 *  would grow unbounded. Invalid entries throw (a bad cap must never silently
 *  disable enforcement). */
export function parseBudgetAttrCaps(
  raw: string | undefined,
): Map<string, { capMicroUsd: number; periodSeconds?: number }> {
  const out = new Map<string, { capMicroUsd: number; periodSeconds?: number }>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BUDGET_ATTR_CAPS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('BUDGET_ATTR_CAPS must be a JSON object of attrKey → { capMicroUsd }');
  }
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const cap = (v as Record<string, unknown>)['capMicroUsd'];
    const period = (v as Record<string, unknown>)['periodSeconds'];
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      throw new Error(`BUDGET_ATTR_CAPS["${key}"].capMicroUsd must be a positive number`);
    }
    const entry: { capMicroUsd: number; periodSeconds?: number } = {
      capMicroUsd: cap,
      // Always windowed — never a lifetime cap (see DEFAULT_ATTR_CAP_PERIOD_SECONDS).
      periodSeconds:
        typeof period === 'number' && Number.isFinite(period) && period > 0
          ? period
          : DEFAULT_ATTR_CAP_PERIOD_SECONDS,
    };
    out.set(key, entry);
  }
  return out;
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

  // Per-upstream data-residency stamp (region + ZDR posture) spread into each target.
  // A region is set only when declared; zdr only when true — an absent stamp fails
  // closed under an active residency policy.
  const stamp = (region: string, zdr: boolean): { region?: string; zdr?: boolean } => ({
    ...(region ? { region } : {}),
    ...(zdr ? { zdr: true } : {}),
  });

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
          ...stamp(config.ANTHROPIC_REGION, config.ANTHROPIC_ZDR),
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
          ...stamp(config.OPENAI_REGION, config.OPENAI_ZDR),
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
          ...stamp(config.OPENAI_REGION, config.OPENAI_ZDR),
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
          ...stamp(config.OPENAI_REGION, config.OPENAI_ZDR),
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
          ...stamp(config.BEDROCK_REGION, config.BEDROCK_ZDR),
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
          ...stamp(config.AZURE_REGION, config.AZURE_ZDR),
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
          ...stamp(config.AZURE_REGION, config.AZURE_ZDR),
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

export function createProductionContext(
  config: Config,
  log: BootLogger = consoleLog,
): GatewayContext {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to run the data plane');
  if (!config.GULLEY_KEY_PEPPER) throw new Error('GULLEY_KEY_PEPPER is required to validate keys');

  // Pure config parsing FIRST: anything that can throw on a bad knob runs before any
  // pool / timer / telemetry provider is allocated, so a health-only boot never leaves
  // orphaned connections or ticking sweeps behind the failed context.
  const cascade = parseCascadePolicy(config.CASCADE_POLICY);
  const headerModifier = config.HEADER_MODIFIER
    ? (JSON.parse(config.HEADER_MODIFIER) as HeaderModifierConfig)
    : undefined;
  const mirror = buildMirror(config);
  const secretResolver = config.CONFIG_SOURCE === 'db' ? buildSecretResolver(config) : undefined;
  const guardrails = buildGuardrails(config);

  // Prometheus registry + the maintenance runner it feeds are created up front so every
  // background job below (sweeps, heal, retention) is metered from its first tick.
  const metrics = config.METRICS_ENABLED ? new GatewayMetrics() : undefined;
  const maintenance = makeMaintenanceRunner(log, metrics);
  const maintenanceStops: Array<() => void> = [];
  const redisLog = (role: string) => (err: Error) =>
    log.warn({ err, role }, 'redis connection error');
  /** Rate-limit a repeating warning to once per window (per key). */
  const lastWarn = new Map<string, number>();
  const warnThrottled = (key: string, obj: object, msg: string): void => {
    const now = Date.now();
    if (now - (lastWarn.get(key) ?? 0) < 30_000) return;
    lastWarn.set(key, now);
    log.warn(obj, msg);
  };

  let routes = buildRoutes(config);
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

  // M19: fold ROUTE_GROUPS into multi-target routes so the resilience library
  // (fallback/loadbalance/breaker/outlier/P2C/HRW/hedge) has >=2 targets to work on.
  routes = applyRouteGroups(routes, parseRouteGroups(config.ROUTE_GROUPS), config.HEDGE_DELAY_MS);

  // In DB config mode the route table is loaded from Postgres by the reload
  // watcher AFTER boot, so an empty env route set is expected — the gateway boots
  // with a working context (and holder) and reconciles to the DB config. Only the
  // env-only mode requires at least one provider key at boot.
  if (routes.length === 0 && config.CONFIG_SOURCE !== 'db') {
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

  // LLM-leg tool-call governance policy (parsed + compiled here so a bad rule fails
  // boot, never silently disables governance).
  const toolPolicy = parseToolPolicy(config.TOOL_POLICY);

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
      groupsClaim: config.JWT_GROUPS_CLAIM,
      groupScopeRules: parseGroupScopeMap(config.JWT_GROUP_SCOPE_MAP),
      defaultWorkspaceId: config.JWT_DEFAULT_WORKSPACE_ID,
      defaultOrgId: config.JWT_DEFAULT_ORG_ID,
    };
  }

  const basicAuth = buildBasicAuth(config);

  // Fail-fast pool options: a bounded statement_timeout turns a hung query into a
  // rejection instead of a pinned connection (so a stuck sink write can't starve authn),
  // plus connect/idle bounds that keep the pool lean behind RDS Proxy.
  const dbTimeouts = {
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: config.DB_IDLE_TIMEOUT_MS,
  };
  const db = createDatabase(config.DATABASE_URL, { max: config.DB_POOL_MAX, ...dbTimeouts });
  // Hot-path auth (KeyStore + brokered-token grant lookups) reads from its OWN small pool,
  // physically separate from the teardown/durable-sink pool above, so audit/ledger write
  // pressure — including the single global audit advisory lock — can never exhaust the
  // connections authentication depends on. Under sink overload the gateway keeps
  // authenticating and sheds load via /ready 503 rather than blocking new requests on
  // key lookup.
  const authDb = createDatabase(config.DATABASE_URL, {
    max: config.DB_KEYSTORE_POOL_MAX,
    ...dbTimeouts,
  });

  // Gateway-brokered OAuth inference auth (data plane): verify opaque `gko_at_` access
  // tokens read-only against the shared Postgres grant store, with the same pepper the
  // control-plane broker minted with. One grant-store instance, reused per request. On the
  // isolated auth pool — it is a hot-path auth read.
  const brokerPepper = config.GULLEY_KEY_PEPPER;
  const brokerGrants =
    config.OAUTH_BROKER_ENABLED && brokerPepper ? new PostgresGrantStore(authDb) : undefined;
  const brokerResolver =
    brokerGrants && brokerPepper
      ? (token: string) =>
          resolveBrokerAccessToken(token, { grants: brokerGrants, pepper: brokerPepper })
      : undefined;

  // Durable mask-reversal store (M22 D): only wired when MASK_VAULT_PERSIST is on, and
  // ALWAYS with an encryptor (KMS in prod, the in-memory dev twin otherwise) — the
  // store never receives plaintext. Reveal (control-api) must use the same key, so
  // prod requires the shared KMS key; the in-memory cipher is per-process (dev/tests).
  const masterMaskEncryptor: Encryptor | undefined = config.MASK_VAULT_PERSIST
    ? config.GULLEY_KMS_KEY_ARN
      ? new KmsEnvelopeEncryptor(
          config.GULLEY_KMS_KEY_ARN,
          config.GULLEY_KMS_REGION ?? config.BEDROCK_REGION,
        )
      : new InMemoryAesCipher()
    : undefined;
  // BYOK crypto-shred: when on, each mask-vault record is encrypted under a PER-SUBJECT
  // key (the principal) held wrapped by the master encryptor above (the customer CMK), so
  // the control plane can later crypto-shred one subject's PII irrecoverably. The gateway
  // only WRITES here (getOrCreate on the subject key); shredding is a control-plane action.
  const maskVaultEncryptor: Encryptor | undefined =
    masterMaskEncryptor && config.CRYPTO_SHRED_ENABLED
      ? new ShreddableCipher(
          masterMaskEncryptor,
          new PostgresSubjectKeyStore(db, masterMaskEncryptor),
        )
      : masterMaskEncryptor;
  const maskVault =
    config.MASK_VAULT_PERSIST && maskVaultEncryptor ? new PostgresMaskVaultStore(db) : undefined;

  // Mask-vault expiry sweep: every guardrail 'mask' writes a short-TTL (encrypted-PII)
  // reversal row, so without a sweep the table grows unbounded past its declared TTL — a
  // data-minimization regression. Mirror the exact-cache sweep: an unref'd best-effort
  // timer, guarded on the store actually existing and a non-zero interval.
  if (maskVault && config.MASK_VAULT_SWEEP_INTERVAL_SECONDS > 0) {
    maintenanceStops.push(
      scheduleJittered(
        maintenance('mask_vault_sweep', () => maskVault.sweepExpiredDetailed(new Date())),
        config.MASK_VAULT_SWEEP_INTERVAL_SECONDS * 1000,
      ),
    );
  }

  // Request-log retention: bounded batched DELETE of request_log rows past the retention
  // horizon, off the hot path on an unref'd timer (0 days = keep forever). spend_ledger
  // (the durable budget/chargeback source of truth) is deliberately NOT swept.
  if (config.REQUEST_LOG_RETENTION_DAYS > 0) {
    const retentionDays = config.REQUEST_LOG_RETENTION_DAYS;
    maintenanceStops.push(
      scheduleJittered(
        maintenance('request_log_retention', () =>
          purgeRequestLogsOlderThan(db, retentionCutoff(new Date(), retentionDays)),
        ),
        config.REQUEST_LOG_RETENTION_SWEEP_INTERVAL_SECONDS * 1000,
      ),
    );
  }

  // Deployment-wide data-residency / ZDR policy (env-config path), computed once.
  const residencyPolicy = residencyPolicyFromEnv(
    config.RESIDENCY_ALLOWED_REGIONS,
    config.RESIDENCY_REQUIRE_ZDR,
  );
  // Boot-time residency guard for DB-config mode: DB routes carry per-provider region/ZDR
  // stamps (provider.region/zdr) that MUST be set for anthropic/openai/azure to satisfy an
  // active policy — an unstamped provider fails CLOSED (denied) on the first reconcile.
  // Warn loudly at boot so this surfaces as a config task, not a silent outage later
  // (Bedrock stamps its region from baseUrl, so it is exempt from the warning).
  if (config.CONFIG_SOURCE === 'db' && !isEmptyResidencyPolicy(residencyPolicy)) {
    log.warn(
      { allowedRegions: residencyPolicy?.allowedRegions, requireZdr: residencyPolicy?.requireZdr },
      'residency policy is active with CONFIG_SOURCE=db: every non-bedrock provider in the ' +
        'config document MUST set region (and zdr where required) or its traffic will be ' +
        'denied (residency_denied) after the next reconcile. Set them on each provider entity.',
    );
  }

  // Per-model budget caps (multi-level enforcement) keyed by their `model:<model>`
  // scope. The set of governed models is what the hot path checks before reserving
  // the extra scope; the map is the cap source (config, not the DB budget table).
  const modelCaps = parseBudgetModelCaps(config.BUDGET_MODEL_CAPS);
  const budgetModelCaps: ReadonlySet<string> = new Set(
    [...modelCaps.keys()].map((k) => k.slice('model:'.length)),
  );
  // Per-attribution caps (runaway-agent control) keyed by attribution dimension
  // (session/dev/repo/…); reserved against `attr:<key>:<value>`.
  const attrCaps = parseBudgetAttrCaps(config.BUDGET_ATTR_CAPS);
  // `attr:<key>:<value>` scope → the cap configured for <key> (the value doesn't
  // affect the cap, only the counter key). Key = the segment between the two colons.
  const attrCapFor = (scopeKey: string): { capMicroUsd: number; periodSeconds?: number } | null => {
    const rest = scopeKey.slice('attr:'.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return null;
    return attrCaps.get(rest.slice(0, sep)) ?? null;
  };
  // Config-sourced caps (per-model + per-attribution) resolve from the parsed
  // config for BOTH stores, so the counter-less (single-node/dev) path enforces
  // them exactly as the Redis path does — otherwise an `attr:` cap would silently
  // no-op in memory (its scope absent from any seed map) while enforcing under
  // Redis. DB-backed workspace budgets still require Redis counters (disabled
  // without them, unchanged).
  const configCapResolver = (scopeKey: string): Budget | null =>
    scopeKey.startsWith('model:')
      ? (modelCaps.get(scopeKey) ?? null)
      : scopeKey.startsWith('attr:')
        ? attrCapFor(scopeKey)
        : null;
  // Caps are memoised (fresh for GOVERNANCE_CACHE_TTL_MS, stale-while-erroring for
  // minutes): the lookup is a per-request admission dependency, and a Postgres blip
  // previously failed every reserve/commit outright.
  const dbCapResolver = memoizeAsync(createBudgetCapResolver(db), {
    ttlMs: config.GOVERNANCE_CACHE_TTL_MS,
    onError: (err) => {
      warnThrottled('cap-resolver', { err }, 'budget cap lookup failed — serving cached cap');
      metrics?.recordStoreError('budget', 'cap_lookup');
    },
  });
  const budgets: BudgetStore = config.REDIS_COUNTERS_URL
    ? new RedisBudgetStore(
        createRedisClient(config.REDIS_COUNTERS_URL, {
          role: 'counters',
          onError: redisLog('counters'),
        }),
        (scopeKey) =>
          // Compose: `model:` + `attr:` scopes resolve from config; else from the DB.
          scopeKey.startsWith('model:') || scopeKey.startsWith('attr:')
            ? Promise.resolve(configCapResolver(scopeKey))
            : dbCapResolver(scopeKey),
        config.BUDGET_RESERVATION_LIFETIME_MS,
      )
    : new InMemoryBudgetStore(configCapResolver);
  // Refresh a live reservation at most this often (well under the lifetime) so a long
  // stream is never swept as an orphan, without adding per-chunk control-plane I/O.
  const budgetReserveRefreshMs = Math.min(
    60_000,
    Math.max(10_000, Math.floor(config.BUDGET_RESERVATION_LIFETIME_MS / 2)),
  );

  // One-time eviction-policy check on the counters Redis (budget + rate-limit + the
  // shared breaker all use it). Pointing it at an `allkeys-lru` instance silently
  // evicts counters under memory pressure → under-charging + cap bypass with no error.
  // A transient probe client keeps the check off the long-lived store clients.
  if (config.REDIS_COUNTERS_URL) {
    const probe = createRedisClient(config.REDIS_COUNTERS_URL, {
      role: 'counters',
      onError: redisLog('counters'),
    });
    void checkEvictionPolicy(probe, 'counters', log).finally(() => {
      void probe.quit().catch(() => {});
    });
  }

  // Self-heal LOST committed budget counters from the durable ledger on boot: a
  // counters-Redis flush resets them to 0 and would over-admit past the hard cap
  // until the window rolls. healCommitted only rebuilds an ABSENT counter (a live
  // one is authoritative and untouched), so this is safe to run unconditionally on
  // every boot. Fire-and-forget (never blocks boot); rebuild seeds the ledger sum,
  // so concurrent replicas rebuilding to the same value is safe.
  if (config.REDIS_COUNTERS_URL && budgets.healCommitted) {
    maintenance('budget_heal', async () => {
      let healed = 0;
      for (const d of await loadBudgetHealData(db)) {
        const r = await budgets.healCommitted?.(d.workspaceId, d.ledgerMicroUsd, d.periodSeconds);
        if (r?.healed) healed += 1;
      }
      return healed;
    })();
  }

  const otel = initTelemetry({
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: config.OTEL_SERVICE_NAME,
  });

  // Prometheus metrics tee off the single telemetry event, so one recordRequest
  // call feeds both OTel spans and the /metrics counters/histograms.
  const telemetry: Telemetry = metrics
    ? {
        recordRequest: (d) => {
          // Telemetry is best-effort and must NEVER break the proxy — isolate each sink
          // so a throw in one can't skip the other, turn a clean 4xx into a 500 on an
          // early-exit path, or reject the fire-and-forget teardown. (safeRecord in the
          // pipeline wraps the outer call too; this keeps the two sinks independent.)
          try {
            otel.recordRequest(d);
          } catch (err) {
            warnThrottled('otel-record', { err }, 'otel recordRequest failed');
          }
          try {
            metrics.record(d);
          } catch (err) {
            warnThrottled('metrics-record', { err }, 'metrics record failed');
          }
        },
        forceFlush: () => otel.forceFlush(),
        shutdown: () => otel.shutdown(),
      }
    : otel;

  // Soft-threshold budget alerts (metric + optional webhook), fired fire-and-forget
  // off the hot path so a slow/failing alert never affects a request.
  const alertThresholds = config.BUDGET_ALERT_THRESHOLDS.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1);
  const alertUrl = config.BUDGET_ALERT_WEBHOOK_URL;
  const budgetAlerter =
    alertThresholds.length > 0
      ? new BudgetAlerter(alertThresholds, (e) => {
          metrics?.recordBudgetAlert(e.threshold);
          if (alertUrl) {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 3000);
            t.unref?.();
            void fetch(alertUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'budget.threshold', ...e }),
              signal: ctrl.signal,
            })
              .catch(() => {})
              .finally(() => clearTimeout(t));
          }
        })
      : undefined;

  // Rate limiting shares the counters Redis with budgets (global, cross-replica);
  // without it, limits fall back to per-replica in-memory counters.
  let rateLimiter: RateLimiter | undefined;
  if (config.RATELIMIT_ENABLED) {
    const store: RateLimitStore = config.REDIS_COUNTERS_URL
      ? new RedisRateLimitStore(
          createRedisClient(config.REDIS_COUNTERS_URL, {
            role: 'counters',
            onError: redisLog('counters'),
          }),
        )
      : new InMemoryRateLimitStore();
    const policy = config.RATELIMIT_FAIL_OPEN ? 'fail_open' : 'fail_closed';
    rateLimiter = new RateLimiter({
      store,
      resolve: memoizeAsync(createRateLimitResolver(db), { ttlMs: config.GOVERNANCE_CACHE_TTL_MS }),
      failOpen: config.RATELIMIT_FAIL_OPEN,
      // A degraded limiter used to be completely silent: no log, no metric.
      onError: (err, stage) => {
        warnThrottled(`ratelimit-${stage}`, { err, stage, policy }, 'rate-limit store unavailable');
        metrics?.recordStoreError('ratelimit', stage === 'commit' ? 'commit' : policy);
      },
    });
  }

  // Batch operational request-log writes off the hot-path teardown; the durable
  // spend ledger stays synchronous. Flushed on the SIGTERM drain via flushLogs.
  const requestLog = new BatchingRequestLog(new PostgresRequestLog(db), {
    maxBatch: config.LOG_BATCH_MAX,
    intervalMs: config.LOG_BATCH_INTERVAL_MS,
    // A failed flush drops the batch (never re-buffered unbounded). It used to drop
    // SILENTLY — the teardown's own catch can never see a batched write fail.
    onError: (err, dropped) => {
      log.error(
        { err, dropped, sink: 'request_log' },
        'request_log batch flush failed — rows dropped',
      );
      metrics?.recordRequestLogDropped(dropped);
    },
  });
  metrics?.setRequestLogBacklogSampler(() => requestLog.backlog());

  // Cross-replica breaker sharing rides the counters Redis (noeviction). The
  // refresh timer is started here and stopped on drain via breakerSync.stop().
  const breakerSync =
    config.BREAKER_SHARED && config.REDIS_COUNTERS_URL
      ? new RedisBreakerSync(
          createRedisClient(config.REDIS_COUNTERS_URL, {
            role: 'counters',
            onError: redisLog('counters'),
          }),
          {
            prefix: config.BREAKER_SHARED_PREFIX,
            refreshMs: config.BREAKER_SHARED_REFRESH_MS,
          },
        )
      : undefined;
  breakerSync?.start();

  metrics?.setBuildInfo({ version: GULLEY_VERSION, node: process.version });
  metrics?.setDegraded(undefined);
  log.info(
    {
      pricingAsOf: PRICING_AS_OF,
      catalog: config.MODELS_CATALOG_FILE ?? 'seed',
      version: GULLEY_VERSION,
    },
    'pricing tables loaded',
  );

  return {
    stopMaintenance: () => {
      for (const stop of maintenanceStops) stop();
    },
    routes,
    keyStore: new PostgresKeyStore(authDb),
    pepper: config.GULLEY_KEY_PEPPER,
    ledger: new PostgresLedger(db),
    requestLog,
    flushLogs: () => requestLog.close(),
    audit: new PostgresAuditSink(db),
    breaker: new CircuitBreaker({
      ...(breakerSync ? { sync: breakerSync } : {}),
      probeTimeoutMs: config.BREAKER_HALF_OPEN_PROBE_TIMEOUT_MS,
      // Surface every breaker transition (open / half_open / closed) as a metric — the
      // key resiliency events. Previously only CLOSED → OPEN was emitted.
      ...(metrics
        ? {
            onOpen: (target: string) => metrics.recordBreakerState(target, 'open'),
            onHalfOpen: (target: string) => metrics.recordBreakerState(target, 'half_open'),
            onClose: (target: string) => metrics.recordBreakerState(target, 'closed'),
          }
        : {}),
    }),
    breakerSync,
    limiter: config.ADAPTIVE_CONCURRENCY_ENABLED
      ? new AdaptiveLimiter({
          minLimit: config.ADAPTIVE_MIN_LIMIT,
          maxLimit: config.ADAPTIVE_MAX_LIMIT,
          initialLimit: config.ADAPTIVE_INITIAL_LIMIT,
          backoffRatio: config.ADAPTIVE_BACKOFF_RATIO,
          smoothing: config.ADAPTIVE_SMOOTHING,
        })
      : undefined,
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
    budgetFailOpen: config.BUDGET_FAIL_OPEN,
    budgetReserveRefreshMs,
    budgetAlerter,
    budgetDownshift:
      config.BUDGET_DOWNSHIFT_MODEL && config.BUDGET_DOWNSHIFT_THRESHOLD > 0
        ? { threshold: config.BUDGET_DOWNSHIFT_THRESHOLD, model: config.BUDGET_DOWNSHIFT_MODEL }
        : undefined,
    budgetModelCaps: budgetModelCaps.size > 0 ? budgetModelCaps : undefined,
    budgetAttrCaps: attrCaps.size > 0 ? new Set(attrCaps.keys()) : undefined,
    playgroundEnabled: config.PLAYGROUND_ENABLED,
    maskVault,
    maskVaultEncryptor,
    maskVaultTtlSeconds: config.MASK_VAULT_TTL_SECONDS,
    telemetry,
    guardrails,
    cache: config.CACHE_ENABLED
      ? buildCache(config, db, log, maintenance, maintenanceStops)
      : undefined,
    rateLimiter,
    metrics,
    modelRouter,
    // Env model policy is a stable floor; DB mode reconcile unions the config
    // document's `policies` OVER it (never dropping it) via envModelPolicy.
    modelPolicy: modelPolicyFromEnv(config.MODEL_ALLOW, config.MODEL_DENY),
    envModelPolicy: modelPolicyFromEnv(config.MODEL_ALLOW, config.MODEL_DENY),
    // Deployment-wide data-residency / ZDR policy (env-config path). Enforced at
    // candidate selection on each upstream's declared region/ZDR; fail-closed.
    residencyPolicy,
    // Cascade routing policies (env-config). Empty = off. Parse THROWS on bad JSON so a
    // malformed policy fails boot rather than silently disabling escalation.
    cascade,
    models: catalogModels,
    rateResolver,
    streamInactivityMs: config.STREAM_INACTIVITY_MS,
    cacheLookupTimeoutMs: config.CACHE_LOOKUP_TIMEOUT_MS,
    upstreamHeadersTimeoutMs: config.UPSTREAM_HEADERS_TIMEOUT_MS,
    inflightTeardowns: new Set<Promise<void>>(),
    retryMaxAttempts: config.RETRY_MAX_ATTEMPTS,
    retryBackoffMs: config.RETRY_BACKOFF_MS,
    authorizer,
    toolPolicy,
    externalAuthorizer,
    externalAuthzSendBody: config.EXTERNAL_AUTHZ_SEND_BODY,
    transformer,
    jwtAuth,
    brokerResolver,
    basicAuth,
    scoreboard: config.LB_LEAST_LOAD ? new LoadScoreboard() : undefined,
    sessionAffinityHeader: config.LB_SESSION_AFFINITY_HEADER,
    accessLog: buildAccessLog(config.ACCESS_LOG_FIELDS, log),
    accessLogSink: config.ACCESS_LOG_OTLP
      ? initAccessLogExporter({
          endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
          serviceName: config.OTEL_SERVICE_NAME,
        })
      : undefined,
    tracePropagation: config.TRACE_PROPAGATION
      ? { sampleRatio: config.TRACE_SAMPLE_RATIO }
      : undefined,
    responseBufferLimit: config.RESPONSE_BUFFER_LIMIT_BYTES,
    bufferFailClosed: config.BUFFER_FAIL_CLOSED,
    chargeOnMissingUsage: config.METER_CHARGE_ON_MISSING_USAGE,
    injectStreamUsage: config.METER_INJECT_STREAM_USAGE,
    meterFailClosedOnUnpriced: config.METER_FAIL_CLOSED_ON_UNPRICED,
    requestDeadlineMs: config.REQUEST_DEADLINE_MS > 0 ? config.REQUEST_DEADLINE_MS : undefined,
    attributionHeaders: config.ATTRIBUTION_HEADERS
      ? config.ATTRIBUTION_HEADERS.split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean)
      : undefined,
    hedgeDelayMs: config.HEDGE_DELAY_MS > 0 ? config.HEDGE_DELAY_MS : undefined,
    spotlightUntrusted: config.GUARDRAILS_SPOTLIGHT,
    spotlightDirective: config.GUARDRAILS_SPOTLIGHT_DIRECTIVE,
    streamEnforce: config.STREAMING_ENFORCE,
    streamEnforceWindowChars: config.STREAMING_ENFORCE_WINDOW_CHARS,
    headerModifier,
    mirror,
    tracer: config.DEBUG_TRACE_TOKEN ? new RequestTracer(config.DEBUG_TRACE_BUFFER) : undefined,
    debugTraceToken: config.DEBUG_TRACE_TOKEN,
    // Multi-tenant per-tenant upstream credentials (db config mode): each tenant
    // authenticates upstream with its own key, resolved from Postgres + secrets.
    tenantCredentials: secretResolver
      ? new DbTenantCredentialResolver(db, secretResolver)
      : undefined,
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
export function buildAccessLog(
  raw: string | undefined,
  log: BootLogger = consoleLog,
): AccessLogFieldEngine | undefined {
  if (!raw) return undefined;
  try {
    return new AccessLogFieldEngine(JSON.parse(raw) as AccessLogConfig);
  } catch (err) {
    log.warn(
      { err },
      `ACCESS_LOG_FIELDS is invalid; access log disabled: ${(err as Error).message}`,
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
