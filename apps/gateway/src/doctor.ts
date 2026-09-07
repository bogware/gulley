import { type Config, loadConfig } from './config';

/** A single preflight finding. `error` fails the check (non-zero exit); `warn` is
 *  advisory; `ok`/`info` are informational. */
export interface DoctorFinding {
  level: 'ok' | 'info' | 'warn' | 'error';
  check: string;
  detail: string;
}

/**
 * `gulley doctor` — a static coherence check over the gateway config that fails
 * loudly on the built-but-unwired footguns and Tier-0 knobs, so a misconfiguration
 * surfaces as a boot/CI error instead of a silent production gap. Pure over Config
 * (no I/O) so it is unit-testable and safe to run anywhere.
 */
export function runDoctor(config: Config): DoctorFinding[] {
  const f: DoctorFinding[] = [];
  const prod = config.NODE_ENV === 'production';
  const hasUpstreamKey = Boolean(
    config.ANTHROPIC_UPSTREAM_API_KEY ||
    config.OPENAI_UPSTREAM_API_KEY ||
    config.BEDROCK_UPSTREAM_API_KEY ||
    config.AZURE_UPSTREAM_API_KEY ||
    config.CUSTOM_PROVIDERS,
  );

  // Routes: an env-config gateway with no provider key has no routes, so /ready
  // stays 503 forever. A db-config gateway loads routes from Postgres — fine.
  if (config.CONFIG_SOURCE === 'env' && !hasUpstreamKey) {
    f.push({
      level: 'error',
      check: 'providers',
      detail:
        'No upstream provider key or CUSTOM_PROVIDERS set and CONFIG_SOURCE=env — the gateway will register no routes and /ready will stay 503.',
    });
  } else {
    f.push({ level: 'ok', check: 'providers', detail: 'at least one route source is configured' });
  }

  // Config source coherence.
  if (config.CONFIG_SOURCE === 'db' && !config.DATABASE_URL) {
    f.push({
      level: 'error',
      check: 'config-source',
      detail: 'CONFIG_SOURCE=db requires DATABASE_URL (the config document lives in Postgres).',
    });
  } else if (config.CONFIG_SOURCE === 'env' && config.DATABASE_URL) {
    f.push({
      level: 'warn',
      check: 'config-source',
      detail:
        'DATABASE_URL is set but CONFIG_SOURCE=env — GitOps config + hot-reload are inactive; the gateway reads routes from env only.',
    });
  }

  // Config convergence: db config with the poll off relies on NOTIFY alone (whose
  // control-plane emit half may be unwired), so a missed event never converges.
  if (config.CONFIG_SOURCE === 'db' && config.CONFIG_POLL_INTERVAL_SECONDS === 0) {
    f.push({
      level: 'warn',
      check: 'config-convergence',
      detail:
        'CONFIG_POLL_INTERVAL_SECONDS=0 — convergence relies on NOTIFY only; a missed/never-emitted signal leaves a replica stale after boot. Set a poll interval (e.g. 30).',
    });
  }

  // Budgets / rate limits need the counters Redis to actually enforce.
  const wantsCounters =
    config.BUDGET_DOWNSHIFT_THRESHOLD > 0 ||
    Boolean(config.BUDGET_MODEL_CAPS) ||
    Boolean(config.BUDGET_ALERT_WEBHOOK_URL);
  if (!config.REDIS_COUNTERS_URL && wantsCounters) {
    f.push({
      level: 'warn',
      check: 'budgets',
      detail:
        'Budget caps/downshift/alerts are configured but REDIS_COUNTERS_URL is absent — budget reserve/commit is disabled, so caps are NOT enforced.',
    });
  }

  // Mask-vault persistence without KMS is per-process only: a record written by one
  // replica can't be decrypted by another (or by control-api reveal).
  if (config.MASK_VAULT_PERSIST && !config.GULLEY_KMS_KEY_ARN) {
    f.push({
      level: prod ? 'error' : 'warn',
      check: 'mask-vault',
      detail:
        'MASK_VAULT_PERSIST is on without GULLEY_KMS_KEY_ARN — the in-memory per-process cipher makes reversal records unreadable across replicas and by control-api reveal.',
    });
  }

  // Source-IP trust: a bare trustProxy=true lets X-Forwarded-For spoof request.ip,
  // defeating any CEL source-IP rule.
  if (config.TRUST_PROXY.trim().toLowerCase() === 'true' && config.CEL_AUTHZ) {
    f.push({
      level: 'warn',
      check: 'trust-proxy',
      detail:
        'A CEL authz rule is set with TRUST_PROXY=true — request.ip (source_ip) is spoofable via X-Forwarded-For. Pin a hop count or trusted CIDR.',
    });
  }

  // Semantic cache needs embeddings, and pgvector needs the postgres exact tier
  // (the semantic_vector FK references cache_entry) or every upsert silently fails.
  if (config.CACHE_ENABLED && config.CACHE_SEMANTIC_ENABLED) {
    if (!config.EMBEDDINGS_API_KEY) {
      f.push({
        level: 'error',
        check: 'cache-semantic',
        detail:
          'CACHE_SEMANTIC_ENABLED is on without EMBEDDINGS_API_KEY — every cache miss pays a failing embed round-trip and the semantic tier never works.',
      });
    }
    if (config.CACHE_VECTOR_BACKEND === 'pgvector' && config.CACHE_EXACT_BACKEND !== 'postgres') {
      f.push({
        level: 'error',
        check: 'cache-backends',
        detail: `CACHE_VECTOR_BACKEND=pgvector requires CACHE_EXACT_BACKEND=postgres (semantic_vector references cache_entry); with '${config.CACHE_EXACT_BACKEND}' every upsert violates the FK and semantic caching silently never stores.`,
      });
    }
  }

  // Body limit sanity: below ~1 MiB will 413 real coding prompts.
  if (config.MAX_REQUEST_BYTES < 1024 * 1024) {
    f.push({
      level: 'warn',
      check: 'body-limit',
      detail: `MAX_REQUEST_BYTES=${config.MAX_REQUEST_BYTES} is below 1 MiB — long-context / multimodal coding requests will 413.`,
    });
  }

  // Streaming enforcement with guardrails off does nothing.
  if (config.STREAMING_ENFORCE && !config.GUARDRAILS_ENABLED) {
    f.push({
      level: 'warn',
      check: 'streaming-enforce',
      detail:
        'STREAMING_ENFORCE is on but GUARDRAILS_ENABLED is off — no output policy to enforce.',
    });
  }

  // Air-gapped readiness: egress is fail-closed, so any feature that reaches a PUBLIC
  // host (not an *_ALLOW_INTERNAL internal service) will be blocked. Surface those so a
  // sovereign/offline deployment fails loudly at preflight, not silently at runtime.
  if (config.AIR_GAPPED) {
    f.push({
      level: 'info',
      check: 'air-gapped',
      detail:
        'AIR_GAPPED is on — guarded egress is deny-by-default; only *_ALLOW_INTERNAL services and allowlisted hosts are reachable. Providers must be internal upstreams.',
    });
    if (!config.MODELS_CATALOG_FILE) {
      f.push({
        level: 'warn',
        check: 'air-gapped',
        detail:
          'AIR_GAPPED without MODELS_CATALOG_FILE — pricing falls back to in-tree seeds and no models.dev refresh is possible offline. Pin a catalog file.',
      });
    }
    if (config.GUARDRAILS_WEBHOOK_URL && !config.GUARDRAILS_WEBHOOK_ALLOW_INTERNAL) {
      f.push({
        level: 'warn',
        check: 'air-gapped',
        detail:
          'A DLP webhook is set but GUARDRAILS_WEBHOOK_ALLOW_INTERNAL is off — air-gapped egress will block it. Point it at an internal service and set the ALLOW_INTERNAL flag.',
      });
    }
    if (config.EXTERNAL_AUTHZ_URL && !config.EXTERNAL_AUTHZ_ALLOW_INTERNAL) {
      f.push({
        level: 'warn',
        check: 'air-gapped',
        detail:
          'EXTERNAL_AUTHZ_URL is set but EXTERNAL_AUTHZ_ALLOW_INTERNAL is off — air-gapped egress will block the authz hook. Use an internal endpoint + ALLOW_INTERNAL.',
      });
    }
    if (
      config.GUARDRAILS_MODERATION_BASE_URL ||
      config.GUARDRAILS_AZURE_CS_ENDPOINT ||
      config.GUARDRAILS_MODEL_ARMOR_PROJECT
    ) {
      f.push({
        level: 'warn',
        check: 'air-gapped',
        detail:
          'A managed guardrail plugin (OpenAI moderation / Azure Content Safety / Model Armor) calls a public cloud API — unavailable air-gapped. Rely on the native detectors + an internal DLP webhook.',
      });
    }
  }

  return f;
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('gulley doctor: config failed to load —', (err as Error).message);
    process.exit(2);
  }
  const findings = runDoctor(config);
  const icon = { ok: '✓', info: 'ℹ', warn: '⚠', error: '✗' } as const;
  for (const x of findings) {
    console.log(`${icon[x.level]} [${x.check}] ${x.detail}`);
  }
  const errors = findings.filter((x) => x.level === 'error').length;
  const warns = findings.filter((x) => x.level === 'warn').length;
  console.log(`\ngulley doctor: ${errors} error(s), ${warns} warning(s).`);
  process.exit(errors > 0 ? 1 : 0);
}

// Run only when invoked directly (tsx src/doctor.ts), not when imported by a test.
if (process.argv[1] && /doctor\.ts$/.test(process.argv[1])) main();
