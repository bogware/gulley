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

  // The gateway's PUBLIC base URL, used to generate turnkey client configs
  // (GET /admin/workspaces/:id/client-config). Absent ⇒ the endpoint 501s.
  GATEWAY_PUBLIC_URL: z.string().url().optional(),

  // Ed25519 private key (PEM) that SIGNS onboarding packs (GET .../onboarding-pack).
  // The org publishes the matching public key (served at /.well-known/gulley-onboarding-key)
  // so `gulley init` verifies a pack before writing any config — a phished/tampered
  // pack is rejected. Absent ⇒ the onboarding-pack endpoint 501s.
  ONBOARDING_SIGNING_KEY: z.string().optional(),

  // Shadow-spend reconciliation (bypass detection): org-level ADMIN keys for the
  // providers' own usage/cost APIs. When set, GET /admin/analytics/shadow-spend
  // pulls each provider's billed spend and reconciles it against the gateway ledger
  // to surface spend that bypassed Gulley. Absent for a provider = gateway-only
  // (that provider can't be flagged). Org admin keys, not per-tenant secrets.
  ANTHROPIC_ADMIN_API_KEY: z.string().optional(),
  OPENAI_ADMIN_API_KEY: z.string().optional(),
  // Flag a provider whose shadow (bypassed) share of its billed spend is at/above
  // this many basis points. Default 500 bps = 5%.
  SHADOW_SPEND_FLAG_BPS: z.coerce.number().int().min(0).max(10_000).default(500),

  // Compliance: an HMAC key that signs auditor attestations (GET /audit/attestation
  // and the audit:verify CLI). Absent = attestation export disabled (501). The
  // auditor holds the same key to verify the signature independently.
  AUDIT_ATTESTATION_KEY: z.string().min(16).optional(),
  // Optional label stamped on the attestation (deployment / environment / org).
  AUDIT_ATTESTATION_SUBJECT: z.string().optional(),

  // Audit-export ASYMMETRIC signing key (KMS). When set, the audit attestation and
  // the WORM batch signatures are signed under this asymmetric CMK, and the auditor
  // verifies them OFFLINE with only the published public key (GET /audit/public-key)
  // — no shared secret. Takes precedence over the HMAC keys (AUDIT_ATTESTATION_KEY /
  // WORM_SIGNING_KEY) for their respective signatures. Region from GULLEY_KMS_REGION.
  GULLEY_AUDIT_SIGNING_KMS_ARN: z.string().optional(),
  GULLEY_AUDIT_SIGNING_ALG: z
    .enum([
      'ECDSA_SHA_256',
      'ECDSA_SHA_384',
      'ECDSA_SHA_512',
      'RSASSA_PKCS1_V1_5_SHA_256',
      'RSASSA_PKCS1_V1_5_SHA_384',
      'RSASSA_PKCS1_V1_5_SHA_512',
    ])
    .default('ECDSA_SHA_256'),

  // Anchoring: publish periodic signed chain-head checkpoints to this external
  // append-only sink (POST an attestation; GET the list back), so even the operator
  // cannot rewrite history undetectably. The host must be on OUTBOUND_HOST_ALLOWLIST
  // (SSRF-guarded). Absent ⇒ the /audit/anchor* endpoints 501.
  AUDIT_ANCHOR_URL: z.string().url().optional(),
  // Optional bearer/token header sent to the anchor sink (the value only, e.g.
  // "Bearer xyz" → set the whole header via AUDIT_ANCHOR_AUTHZ). Secret ARNs only in
  // prod configs; this is for a simple shared token to a self-hosted sink.
  AUDIT_ANCHOR_AUTHZ: z.string().optional(),
  // Background anchoring cadence. Default 1h.
  AUDIT_ANCHOR_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),

  // Mask-vault reveal (M22 D): serve GET /admin/mask-vault/:requestId, which
  // decrypts + returns the token↔original map for a masked request. Needs the SAME
  // envelope key the gateway used (KMS ARN in prod; the in-memory dev cipher can only
  // decrypt records written in the same process). Absent ⇒ the endpoint 501s.
  MASK_VAULT_ENABLED: envBool(false),
  GULLEY_KMS_KEY_ARN: z.string().optional(),
  GULLEY_KMS_REGION: z.string().default('us-east-1'),

  // WORM-live: continuously mirror the durable, hash-chained audit log to an S3
  // Object Lock (COMPLIANCE) bucket — the retained, immutable system of record that
  // survives a Postgres compromise. Enabled only with WORM_ENABLED + WORM_BUCKET +
  // DATABASE_URL + a signing key (GULLEY_AUDIT_SIGNING_KMS_ARN or WORM_SIGNING_KEY);
  // otherwise the /audit/worm/* endpoints 501. Only non-PII AuditRow metadata is
  // shipped (payloads are already redacted upstream by GuardedAuditSink).
  WORM_ENABLED: envBool(false),
  WORM_BUCKET: z.string().optional(),
  WORM_REGION: z.string().default('us-east-1'),
  WORM_PREFIX: z.string().default('audit/'),
  // Per-object COMPLIANCE retention. Default ~7 years (SOX/HIPAA-class window).
  WORM_RETENTION_DAYS: z.coerce.number().int().positive().default(2555),
  // Background ship cadence. Each tick ships every durable row past the last mirrored
  // seq, in contiguous signed batches. Default 60s.
  WORM_SHIP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // Max audit rows per WORM object. Default 100.
  WORM_BATCH_MAX: z.coerce.number().int().positive().default(100),
  // HMAC key that signs each WORM batch preimage (base64(sha256(canonical(rows))));
  // forging a batch needs this key, not just an S3 Put. The auditor holds the same
  // key to verify. Shared-secret FALLBACK, used only when GULLEY_AUDIT_SIGNING_KMS_ARN
  // is unset (asymmetric signing lets the auditor verify with just the public key).
  // >=16 chars.
  WORM_SIGNING_KEY: z.string().min(16).optional(),

  // Durable config store. When set, POST /config/apply persists to Postgres (the
  // tables the gateway reads) via PostgresConfigStore + PostgresConfigVersionStore,
  // instead of the in-memory ControlConfigStore. Enables M13 config hot-reload.
  DATABASE_URL: z.string().url().optional(),
  // Config-propagation channel. On a successful /config/apply the control plane
  // emits a Postgres NOTIFY on this channel so every gateway replica reconciles
  // live (without a redeploy). MUST match the gateway's CONFIG_NOTIFY_CHANNEL.
  // Only active when DATABASE_URL is set; gateways also converge via their poll.
  CONFIG_NOTIFY_CHANNEL: z.string().default('gulley:config'),

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
