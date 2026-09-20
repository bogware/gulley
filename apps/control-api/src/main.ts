import {
  type AsymmetricSigner,
  InMemoryAesCipher,
  InMemoryHmacSigner,
  KmsEnvelopeEncryptor,
  KmsSigner,
} from '@gulley/crypto';
import { loadCatalogFromFile } from '@gulley/catalog';
import type { RateResolver } from '@gulley/cost';
import { assertEgressAllowed, setAirGappedEgress } from '@gulley/egress';
import { EntraGraphIdp } from '@gulley/oauth';
import { OidcProvider } from '@gulley/oidc';
import { createListenConnection, PostgresConfigBus, purgeExpiredOAuthCodes } from '@gulley/storage';
import { S3AuditMirror } from '@gulley/worm';
import pino from 'pino';
import { type Anchor, HttpAnchor } from './anchor';
import { buildSiemConnector, type SiemConnector } from './siem';
import { type EvalRunner, GatewayEvalRunner } from './eval-runner';
import { buildGatewayMetricsProvider } from './gateway-metrics';
import { signCtxAttestation } from './audit-signing';
import { type Config, loadConfig, outboundAllowlist, sessionSecrets } from './config';
import {
  type ControlContext,
  createInMemoryControlContext,
  type InMemoryContextOptions,
  type OidcSessionConfig,
} from './context';
import { parseRoleMap } from './oidc-gate';
import { buildServer, LOG_REDACT_PATHS } from './server';
import {
  anthropicAdminUsageSource,
  openAiUsageSource,
  type ProviderUsageSource,
} from './shadow-spend';

/** The config-propagation emitter, if a durable config store is wired. A
 *  successful /config/apply emits a NOTIFY over this so gateway replicas reconcile
 *  live; held here so the drain can close its connection. */
let configBus: PostgresConfigBus | undefined;

/**
 * WORM-live wiring from env. Requires the mirror bucket, a batch signing key, AND a
 * durable DB (the complete chain is read from Postgres — shipping an in-memory chain
 * from a stateless replica would sign an incomplete artifact). Returns undefined when
 * disabled; logs a warning when WORM_ENABLED is set but a prerequisite is missing so a
 * misconfiguration doesn't fail silently.
 */
function buildWorm(
  config: Config,
  auditSigner: AsymmetricSigner | undefined,
  warn: (msg: string) => void,
): InMemoryContextOptions['worm'] {
  if (!config.WORM_ENABLED) return undefined;
  // A batch signer is required: prefer the audit-export asymmetric CMK (auditor
  // verifies offline with the public key), else the shared-secret HMAC key.
  const signer = auditSigner ?? signerFromHmac(config.WORM_SIGNING_KEY);
  if (!config.WORM_BUCKET || !signer || !config.DATABASE_URL) {
    warn(
      'WORM_ENABLED but WORM_BUCKET / a signing key (GULLEY_AUDIT_SIGNING_KMS_ARN or ' +
        'WORM_SIGNING_KEY) / DATABASE_URL incomplete — WORM disabled',
    );
    return undefined;
  }
  const mirror = new S3AuditMirror({
    bucket: config.WORM_BUCKET,
    region: config.WORM_REGION,
    prefix: config.WORM_PREFIX,
    retentionDays: config.WORM_RETENTION_DAYS,
  });
  return { mirror, signer, verifier: signer, batchMax: config.WORM_BATCH_MAX };
}

function signerFromHmac(key: string | undefined): InMemoryHmacSigner | undefined {
  return key ? new InMemoryHmacSigner(Buffer.from(key, 'utf8')) : undefined;
}

/** External anchor sink (SSRF-guarded HTTP), if AUDIT_ANCHOR_URL is set. */
function buildAnchor(config: Config): Anchor | undefined {
  if (!config.AUDIT_ANCHOR_URL) return undefined;
  return new HttpAnchor(config.AUDIT_ANCHOR_URL, {
    allowlist: outboundAllowlist(config),
    ...(config.AUDIT_ANCHOR_AUTHZ ? { headers: { authorization: config.AUDIT_ANCHOR_AUTHZ } } : {}),
  });
}

/** SIEM connector (SSRF-guarded), if SIEM_KIND is set. Requires DATABASE_URL — the
 *  export reads the durable chain, not an in-memory replica. buildSiemConnector throws
 *  on a missing credential so a misconfig fails boot. */
function buildSiem(
  config: Config,
  warn: (msg: string) => void,
): { connector: SiemConnector; batchMax: number } | undefined {
  if (!config.SIEM_KIND) return undefined;
  if (!config.DATABASE_URL) {
    warn('SIEM_KIND set but DATABASE_URL missing — SIEM export disabled');
    return undefined;
  }
  const connector = buildSiemConnector(
    {
      kind: config.SIEM_KIND,
      url: config.SIEM_URL,
      token: config.SIEM_TOKEN,
      workspaceId: config.SIEM_WORKSPACE_ID,
      sharedKey: config.SIEM_SHARED_KEY,
      authorization: config.SIEM_AUTHZ,
      logType: config.SIEM_LOG_TYPE,
    },
    { allowlist: outboundAllowlist(config) },
  );
  return connector ? { connector, batchMax: config.SIEM_BATCH_MAX } : undefined;
}

/** Gateway-backed eval runner for the rollout controller. Present only when a gateway
 *  URL + eval key are configured; the gateway host must be egress-allowlisted. With a
 *  models catalog the cost scorer is priced, else cost is reported null. */
function buildEvalRunner(config: Config, warn: (msg: string) => void): EvalRunner | undefined {
  if (!config.EVAL_ROLLOUT_ENABLED) return undefined;
  if (!config.EVAL_GATEWAY_URL || !config.EVAL_GATEWAY_KEY) {
    warn(
      'EVAL_ROLLOUT_ENABLED set but EVAL_GATEWAY_URL/EVAL_GATEWAY_KEY missing — rollout run disabled',
    );
    return undefined;
  }
  let rateResolver: RateResolver | undefined;
  if (config.MODELS_CATALOG_FILE) {
    try {
      rateResolver = loadCatalogFromFile(config.MODELS_CATALOG_FILE).resolver();
    } catch (err) {
      warn(`failed to load MODELS_CATALOG_FILE for eval cost scoring: ${(err as Error).message}`);
    }
  }
  return new GatewayEvalRunner({
    gatewayUrl: config.EVAL_GATEWAY_URL,
    apiKey: config.EVAL_GATEWAY_KEY,
    allowlist: outboundAllowlist(config),
    rateResolver,
    timeoutMs: config.EVAL_TIMEOUT_MS,
    defaultMaxTokens: config.EVAL_MAX_TOKENS,
  });
}

/**
 * Build the control-plane context from env. In-memory stores are the current
 * production seam (a Postgres-backed context is a documented follow-up), but this
 * lets the admin console + OIDC gate run for real in dev. Returns undefined when
 * no admin credentials are configured (the server then boots health-only).
 */
function buildContext(config: Config): ControlContext | undefined {
  const secrets = sessionSecrets(config);
  if (secrets.length === 0 && !config.CONTROL_API_BOOTSTRAP_ENABLED) return undefined;

  let oidc: OidcSessionConfig | undefined;
  if (config.OIDC_ISSUER && config.OIDC_CLIENT_ID) {
    // Every IdP URL (discovery, JWKS, the advertised token/authorize endpoints) goes
    // through the same SSRF/air-gap egress guard as any other control-plane outbound,
    // and production requires https end to end (the client secret rides token_endpoint).
    const assertOidcEgress = (url: string): void => {
      assertEgressAllowed(url, { allowlist: outboundAllowlist(config) });
    };
    oidc = {
      provider: new OidcProvider(config.OIDC_ISSUER, {
        fetchTimeoutMs: config.OIDC_FETCH_TIMEOUT_MS,
        guard: {
          assertAllowed: assertOidcEgress,
          requireHttps: config.NODE_ENV === 'production' && !config.OIDC_ALLOW_INSECURE_HTTP,
        },
      }),
      clientId: config.OIDC_CLIENT_ID,
      clientSecret: config.OIDC_CLIENT_SECRET,
      redirectUri: config.OIDC_REDIRECT_URI,
      scopes: config.OIDC_SCOPES,
      groupsClaim: config.OIDC_GROUPS_CLAIM,
      roleRules: parseRoleMap(config.OIDC_ROLE_MAP),
      postLoginRedirect: config.OIDC_POST_LOGIN_REDIRECT,
      cookieSecure: config.OIDC_COOKIE_SECURE,
      subjectClaim: config.OIDC_SUBJECT_CLAIM,
      exchangeTimeoutMs: config.OIDC_FETCH_TIMEOUT_MS,
      assertEgress: assertOidcEgress,
    };
  }

  // Config propagation: emit a NOTIFY on a successful apply so gateway replicas
  // reconcile live. Emit-only (never .start()); a dedicated connection just carries
  // the NOTIFY. Only with a durable store — without a DB there is nothing to
  // propagate. Gateways also converge via their version poll, so this is the
  // latency upgrade, not the sole path; NOTIFY to a channel with no listeners is a
  // no-op, so emitting unconditionally-with-a-DB is safe.
  if (config.DATABASE_URL) {
    configBus = new PostgresConfigBus(
      createListenConnection(config.DATABASE_URL),
      config.CONFIG_NOTIFY_CHANNEL,
      // (Re)connect hook: LISTEN drops signals while the socket is down — resync.
      () => void rehydrate('listen-reconnect'),
    );
  }

  // Shadow-spend ingest: one usage/cost source per provider whose org Admin key is
  // configured. Egress is guarded and constrained to the outbound allowlist.
  const providerUsageSources: ProviderUsageSource[] = [];
  const usageClientOpts = { allowlist: outboundAllowlist(config) };
  if (config.ANTHROPIC_ADMIN_API_KEY) {
    providerUsageSources.push(
      anthropicAdminUsageSource(config.ANTHROPIC_ADMIN_API_KEY, usageClientOpts),
    );
  }
  if (config.OPENAI_ADMIN_API_KEY) {
    providerUsageSources.push(openAiUsageSource(config.OPENAI_ADMIN_API_KEY, usageClientOpts));
  }

  // Audit-export asymmetric signer (KMS). When configured it signs the auditor
  // attestation AND the WORM batches, and its public key is published so an auditor
  // verifies both offline. Region from GULLEY_KMS_REGION (shared with the mask vault).
  const auditSigner: AsymmetricSigner | undefined = config.GULLEY_AUDIT_SIGNING_KMS_ARN
    ? new KmsSigner(
        config.GULLEY_AUDIT_SIGNING_KMS_ARN,
        config.GULLEY_KMS_REGION,
        config.GULLEY_AUDIT_SIGNING_ALG,
      )
    : undefined;

  return createInMemoryControlContext({
    pepper: config.GULLEY_KEY_PEPPER ?? '',
    bootstrapEnabled: config.CONTROL_API_BOOTSTRAP_ENABLED,
    bootstrapTokenSha256: config.GULLEY_BOOTSTRAP_ADMIN_TOKEN_SHA256,
    sessionSecrets: secrets,
    maxSessionTtlMs: config.ADMIN_SESSION_MAX_MS,
    outboundAllowlist: outboundAllowlist(config),
    gatewayPublicUrl: config.GATEWAY_PUBLIC_URL,
    controlApiPublicUrl: config.CONTROL_API_PUBLIC_URL,
    consolePublicUrl: config.CONSOLE_PUBLIC_URL,
    onboardingSigningKey: config.ONBOARDING_SIGNING_KEY,
    providerUsageSources,
    shadowSpendFlagBps: config.SHADOW_SPEND_FLAG_BPS,
    oidc,
    databaseUrl: config.DATABASE_URL,
    dbConnectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    notifier: configBus,
    attestationKey: config.AUDIT_ATTESTATION_KEY,
    attestationSubject: config.AUDIT_ATTESTATION_SUBJECT,
    auditSigner,
    worm: buildWorm(config, auditSigner, bootWarn),
    anchor: buildAnchor(config),
    siem: buildSiem(config, bootWarn),
    // Mask-vault reveal decryptor — the SAME envelope key the gateway used (KMS in
    // prod; the in-memory dev cipher only decrypts records written in-process).
    maskVaultEncryptor: config.MASK_VAULT_ENABLED
      ? config.GULLEY_KMS_KEY_ARN
        ? new KmsEnvelopeEncryptor(config.GULLEY_KMS_KEY_ARN, config.GULLEY_KMS_REGION)
        : new InMemoryAesCipher()
      : undefined,
    // BYOK crypto-shred: wrap the mask encryptor in a per-subject ShreddableCipher (the
    // per-subject keys are held wrapped by the mask encryptor above = the customer CMK).
    // The context builds the PostgresSubjectKeyStore when a DB + mask encryptor are present.
    cryptoShredEnabled: config.CRYPTO_SHRED_ENABLED,
    // Eval-in-the-loop rollout: a gateway-backed runner (offline golden-set gate).
    evalRunner: buildEvalRunner(config, bootWarn),
    // Live gateway observability: fetch + parse the gateway's Prometheus /metrics.
    gatewayMetrics: config.GATEWAY_METRICS_URL
      ? buildGatewayMetricsProvider({
          url: config.GATEWAY_METRICS_URL,
          allowlist: outboundAllowlist(config),
          timeoutMs: config.GATEWAY_METRICS_TIMEOUT_MS,
        })
      : undefined,
    // OAuth broker (enterprise device + auth-code/PKCE). Off unless enabled + a pepper.
    oauthBroker:
      config.OAUTH_BROKER_ENABLED && config.GULLEY_KEY_PEPPER
        ? {
            enabled: true,
            pepper: config.GULLEY_KEY_PEPPER,
            accessTtlMs: config.OAUTH_ACCESS_TTL_MS,
            refreshTtlMs: config.OAUTH_REFRESH_TTL_MS,
            absoluteTtlMs: config.OAUTH_ABSOLUTE_TTL_MS,
            deviceCodeTtlMs: config.OAUTH_DEVICE_CODE_TTL_MS,
            // Real Entra revoke-on-deprovision when Graph app creds are configured.
            ...(config.ENTRA_TENANT_ID &&
            config.ENTRA_GRAPH_CLIENT_ID &&
            config.ENTRA_GRAPH_CLIENT_SECRET
              ? {
                  idp: new EntraGraphIdp({
                    tenantId: config.ENTRA_TENANT_ID,
                    clientId: config.ENTRA_GRAPH_CLIENT_ID,
                    clientSecret: config.ENTRA_GRAPH_CLIENT_SECRET,
                    graphBase: config.ENTRA_GRAPH_BASE,
                    loginBase: config.ENTRA_LOGIN_BASE,
                    cacheTtlMs: config.ENTRA_ACTIVE_CACHE_MS,
                    timeoutMs: config.ENTRA_GRAPH_TIMEOUT_MS,
                    assertAllowed: (url) =>
                      assertEgressAllowed(url, { allowlist: outboundAllowlist(config) }),
                  }),
                }
              : {}),
          }
        : undefined,
    scimGroupRoleMap: parseScimGroupRoleMap(config.SCIM_GROUP_ROLE_MAP),
    schemaCheck: config.DB_SCHEMA_CHECK,
    // A failing durable membership loader degrades a session to its token grants; that
    // used to be silent. Log it structured so a broken directory is visible.
    onLoaderError: (subject, err) =>
      log.error(
        { err, subject, event: 'membership_loader_failed' },
        'durable membership loader failed; session limited to token memberships',
      ),
  });
}

/** Parse SCIM_GROUP_ROLE_MAP (JSON { displayName: { role, orgId } }); tolerant. */
function parseScimGroupRoleMap(json: string): Record<string, { role: string; orgId: string }> {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, { role: string; orgId: string }> = {};
    for (const [k, v] of Object.entries(raw)) {
      const e = v as { role?: unknown; orgId?: unknown };
      if (typeof e?.role === 'string' && typeof e?.orgId === 'string') {
        out[k] = { role: e.role, orgId: e.orgId };
      }
    }
    return out;
  } catch {
    return {};
  }
}

const config = loadConfig();
// One structured logger for the process: boot-time warnings (previously raw
// process.stderr.write lines that broke JSON log ingestion), request lines, drain.
const log = pino({ level: config.LOG_LEVEL, redact: { paths: LOG_REDACT_PATHS, remove: true } });
const bootWarn = (m: string): void => log.warn(m);

/** DB mode: refresh the console's read model (tenancy + providers + collections) from
 *  Postgres. Fired on a foreign bus signal, on listen (re)connect and on a TTL, so a
 *  replica that did not perform a write still converges. Single-flight + best-effort. */
let rehydrating: Promise<void> | undefined;
function rehydrate(reason: string): Promise<void> {
  const target = context?.hydrate;
  if (!target) return Promise.resolve();
  if (rehydrating) return rehydrating;
  rehydrating = target()
    .then((counts) => log.debug({ reason, ...counts }, 'read model re-hydrated'))
    .catch((err: unknown) => log.warn({ err, reason }, 'read-model re-hydration failed'))
    .finally(() => {
      rehydrating = undefined;
    });
  return rehydrating;
}
// Air-gapped posture is process-wide, set before any egress can happen: every guarded
// control-plane outbound then requires an explicit allowlist (fail-closed).
setAirGappedEgress(config.AIR_GAPPED);
const context: ControlContext | undefined = buildContext(config);
const app = buildServer(config, context, log);
if (!context) {
  app.log.warn(
    'control-api booting health-only — set GULLEY_ADMIN_SESSION_SECRET to serve admin routes',
  );
} else {
  app.log.info(
    {
      oidc: Boolean(context.oidc),
      durable: Boolean(context.db),
      oauthBroker: Boolean(context.oauthBroker),
    },
    context.db
      ? 'control-api serving admin routes (Postgres-backed stores)'
      : 'control-api serving admin routes (in-memory stores)',
  );
}

// WORM-live: continuously ship the durable audit chain to the immutable mirror. Each
// tick ships every row past the last mirrored seq; ship() is single-flight + idempotent
// so an overlapping timer/manual trigger is safe. The timer is unref'd so it never
// holds the process open, and an initial best-effort ship runs on boot.
let wormTimer: NodeJS.Timeout | undefined;
if (context?.wormShipper) {
  const shipper = context.wormShipper;
  const tick = (): void => {
    shipper
      .ship()
      .then((r) => {
        if (r.shipped > 0) app.log.info({ shipped: r.shipped, lastSeq: r.lastSeq }, 'WORM shipped');
      })
      .catch((err: unknown) => app.log.error({ err }, 'WORM ship failed'));
  };
  wormTimer = setInterval(tick, config.WORM_SHIP_INTERVAL_MS);
  wormTimer.unref();
  app.log.info({ intervalMs: config.WORM_SHIP_INTERVAL_MS }, 'WORM-live shipper started');
  tick();
}

// Anchoring: publish a signed chain-head checkpoint to the external sink on a slow
// cadence, so a later rewrite of history (even by the operator) is detectable. No-ops
// when no signer is configured (signCtxAttestation returns undefined).
let anchorTimer: NodeJS.Timeout | undefined;
if (context?.anchor && context.auditRows) {
  const anchor = context.anchor;
  const rowsFn = context.auditRows;
  const ctx = context;
  const tick = (): void => {
    void (async (): Promise<void> => {
      const att = await signCtxAttestation(ctx, await rowsFn(), new Date().toISOString());
      if (!att) return;
      const ref = await anchor.publish(att);
      app.log.info({ id: ref.id }, 'anchored audit head');
    })().catch((err: unknown) => app.log.error({ err }, 'anchor publish failed'));
  };
  anchorTimer = setInterval(tick, config.AUDIT_ANCHOR_INTERVAL_MS);
  anchorTimer.unref();
  app.log.info({ intervalMs: config.AUDIT_ANCHOR_INTERVAL_MS }, 'audit anchoring started');
  tick();
}

// SIEM export: seed the cursor from the current audit head (tail-only, no backlog
// storm on start), then export new events on a periodic tick.
let siemTimer: NodeJS.Timeout | undefined;
if (context?.siemExporter) {
  const exporter = context.siemExporter;
  const tick = (): void => {
    exporter
      .export()
      .then((r) => {
        if (r.exported > 0)
          app.log.info({ exported: r.exported, lastSeq: r.lastSeq }, 'SIEM export');
      })
      .catch((err: unknown) => app.log.error({ err }, 'SIEM export failed'));
  };
  void exporter
    .seedFromHead()
    .then(() => {
      siemTimer = setInterval(tick, config.SIEM_EXPORT_INTERVAL_MS);
      siemTimer.unref();
      app.log.info(
        { kind: exporter.kind, intervalMs: config.SIEM_EXPORT_INTERVAL_MS },
        'SIEM export started',
      );
    })
    .catch((err: unknown) => app.log.error({ err }, 'SIEM seed failed'));
}

// OAuth-ephemera retention: periodically reclaim expired device_code / auth_code rows.
// Expiry is enforced at read/consume time, so this is pure space reclamation for a
// long-lived broker deployment. Unref'd + best-effort. Only in DB mode with the broker on.
let oauthSweepTimer: NodeJS.Timeout | undefined;
let hydrateTimer: NodeJS.Timeout | undefined;
if (context?.db && context.oauthBroker && config.OAUTH_EPHEMERA_SWEEP_INTERVAL_SECONDS > 0) {
  const sweepDb = context.db;
  const tick = (): void => {
    void purgeExpiredOAuthCodes(sweepDb)
      .then((r) => {
        if (r.deviceCodes + r.authCodes > 0)
          app.log.info(r, 'swept expired OAuth device/auth codes');
      })
      .catch((err: unknown) => app.log.error({ err }, 'OAuth-ephemera sweep failed'));
  };
  oauthSweepTimer = setInterval(tick, config.OAUTH_EPHEMERA_SWEEP_INTERVAL_SECONDS * 1000);
  oauthSweepTimer.unref();
  tick();
}

async function start(): Promise<void> {
  try {
    // DB mode: load the tenancy AND config read models from Postgres BEFORE serving, so
    // the console lists the durable state (seeded / config-applied / console-created)
    // and scope checks resolve against it from the first request.
    if (context?.hydrate) {
      const counts = await context.hydrate();
      app.log.info(counts, 'read model hydrated from database');
    }
    // DB mode: also SUBSCRIBE to the config bus (it was emit-only) so an apply or a
    // console edit on another replica refreshes this one's read model, plus a TTL tick.
    if (configBus && context?.hydrate) {
      const own = context.originId;
      configBus.onSignal((sig) => {
        if (sig.origin !== own) void rehydrate(`signal v${sig.v}`);
      });
      await configBus.start();
      if (config.CONTROL_API_HYDRATE_INTERVAL_SECONDS > 0) {
        hydrateTimer = setInterval(
          () => void rehydrate('interval'),
          config.CONTROL_API_HYDRATE_INTERVAL_SECONDS * 1000,
        );
        hydrateTimer.unref();
      }
    }
    await app.listen({ host: config.CONTROL_API_HOST, port: config.CONTROL_API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  // Serialize under `err` so pino emits message + stack (any other key logs `{}`).
  const err = reason instanceof Error ? reason : new Error(String(reason));
  app.log.error({ err }, 'unhandledRejection');
});

const SHUTDOWN_GRACE_MS = config.SHUTDOWN_GRACE_MS;
// After an uncaughtException the process state is undefined — drain briefly, then exit
// non-zero for the orchestrator to restart, rather than dying abruptly mid-write.
const UNCAUGHT_GRACE_MS = Math.min(SHUTDOWN_GRACE_MS, 5_000);
let shuttingDown = false;

/** Run one drain step; a failure is logged and the remaining steps still run. */
async function settle(step: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    app.log.error({ err, step }, 'shutdown step failed');
  }
}

async function shutdown(signal: string, graceMs = SHUTDOWN_GRACE_MS, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal, graceMs }, 'draining');
  const backstop = setTimeout(() => {
    app.log.warn('drain grace elapsed, forcing exit');
    process.exit(exitCode);
  }, graceMs);
  backstop.unref();
  if (wormTimer) clearInterval(wormTimer);
  if (anchorTimer) clearInterval(anchorTimer);
  if (siemTimer) clearInterval(siemTimer);
  if (oauthSweepTimer) clearInterval(oauthSweepTimer);
  if (hydrateTimer) clearInterval(hydrateTimer);
  await settle('http-close', () => app.close());
  await settle('config-bus', () => configBus?.close());
  clearTimeout(backstop);
  app.log.info({ signal }, 'drained');
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// Mirror the gateway: an uncaughtException must not abruptly kill an in-flight audit/
// config write. Drain briefly through the same path, then exit non-zero to restart.
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaughtException — draining and exiting');
  void shutdown('uncaughtException', UNCAUGHT_GRACE_MS, 1);
});

void start();
