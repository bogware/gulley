import { OidcProvider } from '@gulley/oidc';
import { type Config, loadConfig, outboundAllowlist, sessionSecrets } from './config';
import {
  type ControlContext,
  createInMemoryControlContext,
  type OidcSessionConfig,
} from './context';
import { parseRoleMap } from './oidc-gate';
import { buildServer } from './server';

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

  return createInMemoryControlContext({
    pepper: config.GULLEY_KEY_PEPPER ?? '',
    bootstrapEnabled: config.CONTROL_API_BOOTSTRAP_ENABLED,
    bootstrapTokenSha256: config.GULLEY_BOOTSTRAP_ADMIN_TOKEN_SHA256,
    sessionSecrets: secrets,
    maxSessionTtlMs: config.ADMIN_SESSION_MAX_MS,
    outboundAllowlist: outboundAllowlist(config),
    oidc,
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
