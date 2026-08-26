import { z } from 'zod';

/** Env booleans: unset -> default; truthy only for 1/true/yes/on. */
const envBool = (def: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined ? def : typeof v === 'string' ? /^(1|true|yes|on)$/i.test(v) : Boolean(v),
    z.boolean(),
  );

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CONTROL_API_HOST: z.string().default('0.0.0.0'),
  CONTROL_API_PORT: z.coerce.number().int().positive().default(8081),

  // Virtual-key pepper (KMS-held in prod) — needed to mint keys.
  GULLEY_KEY_PEPPER: z.string().min(16).optional(),

  // Break-glass bootstrap admin: the server stores only sha256(gadm_ token).
  // Disabled by default; enabling is logged.
  CONTROL_API_BOOTSTRAP_ENABLED: envBool(false),
  GULLEY_BOOTSTRAP_ADMIN_TOKEN_SHA256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),

  // Admin-session signing (current + previous for rotation overlap).
  GULLEY_ADMIN_SESSION_SECRET: z.string().min(32).optional(),
  GULLEY_ADMIN_SESSION_SECRET_PREV: z.string().min(32).optional(),
  ADMIN_SESSION_MAX_MS: z.coerce.number().int().positive().default(900_000),

  // Provider base-URL egress allowlist (comma-separated hostnames).
  OUTBOUND_HOST_ALLOWLIST: z.string().default(''),

  // Admin-surface HTTP edge. CORS is credentials-safe: exact-origin allowlist
  // (comma-separated full origins), reflected with Allow-Credentials; empty =
  // CORS off (same-origin /control proxy deployment). CSRF gates cookie-authed
  // unsafe methods via Sec-Fetch-Site (on by default; bearer/API clients exempt).
  ADMIN_CORS_ORIGINS: z.string().default(''),
  ADMIN_CSRF_ENABLED: envBool(true),

  // OIDC session gate for the admin console (generic, discovery-based). When
  // OIDC_ISSUER + OIDC_CLIENT_ID are set, /auth/login → the IdP; /auth/callback
  // mints an admin session cookie. Group→role mapping via OIDC_ROLE_MAP (JSON
  // [{ group, role, orgId }]; orgId "*" = all orgs).
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().default('http://localhost:3000/control/auth/callback'),
  OIDC_SCOPES: z.string().default('openid profile email'),
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OIDC_ROLE_MAP: z.string().default('[]'),
  OIDC_POST_LOGIN_REDIRECT: z.string().default('/'),
  OIDC_COOKIE_SECURE: envBool(false),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(source);
}

export function sessionSecrets(config: Config): string[] {
  return [config.GULLEY_ADMIN_SESSION_SECRET, config.GULLEY_ADMIN_SESSION_SECRET_PREV].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
}

export function outboundAllowlist(config: Config): Set<string> {
  return new Set(
    config.OUTBOUND_HOST_ALLOWLIST.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Exact CORS origins (case preserved — an Origin header is compared verbatim). */
export function corsOrigins(config: Config): Set<string> {
  return new Set(
    config.ADMIN_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
