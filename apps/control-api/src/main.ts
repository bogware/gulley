import {
  type AsymmetricSigner,
  InMemoryAesCipher,
  InMemoryHmacSigner,
  KmsEnvelopeEncryptor,
  KmsSigner,
} from '@gulley/crypto';
import { loadCatalogFromFile } from '@gulley/catalog';
import { GULLEY_BUILD } from '@gulley/core';
import type { RateResolver } from '@gulley/cost';
import { assertEgressAllowed, pinnedFetch, setAirGappedEgress } from '@gulley/egress';
import { EntraGraphIdp, FederationVerifier } from '@gulley/oauth';
import { OidcProvider } from '@gulley/oidc';
import {
  createListenConnection,
  MAINTENANCE_LOCK,
  PostgresConfigBus,
  purgeExpiredGrants,
  purgeExpiredOAuthCodes,
  sessionCostStats,
  withAdvisoryXactLock,
} from '@gulley/storage';
import { RunawayDetector } from './runaway-detector';
import { AlertDispatcher } from '@gulley/alerts';
import { buildAlertSink } from './alerts';
import { KeyExpirySweeper, type KeyExpirySweepResult } from './key-expiry';
import { S3AuditMirror } from '@gulley/worm';
import pino from 'pino';
import { type Anchor, HttpAnchor } from './anchor';
import { buildSiemConnector, type SiemConnector } from './siem';
import { type EvalRunner, GatewayEvalRunner } from './eval-runner';
import { buildGatewayMetricsProvider } from './gateway-metrics';
import { signCtxAttestation } from './audit-signing';
import {
  type Config,
  loadConfig,
  outboundAllowlist,
  sessionSecrets,
  workloadFederations,
} from './config';
import {
  type ControlContext,
  createInMemoryControlContext,
  type InMemoryContextOptions,
  type OidcSessionConfig,
  type SamlSessionConfig,
} from './context';
import { parseRoleMap } from './sso';
import { readFileSync } from 'node:fs';
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
    fetchImpl: pinnedFetch(), // connect-time DNS-rebind defence (the allowlist is structural)
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
    { allowlist: outboundAllowlist(config), fetchImpl: pinnedFetch() },
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
    fetchImpl: pinnedFetch(), // connect-time DNS-rebind defence
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
/** An inline PEM/value or the contents of its `_FILE` twin (trimmed); undefined when
 *  neither is set. */
function inlineOrFile(inline: string | undefined, file: string | undefined): string | undefined {
  if (inline) return inline;
  if (file) return readFileSync(file, 'utf8').trim();
  return undefined;
}

/**
 * SAML 2.0 session-gate config from env (validated as a set by config.ts's refine).
 * The IdP entry point is a browser redirect, not a server egress, so it needs no
 * outbound allowlisting. Several PEM certificates in SAML_IDP_CERT(_FILE) are split
 * so a key rollover can list the old and the new one.
 */
function buildSaml(config: Config): SamlSessionConfig | undefined {
  if (!config.SAML_ENABLED) return undefined;
  const certRaw = inlineOrFile(config.SAML_IDP_CERT, config.SAML_IDP_CERT_FILE);
  if (
    !certRaw ||
    !config.SAML_IDP_ENTRY_POINT ||
    !config.SAML_IDP_ISSUER ||
    !config.SAML_SP_ENTITY_ID ||
    !config.SAML_SP_CALLBACK_URL
  ) {
    return undefined; // config.ts already refused this combination
  }
  // An inline PEM from an env file often arrives with literal "\n" escapes.
  const unescaped = certRaw.includes('-----') ? certRaw.replace(/\\n/g, '\n') : certRaw;
  const certs = unescaped.match(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g) ?? [
    unescaped,
  ];
  const spPrivateKey = inlineOrFile(config.SAML_SP_PRIVATE_KEY, config.SAML_SP_PRIVATE_KEY_FILE);
  const spCert = inlineOrFile(config.SAML_SP_CERT, config.SAML_SP_CERT_FILE);
  return {
    entryPoint: config.SAML_IDP_ENTRY_POINT,
    idpIssuer: config.SAML_IDP_ISSUER,
    idpCert: certs.length === 1 ? certs[0]! : certs,
    spEntityId: config.SAML_SP_ENTITY_ID,
    callbackUrl: config.SAML_SP_CALLBACK_URL,
    ...(spPrivateKey ? { spPrivateKey: spPrivateKey.replace(/\\n/g, '\n') } : {}),
    ...(spCert ? { spCert: spCert.replace(/\\n/g, '\n') } : {}),
    groupsAttribute: config.SAML_GROUPS_ATTRIBUTE,
    subjectAttribute: config.SAML_SUBJECT_ATTRIBUTE,
    roleRules: parseRoleMap(config.SAML_ROLE_MAP),
    postLoginRedirect: config.SAML_POST_LOGIN_REDIRECT,
    cookieSecure: config.SAML_COOKIE_SECURE,
    allowIdpInitiated: config.SAML_ALLOW_IDP_INITIATED,
    wantAssertionsSigned: config.SAML_WANT_ASSERTIONS_SIGNED,
    wantResponseSigned: config.SAML_WANT_RESPONSE_SIGNED,
    acceptedClockSkewMs: config.SAML_CLOCK_SKEW_MS,
  };
}

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
        fetchImpl: pinnedFetch(), // connect-time DNS-rebind defence (assertOidcEgress is structural)
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
      // exchangeCode POSTs the OIDC client secret to the advertised token_endpoint; pin
      // its fetch so a rebound/malicious token_endpoint can't exfiltrate the secret.
      fetchImpl: pinnedFetch(),
    };
  }

  const saml = buildSaml(config);

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
    saml,
    onRoleLoadError: (err) => log.warn({ err }, 'role catalogue load failed (stale snapshot kept)'),
    databaseUrl: config.DATABASE_URL,
    dbConnectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
    notifier: configBus,
    attestationKey: config.AUDIT_ATTESTATION_KEY,
    attestationSubject: config.AUDIT_ATTESTATION_SUBJECT,
    auditSigner,
    worm: buildWorm(config, auditSigner, bootWarn),
    anchor: buildAnchor(config),
    siem: buildSiem(config, bootWarn),
    // Alert channels (SSRF-guarded at construction; a bad channel fails boot).
    alerts: buildAlertSink(config, { log }),
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
          fetchImpl: pinnedFetch(), // connect-time DNS-rebind defence
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
            // Workload identity (K8s / GitHub Actions → scoped service tokens).
            federation: buildFederationVerifier(config),
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
                    fetchImpl: pinnedFetch(), // connect-time DNS-rebind defence
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

/**
 * Workload identity federation verifier (RFC 7523 JWT-bearer) from WORKLOAD_FEDERATIONS.
 * Discovery/JWKS fetches of a public issuer (GitHub Actions, a cloud-hosted cluster's
 * OIDC issuer) go through the SSRF/air-gap egress guard AND the DNS-pinned fetch like
 * every other control-plane outbound; a federation marked `allowInternal` (an in-cluster
 * Kubernetes API server on a cluster IP) bypasses both for ITS URLs only. Production
 * requires https issuers/JWKS endpoints (validated at config load).
 */
function buildFederationVerifier(config: Config): FederationVerifier | undefined {
  const federations = workloadFederations(config);
  if (federations.length === 0) return undefined;
  const allowlist = outboundAllowlist(config);
  return new FederationVerifier({
    federations,
    fetchFor: (fed) => (fed.allowInternal ? fetch : pinnedFetch()),
    assertEgress: (url, fed) => {
      if (!fed.allowInternal) assertEgressAllowed(url, { allowlist });
    },
    requireHttps: config.NODE_ENV === 'production',
    fetchTimeoutMs: config.OIDC_FETCH_TIMEOUT_MS,
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
const log = pino({
  level: config.LOG_LEVEL,
  redact: { paths: LOG_REDACT_PATHS, remove: true },
  base: {
    pid: process.pid,
    version: GULLEY_BUILD.version,
    ...(GULLEY_BUILD.sha ? { sha: GULLEY_BUILD.sha } : {}),
  },
});
log.info({ node: process.version, build: GULLEY_BUILD }, 'gulley control-api starting');
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
      saml: Boolean(context.saml),
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

// OAuth-ephemera retention: periodically reclaim expired device_code / auth_code rows
// and oauth_grant families past their absolute + access expiry (workload JWT-bearer
// grants are access-only and short-lived, so a busy cluster leaves many per hour).
// Expiry is enforced at read/consume time, so this is pure space reclamation for a
// long-lived broker deployment. Unref'd + best-effort. Only in DB mode with the broker on.
let oauthSweepTimer: NodeJS.Timeout | undefined;
let hydrateTimer: NodeJS.Timeout | undefined;
if (context?.db && context.oauthBroker && config.OAUTH_EPHEMERA_SWEEP_INTERVAL_SECONDS > 0) {
  const sweepDb = context.db;
  const tick = (): void => {
    void Promise.all([purgeExpiredOAuthCodes(sweepDb), purgeExpiredGrants(sweepDb)])
      .then(([r, grants]) => {
        if (r.deviceCodes + r.authCodes + grants > 0)
          app.log.info({ ...r, grants }, 'swept expired OAuth device/auth codes and grants');
      })
      .catch((err: unknown) => app.log.error({ err }, 'OAuth-ephemera sweep failed'));
  };
  oauthSweepTimer = setInterval(tick, config.OAUTH_EPHEMERA_SWEEP_INTERVAL_SECONDS * 1000);
  oauthSweepTimer.unref();
  tick();
}

if (context?.alerts instanceof AlertDispatcher) {
  app.log.info({ channels: context.alerts.describe() }, 'alert channels configured');
}

// Key-expiry alerts: announce virtual keys expiring within ALERT_KEY_EXPIRY_DAYS (and
// once they lapse) to the alert channels + the audit trail. One replica per tick in DB
// mode (advisory lock); the announced set is per process (docs/ALERTING.md). Unref'd.
let keyExpiryTimer: NodeJS.Timeout | undefined;
if (context && config.ALERT_KEY_EXPIRY_SWEEP_INTERVAL_SECONDS > 0) {
  const ctx = context;
  const db = ctx.db;
  const intervalMs = config.ALERT_KEY_EXPIRY_SWEEP_INTERVAL_SECONDS * 1000;
  const sweeper = new KeyExpirySweeper({
    keys: ctx.keys,
    audit: ctx.audit,
    alerts: ctx.alerts,
    orgIdOf: (workspaceId) => ctx.workspaces.get(workspaceId)?.orgId ?? null,
    withinDays: config.ALERT_KEY_EXPIRY_DAYS,
    expiredLookbackMs: Math.max(2 * intervalMs, 3_600_000),
    ...(db
      ? {
          lock: (fn: () => Promise<KeyExpirySweepResult>) =>
            withAdvisoryXactLock(db, MAINTENANCE_LOCK.keyExpiryAlert, fn),
        }
      : {}),
  });
  const tick = (): void => {
    sweeper
      .sweep()
      .then((r) => {
        if (r.expiring + r.expired > 0) app.log.info(r, 'key-expiry sweep announced');
      })
      .catch((err: unknown) => app.log.error({ err }, 'key-expiry sweep failed'));
  };
  keyExpiryTimer = setInterval(tick, intervalMs);
  keyExpiryTimer.unref();
  app.log.info(
    { intervalMs, withinDays: config.ALERT_KEY_EXPIRY_DAYS, durable: Boolean(db) },
    'key-expiry sweep started',
  );
  tick();
}

// Runaway-session detector (K5): score the sessions active in the last window against
// their principal's / the scope's per-session spend baseline and flag or block the
// outliers (session_block rows the gateway refuses). DB mode only; one replica per tick
// (advisory lock); unref'd + best-effort. The first pass runs shortly after boot.
let runawayTimer: NodeJS.Timeout | undefined;
if (context?.db && context.sessionBlocks && config.RUNAWAY_DETECTOR_INTERVAL_SECONDS > 0) {
  const detectorDb = context.db;
  const detector = new RunawayDetector(
    {
      windowMinutes: config.RUNAWAY_WINDOW_MINUTES,
      baselineDays: config.RUNAWAY_BASELINE_DAYS,
      minCostUsd: config.RUNAWAY_MIN_COST_USD,
      action: config.RUNAWAY_ACTION,
      blockTtlMinutes: config.RUNAWAY_BLOCK_TTL_MINUTES,
    },
    {
      stats: (w) => sessionCostStats(detectorDb, w),
      blocks: context.sessionBlocks,
      audit: context.audit,
      alerts: context.alerts,
      withLock: (fn) => withAdvisoryXactLock(detectorDb, MAINTENANCE_LOCK.runawayDetector, fn),
      log: app.log,
    },
  );
  const tick = (): void => {
    detector
      .tick()
      .then((r) => {
        if (r.runaway.length > 0)
          app.log.warn(
            { evaluated: r.evaluated, runaway: r.runaway.length, action: config.RUNAWAY_ACTION },
            'runaway sessions detected',
          );
      })
      .catch((err: unknown) => app.log.error({ err }, 'runaway detector tick failed'));
  };
  runawayTimer = setInterval(tick, config.RUNAWAY_DETECTOR_INTERVAL_SECONDS * 1000);
  runawayTimer.unref();
  app.log.info(
    {
      intervalSeconds: config.RUNAWAY_DETECTOR_INTERVAL_SECONDS,
      action: config.RUNAWAY_ACTION,
      windowMinutes: config.RUNAWAY_WINDOW_MINUTES,
      baselineDays: config.RUNAWAY_BASELINE_DAYS,
      minCostUsd: config.RUNAWAY_MIN_COST_USD,
    },
    'runaway-session detector started',
  );
  setTimeout(tick, 5_000).unref();
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
  if (runawayTimer) clearInterval(runawayTimer);
  if (keyExpiryTimer) clearInterval(keyExpiryTimer);
  await settle('http-close', () => app.close());
  // Let queued alert deliveries finish (bounded) before the process goes away.
  await settle('alert-drain', () =>
    context?.alerts instanceof AlertDispatcher ? context.alerts.drain(2_000) : undefined,
  );
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
