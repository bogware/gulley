import { z } from 'zod';

/** Env booleans: unset -> default; otherwise truthy only for 1/true/yes/on.
 *  (z.coerce.boolean treats any non-empty string as true, including "false".) */
const envBool = (def: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined ? def : typeof v === 'string' ? /^(1|true|yes|on)$/i.test(v) : Boolean(v),
    z.boolean(),
  );

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  GATEWAY_PORT: z.coerce.number().int().positive().default(8080),

  // Virtual-key pepper (KMS-held in prod). Optional so the server boots for
  // health checks; the proxy routes require it via the production context.
  GULLEY_KEY_PEPPER: z.string().min(1).optional(),

  // Upstream provider credentials held centrally by the gateway (v1). A provider
  // route is registered only when its key is present.
  ANTHROPIC_UPSTREAM_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  OPENAI_UPSTREAM_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com'),
  BEDROCK_UPSTREAM_API_KEY: z.string().min(1).optional(),
  BEDROCK_REGION: z.string().default('us-east-1'),
  // Azure AI Foundry / Azure OpenAI: resource endpoint + api-key (Entra later).
  AZURE_ENDPOINT: z.string().url().optional(),
  AZURE_UPSTREAM_API_KEY: z.string().min(1).optional(),

  DATABASE_URL: z.string().url().optional(),
  // Redis counters (budget reserve/commit). Absent = budgets disabled.
  REDIS_COUNTERS_URL: z.string().url().optional(),
  // Redis for the exact cache / Redis Stack vector index (when selected).
  REDIS_CACHE_URL: z.string().url().optional(),
  REDIS_VECTOR_URL: z.string().url().optional(),
  // OpenTelemetry OTLP/HTTP export. Absent = telemetry disabled.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('gulley-gateway'),

  // Guardrails — native PII/secret detection. Audit-only by default (records
  // findings + telemetry, never mutates payloads); block/mask/redact are set
  // per-route in code. Detection runs on request and response text.
  GUARDRAILS_ENABLED: envBool(true),
  GUARDRAILS_ENTROPY: envBool(true),

  // Two-tier response cache. Off by default; opt in per deployment.
  CACHE_ENABLED: envBool(false),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CACHE_SEMANTIC_ENABLED: envBool(false),
  CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  // Vector index backing the semantic tier: pgvector (default), in-memory, or
  // Redis Stack. pgvector/redis need their respective stores configured.
  CACHE_VECTOR_BACKEND: z.enum(['pgvector', 'memory', 'redis']).default('pgvector'),
  CACHE_EXACT_BACKEND: z.enum(['postgres', 'memory', 'redis']).default('postgres'),
  // Embeddings for the semantic tier (OpenAI-compatible).
  EMBEDDINGS_API_KEY: z.string().min(1).optional(),
  EMBEDDINGS_BASE_URL: z.string().url().default('https://api.openai.com'),
  EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDINGS_DIMENSIONS: z.coerce.number().int().positive().default(256),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(source);
}
