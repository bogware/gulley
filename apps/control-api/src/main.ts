import { InMemoryAesCipher, KmsEnvelopeEncryptor } from '@gulley/crypto';
import { OidcProvider } from '@gulley/oidc';
import { createListenConnection, PostgresConfigBus } from '@gulley/storage';
import { type Config, loadConfig, outboundAllowlist, sessionSecrets } from './config';
import {
  type ControlContext,
  createInMemoryControlContext,
  type OidcSessionConfig,
} from './context';
import { parseRoleMap } from './oidc-gate';
import { buildServer } from './server';
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
    oidc = {
      provider: new OidcProvider(config.OIDC_ISSUER),
      clientId: config.OIDC_CLIENT_ID,
      clientSecret: config.OIDC_CLIENT_SECRET,
      redirectUri: config.OIDC_REDIRECT_URI,
      scopes: config.OIDC_SCOPES,
      groupsClaim: config.OIDC_GROUPS_CLAIM,
      roleRules: parseRoleMap(config.OIDC_ROLE_MAP),
      postLoginRedirect: config.OIDC_POST_LOGIN_REDIRECT,
      cookieSecure: config.OIDC_COOKIE_SECURE,
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

  return createInMemoryControlContext({
    pepper: config.GULLEY_KEY_PEPPER ?? '',
    bootstrapEnabled: config.CONTROL_API_BOOTSTRAP_ENABLED,
    bootstrapTokenSha256: config.GULLEY_BOOTSTRAP_ADMIN_TOKEN_SHA256,
    sessionSecrets: secrets,
    maxSessionTtlMs: config.ADMIN_SESSION_MAX_MS,
    outboundAllowlist: outboundAllowlist(config),
    providerUsageSources,
    shadowSpendFlagBps: config.SHADOW_SPEND_FLAG_BPS,
    oidc,
    databaseUrl: config.DATABASE_URL,
    notifier: configBus,
    attestationKey: config.AUDIT_ATTESTATION_KEY,
    attestationSubject: config.AUDIT_ATTESTATION_SUBJECT,
    // Mask-vault reveal decryptor — the SAME envelope key the gateway used (KMS in
    // prod; the in-memory dev cipher only decrypts records written in-process).
    maskVaultEncryptor: config.MASK_VAULT_ENABLED
      ? config.GULLEY_KMS_KEY_ARN
        ? new KmsEnvelopeEncryptor(config.GULLEY_KMS_KEY_ARN, config.GULLEY_KMS_REGION)
        : new InMemoryAesCipher()
      : undefined,
  });
}

const config = loadConfig();
const context = buildContext(config);
const app = buildServer(config, context);
if (!context) {
  app.log.warn(
    'control-api booting health-only — set GULLEY_ADMIN_SESSION_SECRET to serve admin routes',
  );
} else {
  app.log.info(
    { oidc: Boolean(context.oidc) },
    'control-api serving admin routes (in-memory stores)',
  );
}

async function start(): Promise<void> {
  try {
    await app.listen({ host: config.CONTROL_API_HOST, port: config.CONTROL_API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandledRejection');
});

const SHUTDOWN_GRACE_MS = Number(process.env['SHUTDOWN_GRACE_MS']) || 110_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'draining');
  const backstop = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  backstop.unref();
  try {
    await app.close();
    await configBus?.close();
  } catch (err) {
    app.log.error({ err }, 'shutdown error');
  }
  clearTimeout(backstop);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

void start();
