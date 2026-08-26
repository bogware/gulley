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

  // Model cost catalog — an operator-maintained JSON file (a CatalogEntry[])
  // loaded on boot to override/extend the in-tree seed prices. Regenerate it
  // manually from models.dev with `pnpm --filter @gulley/gateway catalog:refresh`
  // (per the manual-updates rule; there is no runtime auto-fetch).
  MODELS_CATALOG_FILE: z.string().optional(),
  MODELS_DEV_URL: z.string().url().default('https://models.dev/api.json'),

  // Inbound JWT/JWKS auth mode (data plane) — clients authenticate with their
  // IdP's JWT alongside virtual keys. Enabled when JWT_ISSUER + JWT_AUDIENCE set.
  // Scope comes from claims (falling back to the JWT_DEFAULT_* below).
  JWT_ISSUER: z.string().url().optional(),
  JWT_AUDIENCE: z.string().optional(),
  JWT_WORKSPACE_CLAIM: z.string().default('gulley_workspace'),
  JWT_ORG_CLAIM: z.string().default('gulley_org'),
  JWT_MODELS_CLAIM: z.string().optional(),
  JWT_PROVIDERS_CLAIM: z.string().optional(),
  JWT_DEFAULT_WORKSPACE_ID: z.string().optional(),
  JWT_DEFAULT_ORG_ID: z.string().optional(),

  // Inbound HTTP Basic auth (data plane) — front the gateway with a standard
  // htpasswd file (bcrypt/apr1/SHA/plaintext). Enabled when BASIC_AUTH_HTPASSWD
  // (inline file body) or BASIC_AUTH_HTPASSWD_FILE (path) plus the default
  // org/workspace are set. Per-user scope overrides via BASIC_AUTH_USER_SCOPES,
  // a JSON object: {"alice":{"workspaceId":"ws_a","allowedModels":["..."]}}.
  BASIC_AUTH_HTPASSWD: z.string().optional(),
  BASIC_AUTH_HTPASSWD_FILE: z.string().optional(),
  BASIC_AUTH_USER_SCOPES: z.string().optional(),
  BASIC_AUTH_DEFAULT_WORKSPACE_ID: z.string().optional(),
  BASIC_AUTH_DEFAULT_ORG_ID: z.string().optional(),
  // Default allow-list for Basic users NOT named in BASIC_AUTH_USER_SCOPES.
  // Deny-by-default: unset = the user can reach nothing. Comma-separated ids, or
  // "*" to allow all (opt-in). Per-user overrides always win.
  BASIC_AUTH_DEFAULT_ALLOWED_PROVIDERS: z.string().optional(),
  BASIC_AUTH_DEFAULT_ALLOWED_MODELS: z.string().optional(),

  // CEL authorization rules — a JSON array of { expr, effect: allow|deny, name? }.
  // Deny-first, then allow-list; expressions run over { request, principal }.
  // e.g. [{"effect":"deny","expr":"request.model.startsWith(\"experimental-\")"}]
  CEL_AUTHZ: z.string().optional(),
  // CEL transformation — JSON { requestHeaders?, responseHeaders?, requestBody? }.
  // Each header/body value is a CEL expression over { request, principal }.
  CEL_TRANSFORM: z.string().optional(),

  // External authorization hook — delegate allow/deny to an operator HTTP policy
  // service (the { request, principal } activation is POSTed; { allow, reason }
  // returned). Decisions are cached (TTL) + single-flighted. Runs after CEL rules.
  EXTERNAL_AUTHZ_URL: z.string().url().optional(),
  EXTERNAL_AUTHZ_CACHE_KEY: z.string().optional(),
  EXTERNAL_AUTHZ_TTL_MS: z.coerce.number().int().positive().default(30_000),
  EXTERNAL_AUTHZ_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
  EXTERNAL_AUTHZ_FAIL_OPEN: envBool(false),
  EXTERNAL_AUTHZ_ALLOW_INTERNAL: envBool(false),
  // Include the prompt body in what is sent to the policy service (default off —
  // credential headers are NEVER sent). Opting in also makes the decision cache
  // key body-specific, so a distinct prompt is a distinct cache entry.
  EXTERNAL_AUTHZ_SEND_BODY: envBool(false),

  // Custom / OpenAI-compatible providers — a JSON array of entries, each either
  // { "preset": "ollama"|"groq"|…, "models": [...] } or a bespoke
  // { "provider": "x", "baseUrl": "http://…", "apiKey"?: "…", "models": [...] }.
  // Presets cover hosted (Groq/Mistral/Together/OpenRouter/DeepSeek/…) and local
  // runtimes (Ollama/Jan/LM Studio/vLLM/LocalAI/llama.cpp). Local runtimes are
  // keyless http on loopback — server-side config, not an SSRF vector.
  CUSTOM_PROVIDERS: z.string().optional(),

  DATABASE_URL: z.string().url().optional(),
  // Redis counters (budget reserve/commit). Absent = budgets disabled.
  REDIS_COUNTERS_URL: z.string().url().optional(),
  // Redis for the exact cache / Redis Stack vector index (when selected).
  REDIS_CACHE_URL: z.string().url().optional(),
  REDIS_VECTOR_URL: z.string().url().optional(),
  // OpenTelemetry OTLP/HTTP export. Absent = telemetry disabled.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('gulley-gateway'),

  // Prometheus /metrics on a SEPARATE management listener (not the data port),
  // so scrape traffic never mixes with client traffic.
  METRICS_ENABLED: envBool(true),
  METRICS_PORT: z.coerce.number().int().positive().default(9090),
  METRICS_HOST: z.string().default('0.0.0.0'),

  // Guardrails — native PII/secret detection. Audit-only by default (records
  // findings + telemetry, never mutates payloads); block/mask/redact are set
  // per-route in code. Detection runs on request and response text.
  GUARDRAILS_ENABLED: envBool(true),
  GUARDRAILS_ENTROPY: envBool(true),
  // Optional bring-your-own-DLP webhook guardrail (runs on request input). A
  // block/mask verdict is authoritative even under the audit-only default.
  GUARDRAILS_WEBHOOK_URL: z.string().url().optional(),
  GUARDRAILS_WEBHOOK_FAIL_CLOSED: envBool(false),
  GUARDRAILS_WEBHOOK_ALLOW_INTERNAL: envBool(false),
  // Managed guardrail plugins (composed with the native detectors + webhook).
  GUARDRAILS_MODERATION_API_KEY: z.string().optional(),
  GUARDRAILS_MODERATION_BASE_URL: z.string().url().optional(),
  GUARDRAILS_MODERATION_MODEL: z.string().optional(),
  GUARDRAILS_AZURE_CS_ENDPOINT: z.string().url().optional(),
  GUARDRAILS_AZURE_CS_KEY: z.string().optional(),
  GUARDRAILS_AZURE_CS_SEVERITY: z.coerce.number().int().min(0).max(7).default(4),
  GUARDRAILS_BEDROCK_GUARDRAIL_ID: z.string().optional(),
  GUARDRAILS_BEDROCK_API_KEY: z.string().optional(),
  GUARDRAILS_BEDROCK_REGION: z.string().optional(),
  // Google Cloud Model Armor (prompt/response sanitization). Needs a GCP OAuth2
  // access token — supply a (refreshed) token here; production wires a provider.
  GUARDRAILS_MODEL_ARMOR_PROJECT: z.string().optional(),
  GUARDRAILS_MODEL_ARMOR_LOCATION: z.string().optional(),
  GUARDRAILS_MODEL_ARMOR_TEMPLATE: z.string().optional(),
  GUARDRAILS_MODEL_ARMOR_ACCESS_TOKEN: z.string().optional(),

  // Same-target retry (pre-first-byte, body already buffered): bounded attempts
  // on transient errors before failing over to the next candidate. Default 1 =
  // no retry (behavior unchanged). Backoff is exponential, floored by Retry-After.
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(1),
  RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(250),

  // Passive outlier detection: eject a target whose EWMA time-to-response-headers
  // is >= OUTLIER_LATENCY_FACTOR x the peer baseline (and above the floor), even
  // with zero errors; re-probed by time. Off by default (error/failure rules
  // still apply). Independent of the fault circuit breaker.
  OUTLIER_ENABLED: envBool(false),
  OUTLIER_LATENCY_FACTOR: z.coerce.number().positive().default(3),
  OUTLIER_MIN_SAMPLES: z.coerce.number().int().positive().default(20),
  OUTLIER_MIN_EJECT_MS: z.coerce.number().int().positive().default(500),
  OUTLIER_BASE_EJECT_MS: z.coerce.number().int().positive().default(30_000),
  OUTLIER_MAX_EJECT_MS: z.coerce.number().int().positive().default(300_000),

  // Load balancing across a loadbalance strategy's targets. When affinity is off
  // (default) the primary pick uses power-of-two-choices least-load over in-flight
  // counts. Setting LB_SESSION_AFFINITY_HEADER pins a session (that header's
  // value, else the principal id) to one target via rendezvous hashing (HRW).
  LB_LEAST_LOAD: envBool(true),
  LB_SESSION_AFFINITY_HEADER: z.string().optional(),

  // Access log — an operator-configurable field engine over a credential-free
  // per-request record (CEL-valued fields, remove/filter/flatten). JSON:
  // {"add":{"cost_usd":"costMicroUsd/1000000.0"},"remove":["route"],"filter":"statusCode>=400"}
  ACCESS_LOG_FIELDS: z.string().optional(),

  // Distributed tracing — continue a client's W3C traceparent (or start one) and
  // inject it into the upstream request, stamping the trace id on the span +
  // access log. Off by default; sample ratio applies only to freshly-started
  // traces (an inbound sampled decision is always honored).
  TRACE_PROPAGATION: envBool(false),
  TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),

  // Response buffering cap for non-streamed metering / buffered output enforcement.
  // When a buffered-enforcement body exceeds this, the guardrail can't see the
  // whole response: BUFFER_FAIL_CLOSED (default) WITHHOLDS it; fail-open forwards
  // the truncated body flagged as unenforced.
  RESPONSE_BUFFER_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  BUFFER_FAIL_CLOSED: envBool(true),

  // Static request/response header set/remove applied to every proxied request
  // (the non-CEL sibling of CEL_TRANSFORM). JSON:
  // {"request":{"set":{"x-tenant":"acme"}},"response":{"remove":["x-internal"]}}
  HEADER_MODIFIER: z.string().optional(),

  // Request mirror (shadow traffic) — a sampled, fire-and-forget copy of the
  // EFFECTIVE (masked/shaped) request POSTed to a second endpoint, never metered.
  // JSON: {"url":"https://shadow/v1/messages","sampleRate":0.1,"headers":{...}}
  REQUEST_MIRROR: z.string().optional(),
  REQUEST_MIRROR_ALLOW_INTERNAL: envBool(false),

  // Request-log batching — buffer operational log writes off the hot-path
  // teardown and flush in bulk. The durable spend ledger stays synchronous.
  LOG_BATCH_MAX: z.coerce.number().int().positive().default(100),
  LOG_BATCH_INTERVAL_MS: z.coerce.number().int().positive().default(1000),

  // Rate limiting — RPM/TPM fixed windows resolved per workspace from the
  // rate_limit table (no rows = no limiting). Global counters use the same Redis
  // counters cluster as budgets; without it, limits are per-replica (in-memory).
  // fail_open admits requests when the limiter backend errors (availability).
  RATELIMIT_ENABLED: envBool(true),
  RATELIMIT_FAIL_OPEN: envBool(true),

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
