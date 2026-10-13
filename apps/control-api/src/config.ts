import { z } from 'zod';

/** Env booleans: unset (or empty) -> default; truthy only for 1/true/yes/on. */
const envBool = (def: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined || (typeof v === 'string' && v.trim() === '')
        ? def
        : typeof v === 'string'
          ? /^(1|true|yes|on)$/i.test(v)
          : Boolean(v),
    z.boolean(),
  );

/**
 * Drop unset AND empty-string entries before validation (see the gateway's
 * normalizeEnv): compose `env_file` / Helm / ECS render an unset value as `KEY=`,
 * which would otherwise defeat every `.default()`, coerce numbers to 0, and fail
 * boot on a constrained string instead of degrading to health-only.
 */
export function normalizeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
  }
  return out;
}

const EnvShape = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CONTROL_API_HOST: z.string().default('0.0.0.0'),
  CONTROL_API_PORT: z.coerce.number().int().positive().default(8081),
  // Graceful-drain backstop (ms) before process.exit fires. MUST be strictly less than the
  // platform stop deadline (ECS stopTimeout / k8s terminationGracePeriodSeconds*1000) or
  // the backstop fires after SIGKILL. Validated + discoverable (was a raw process.env read).
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(110_000),
  // Proxy hops to trust for req.ip (X-Forwarded-For). `trustProxy: true` trusts EVERY
  // hop, making req.ip client-spoofable; a fixed hop count (1 = the ALB) is correct for
  // an ALB-fronted deployment. Raise it if you run additional trusted proxies.
  CONTROL_API_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  // Per-IP request budget (per minute) on the unauthenticated OAuth/OIDC protocol
  // surface (/oauth/*, /auth/*) — brute-force / flood protection on the highest-value
  // control-plane paths. In-memory per instance; 0 disables. Default 60/min.
  CONTROL_API_AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(60),
  // Separate per-IP budget (per minute) for the RFC 7523 JWT-bearer token exchange on
  // POST /oauth/token (workload identity). A NAT'd cluster or CI fleet shares one
  // source IP, so it must not compete with the 60/min human-login budget. In-memory
  // per instance; 0 disables. Default 600/min.
  CONTROL_API_TOKEN_EXCHANGE_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(600),
  // Explicit request body cap (bytes). Sized generously for the largest GitOps
  // config-apply document (Fastify's 1 MB default would reject a big-fleet apply), while
  // still bounding an abusive payload. Default 8 MiB.
  CONTROL_API_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(8_388_608),

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
  // Air-gapped deployment: fail-closed egress. Every control-plane outbound (WORM ship,
  // SIEM export, anchor, shadow-spend ingest, eval runner, config-apply provider URLs)
  // must target a host on OUTBOUND_HOST_ALLOWLIST — an empty allowlist denies ALL egress.
  // Note: SDK-based egress (S3/KMS) bypasses the fetch guard; use VPC endpoints for those.
  AIR_GAPPED: envBool(false),

  // The gateway's PUBLIC base URL, used to generate turnkey client configs
  // (GET /admin/workspaces/:id/client-config). Absent ⇒ the endpoint 501s.
  GATEWAY_PUBLIC_URL: z.string().url().optional(),
  // This control plane's PUBLIC base URL = the OAuth broker's issuer (RFC 8414
  // metadata, device-flow verification URI fallback, OAuth-mode client configs). Absent
  // ⇒ derived per request from the proxy-trusted Host header.
  CONTROL_API_PUBLIC_URL: z.string().url().optional(),
  // The admin console's PUBLIC base URL. When set, the device flow sends users to the
  // console's /oauth/device consent page (else the control-api's minimal page).
  CONSOLE_PUBLIC_URL: z.string().url().optional(),

  // The gateway's Prometheus /metrics URL (its SEPARATE management listener, e.g.
  // http://gateway:9090/metrics). The control-api fetches + parses it for the console's
  // live Observability page. Its host must be on OUTBOUND_HOST_ALLOWLIST (SSRF/air-gap
  // guard). Absent ⇒ /admin/observability/* endpoints 501.
  GATEWAY_METRICS_URL: z.string().url().optional(),
  GATEWAY_METRICS_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // OAuth broker (enterprise device + auth-code/PKCE for Claude Code / Codex). When on
  // (with a DB) the /oauth/* protocol surface is mounted and grants/clients/device-codes
  // persist durably for the console. Needs GULLEY_KEY_PEPPER (the broker hashes tokens
  // with it). The admin management endpoints (sessions, clients, grants, reuse alerts)
  // are always served; the durable views 501 without a DB.
  OAUTH_BROKER_ENABLED: envBool(false),
  OAUTH_ACCESS_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  OAUTH_REFRESH_TTL_MS: z.coerce.number().int().positive().default(2_592_000_000),
  OAUTH_ABSOLUTE_TTL_MS: z.coerce.number().int().positive().default(7_776_000_000),
  OAUTH_DEVICE_CODE_TTL_MS: z.coerce.number().int().positive().default(900_000),
  // Housekeeping: periodically DELETE expired device_code / auth_code ephemera (expiry is
  // already enforced at read time, so this only reclaims space on a long-lived broker).
  // Seconds; 0 = off. Runs on an unref'd timer only in DB mode with the broker enabled.
  OAUTH_EPHEMERA_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  // Workload identity federation (RFC 7523 JWT-bearer, docs/WORKLOAD_IDENTITY.md): a JSON
  // array of trust configurations mapping an external issuer's tokens (Kubernetes
  // service accounts, GitHub Actions OIDC) to a Gulley tenancy + scope. Each entry:
  // { name, issuer, jwksUri?, audience?, allowInternal?, subject: { pattern? | claims? },
  //   orgId, workspaceId, scope?: { allowedProviders?, allowedModels?, groups? },
  //   ttlSeconds? (default 3600, max 86400), onBehalfOf?, displayName? }.
  // Validated at boot (a malformed entry fails startup). Empty = grant type off.
  WORKLOAD_FEDERATIONS: z.string().default('[]'),

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

  // Runaway-session detector (K5 per-agent FinOps): every tick, score each agent session
  // active in the last RUNAWAY_WINDOW_MINUTES against its principal's per-session spend
  // baseline (2 × p95 over RUNAWAY_BASELINE_DAYS; the scope-wide p95 for a principal
  // with < 20 sessions) and the scope-wide p99; a session above max(RUNAWAY_MIN_COST_USD,
  // baseline) AND above the p99 is a runaway. `flag` audits + alerts; `block` also
  // writes a session_block row (TTL RUNAWAY_BLOCK_TTL_MINUTES) the gateway refuses with
  // 403. DB mode only; one replica runs each tick (advisory lock). 0 interval = off.
  RUNAWAY_DETECTOR_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(300),
  RUNAWAY_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  RUNAWAY_BASELINE_DAYS: z.coerce.number().int().positive().default(7),
  RUNAWAY_MIN_COST_USD: z.coerce.number().nonnegative().default(5),
  RUNAWAY_ACTION: z.enum(['flag', 'block']).default('flag'),
  RUNAWAY_BLOCK_TTL_MINUTES: z.coerce.number().int().positive().default(240),

  // Compliance: an HMAC key that signs auditor attestations (GET /audit/attestation
  // and the audit:verify CLI). Absent = attestation export disabled (501). The
  // auditor holds the same key to verify the signature independently.
  AUDIT_ATTESTATION_KEY: z.string().min(16).optional(),
  // Optional label stamped on the attestation (deployment / environment / org).
  AUDIT_ATTESTATION_SUBJECT: z.string().optional(),

  // Audit-export ASYMMETRIC signing key (KMS). When set, the audit attestation and
  // the WORM batch signatures are signed under this asymmetric CMK, and the auditor
  // verifies them OFFLINE with only the published public key (GET /.well-known/gulley-audit-key)
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

  // BYOK crypto-shred (GDPR/CCPA erasure): encrypt each mask-vault record under a
  // PER-SUBJECT key held wrapped by GULLEY_KMS_KEY_ARN (the customer's own CMK = BYOK).
  // POST /admin/crypto-shred/:subject destroys that subject's key so its stored PII maps
  // become permanently unrecoverable — provable erasure with no row deletion. Needs
  // DATABASE_URL + MASK_VAULT_ENABLED (a mask encryptor); otherwise the endpoints 501.
  CRYPTO_SHRED_ENABLED: envBool(false),

  // SIEM export: stream NEW audit-trail events (with their hash-chain provenance) to a
  // Splunk HEC, Microsoft Sentinel, or generic HTTP sink. Needs DATABASE_URL (reads the
  // durable chain) + the sink's egress host on OUTBOUND_HOST_ALLOWLIST. Off unless
  // SIEM_KIND is set; then GET /audit/siem/status + POST /audit/siem/export are served.
  // A live tail (seeded from the current head at startup); backfill via WORM / evidence
  // bundle. splunk: SIEM_URL + SIEM_TOKEN. sentinel: SIEM_WORKSPACE_ID + SIEM_SHARED_KEY.
  // webhook: SIEM_URL (+ optional SIEM_AUTHZ header). Secret ARNs only in prod configs.
  SIEM_KIND: z.enum(['splunk', 'sentinel', 'webhook']).optional(),
  SIEM_URL: z.string().url().optional(),
  SIEM_TOKEN: z.string().optional(),
  SIEM_WORKSPACE_ID: z.string().optional(),
  SIEM_SHARED_KEY: z.string().optional(),
  SIEM_AUTHZ: z.string().optional(),
  SIEM_LOG_TYPE: z.string().optional(),
  SIEM_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SIEM_BATCH_MAX: z.coerce.number().int().positive().default(200),

  // Alerting: operational alerts (config applies, break-glass, key expiry; the gateway
  // adds budget / breaker / guardrail events) to Slack, Microsoft Teams, PagerDuty,
  // email (SMTP) and HMAC-signed webhooks. ONE JSON array of channel objects — see
  // docs/ALERTING.md. Every target host passes the egress guard at boot (the outbound
  // allowlist, https outside development, AIR_GAPPED) or boot fails. The value carries
  // secrets (webhook URLs, routing keys, the SMTP password): secret store only, never a
  // YAML export. Unset = alerts off (a no-op sink).
  ALERT_CHANNELS: z.string().optional(),
  // Key-expiry sweep: announce enabled virtual keys that expire within this many days
  // (`key.expiring` + audit `key.expiring_soon`) and once they lapse (`key.expired`).
  ALERT_KEY_EXPIRY_DAYS: z.coerce.number().int().positive().default(7),
  // Sweep cadence (seconds); 0 = off. One replica runs each tick (advisory lock in DB
  // mode). The announced set is per process, so a restart may repeat a notice.
  ALERT_KEY_EXPIRY_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(3600),

  // Eval-in-the-loop rollout controller (offline golden-set gate). Suites + rollouts are
  // always manageable (owner-only); RUNNING a rollout proxies each case through the
  // gateway, so it needs EVAL_GATEWAY_URL + EVAL_GATEWAY_KEY (a virtual key scoped for
  // eval traffic). The gateway host must be on OUTBOUND_HOST_ALLOWLIST (SSRF guard). With
  // MODELS_CATALOG_FILE set, the `max-cost-micro-usd` scorer is priced; else cost is null.
  // Unset URL/key ⇒ POST /admin/rollouts/:id/run returns 501.
  EVAL_ROLLOUT_ENABLED: envBool(false),
  EVAL_GATEWAY_URL: z.string().url().optional(),
  EVAL_GATEWAY_KEY: z.string().optional(),
  EVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  EVAL_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  MODELS_CATALOG_FILE: z.string().optional(),

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
  // Which id_token claim becomes the admin subject (the identity SCIM, RBAC grants and
  // session revocation key on). Default `sub` (Entra: the immutable oid). Set it to
  // `preferred_username` or `email` when the IdP's SCIM userName is the UPN/email, so
  // an SSO session and its SCIM row are the SAME subject and a deprovision revokes it.
  OIDC_SUBJECT_CLAIM: z.string().default('sub'),
  // Deadline for the OIDC discovery/JWKS fetches and the authorization-code exchange
  // (ms). Without it an unreachable IdP holds the callback for undici's ~300 s.
  OIDC_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Production requires an https issuer (and https endpoints in its discovery
  // document): the client secret is POSTed to token_endpoint. Opt-in for a local
  // plaintext IdP (dev only).
  OIDC_ALLOW_INSECURE_HTTP: envBool(false),

  // SAML 2.0 session gate for the admin console (SP-initiated, HTTP-POST ACS), beside
  // the OIDC gate. SAML_ENABLED=true needs the IdP entry point + issuer + signing cert
  // and this SP's entity id + public ACS URL. Groups come from SAML_GROUPS_ATTRIBUTE
  // (unioned with the common group/role attribute names) and map to roles through
  // SAML_ROLE_MAP — the same JSON format as OIDC_ROLE_MAP; a custom role id is valid.
  SAML_ENABLED: envBool(false),
  SAML_IDP_ENTRY_POINT: z.string().url().optional(),
  SAML_IDP_ISSUER: z.string().min(1).optional(),
  // The IdP signing certificate (PEM, or the base64 body) inline or from a file; several
  // certificates may be concatenated in the file for a key rollover.
  SAML_IDP_CERT: z.string().min(1).optional(),
  SAML_IDP_CERT_FILE: z.string().min(1).optional(),
  SAML_SP_ENTITY_ID: z.string().min(1).optional(),
  SAML_SP_CALLBACK_URL: z.string().url().optional(),
  // Optional SP signing key (+ its certificate, published in the SP metadata) so the
  // AuthnRequest is signed; required by some IdPs, verified by none otherwise.
  SAML_SP_PRIVATE_KEY: z.string().min(1).optional(),
  SAML_SP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  SAML_SP_CERT: z.string().min(1).optional(),
  SAML_SP_CERT_FILE: z.string().min(1).optional(),
  SAML_GROUPS_ATTRIBUTE: z.string().min(1).default('groups'),
  // `NameID` (the assertion subject) or an attribute name that becomes the admin subject.
  SAML_SUBJECT_ATTRIBUTE: z.string().min(1).default('NameID'),
  SAML_ROLE_MAP: z.string().default('[]'),
  SAML_POST_LOGIN_REDIRECT: z.string().default('/'),
  // The SAML flow cookie rides the IdP's cross-site POST, so it is SameSite=None and
  // therefore MUST be Secure: true behind HTTPS (required in production).
  SAML_COOKIE_SECURE: envBool(false),
  // IdP-initiated SSO (a Response with no InResponseTo) is refused unless enabled; it
  // forgoes the browser-bound flow binding and relies on signature + audience +
  // destination + the assertion replay guard.
  SAML_ALLOW_IDP_INITIATED: envBool(false),
  // Which signature(s) to require. Either may be on; the library always needs at least
  // one valid signature. Entra signs the assertion by default, Okta signs both.
  SAML_WANT_ASSERTIONS_SIGNED: envBool(true),
  SAML_WANT_RESPONSE_SIGNED: envBool(false),
  // Clock skew tolerated on NotBefore / NotOnOrAfter (ms).
  SAML_CLOCK_SKEW_MS: z.coerce.number().int().nonnegative().default(60_000),
  // Production requires https for the IdP entry point and the ACS URL (the browser
  // carries the assertion between them); opt out for a plaintext dev IdP only.
  SAML_ALLOW_INSECURE_HTTP: envBool(false),

  // Entra (Azure AD) Graph adapter for the OAuth broker's revoke-on-deprovision.
  // When TENANT_ID + GRAPH_CLIENT_ID + GRAPH_CLIENT_SECRET are set, the broker checks
  // Microsoft Graph `accountEnabled` on refresh (app registration needs the
  // User.Read.All / Directory.Read.All APPLICATION permission with admin consent).
  // Graph + login hosts must be on OUTBOUND_HOST_ALLOWLIST. Otherwise every principal
  // is treated as active (dev/simulated).
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_GRAPH_CLIENT_ID: z.string().optional(),
  ENTRA_GRAPH_CLIENT_SECRET: z.string().optional(),
  ENTRA_GRAPH_BASE: z.string().url().default('https://graph.microsoft.com'),
  ENTRA_LOGIN_BASE: z.string().url().default('https://login.microsoftonline.com'),
  ENTRA_ACTIVE_CACHE_MS: z.coerce.number().int().positive().default(600_000),
  // Deadline for each Graph / login call (ms). Default 5 s.
  ENTRA_GRAPH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // SCIM Groups → role mapping. JSON { "<group displayName>": { role, orgId } }.
  // When an IdP provisions a group via /scim/v2/Groups, each member is granted the
  // mapped role (orgId "*" = platform-wide). A group not in the map is tracked but
  // grants nothing. Empty {} => SCIM Groups accepted but no role provisioning.
  SCIM_GROUP_ROLE_MAP: z.string().default('{}'),

  // DB mode readiness gate: compare drizzle's applied-migrations table with the
  // migrations this build ships; /ready is 503 while the schema is behind (or the
  // database was never migrated). Off only for a deliberately partial schema.
  DB_SCHEMA_CHECK: envBool(true),
  // DB mode read-model refresh (seconds): the console's providers/collections/tenancy
  // read model re-hydrates from Postgres on every bus signal AND on this interval, so
  // a second replica converges even if a NOTIFY is missed. 0 = signal-only.
  CONTROL_API_HYDRATE_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  // Postgres connect timeout for the control-plane pool. The statement timeout is
  // deliberately left off (long audit-chain scans), but a connect attempt must fail
  // fast so an unreachable database surfaces as a quick 5xx, not a 30 s hang per call.
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // HTTP keep-alive idle timeout for the listener; must exceed the load balancer's idle
  // timeout (see the gateway knob of the same name). Default 310 s.
  HTTP_KEEPALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(310_000),
});

/** Every environment variable the control-api reads, for documentation/CI checks. */
export const ENV_KEYS: readonly string[] = Object.keys(EnvShape.shape);

const StringList = z.array(z.string().min(1).max(256)).max(256);
const AllowList = z.union([z.literal('*'), StringList]);

/** One workload federation (trust configuration) — see @gulley/oauth WorkloadFederation. */
export const WorkloadFederationSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'name: [A-Za-z0-9._-], 1-64 chars'),
    issuer: z.string().url(),
    jwksUri: z.string().url().optional(),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(16)]).optional(),
    allowInternal: z.boolean().optional(),
    subject: z
      .object({
        pattern: z.string().min(1).max(512).optional(),
        claims: z
          .record(z.string().min(1), z.union([z.string(), z.array(z.string()).min(1).max(64)]))
          .optional(),
      })
      .strict()
      .refine((s) => s.pattern !== undefined || (!!s.claims && Object.keys(s.claims).length > 0), {
        message: 'subject must constrain a pattern and/or claims',
      }),
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    scope: z
      .object({
        allowedProviders: AllowList.optional(),
        allowedModels: AllowList.optional(),
        groups: StringList.optional(),
      })
      .strict()
      .optional(),
    ttlSeconds: z.number().int().min(1).max(86_400).optional(),
    onBehalfOf: z.boolean().optional(),
    displayName: z.string().min(1).max(256).optional(),
  })
  .strict();

const WorkloadFederationsSchema = z
  .array(WorkloadFederationSchema)
  .max(256)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((f, i) => {
      if (seen.has(f.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'name'],
          message: `duplicate federation name "${f.name}"`,
        });
      }
      seen.add(f.name);
    });
  });

export type WorkloadFederationConfig = z.infer<typeof WorkloadFederationSchema>;

/** Parse + validate WORKLOAD_FEDERATIONS (throws a ZodError / SyntaxError). */
export function parseWorkloadFederations(json: string): WorkloadFederationConfig[] {
  return WorkloadFederationsSchema.parse(JSON.parse(json));
}

const Env = EnvShape.superRefine((c, ctx) => {
  try {
    const federations = parseWorkloadFederations(c.WORKLOAD_FEDERATIONS);
    if (c.NODE_ENV === 'production') {
      federations.forEach((f, i) => {
        for (const [key, url] of [
          ['issuer', f.issuer],
          ['jwksUri', f.jwksUri],
        ] as const) {
          if (url && !/^https:\/\//i.test(url)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['WORKLOAD_FEDERATIONS', i, key],
              message: `federation "${f.name}": ${key} must be https in production`,
            });
          }
        }
      });
    }
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WORKLOAD_FEDERATIONS'],
      message: `WORKLOAD_FEDERATIONS is not a valid trust configuration: ${
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : (err as Error).message
      }`,
    });
  }
  if (
    c.NODE_ENV === 'production' &&
    c.OIDC_ISSUER &&
    !/^https:\/\//i.test(c.OIDC_ISSUER) &&
    !c.OIDC_ALLOW_INSECURE_HTTP
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_ISSUER'],
      message: 'OIDC_ISSUER must be https in production (or set OIDC_ALLOW_INSECURE_HTTP=true)',
    });
  }
  // The admin SSO session cookie must carry `Secure` in production so it can never be
  // sent over a plaintext hop. Enforced (not silently defaulted) so an operator who
  // enables SSO in prod without it gets a clear boot error, mirroring the issuer rule.
  if (
    c.NODE_ENV === 'production' &&
    c.OIDC_ISSUER &&
    c.OIDC_CLIENT_ID &&
    !c.OIDC_COOKIE_SECURE &&
    !c.OIDC_ALLOW_INSECURE_HTTP
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_COOKIE_SECURE'],
      message:
        'OIDC_COOKIE_SECURE must be true in production when SSO is enabled (or set OIDC_ALLOW_INSECURE_HTTP=true for a deliberate non-TLS edge)',
    });
  }

  // SAML: the gate needs the full SP + IdP set when enabled; production needs https on
  // both browser-facing URLs and a Secure flow/session cookie, like the OIDC gate.
  if (c.SAML_ENABLED) {
    const required: Array<[string, unknown]> = [
      ['SAML_IDP_ENTRY_POINT', c.SAML_IDP_ENTRY_POINT],
      ['SAML_IDP_ISSUER', c.SAML_IDP_ISSUER],
      ['SAML_SP_ENTITY_ID', c.SAML_SP_ENTITY_ID],
      ['SAML_SP_CALLBACK_URL', c.SAML_SP_CALLBACK_URL],
    ];
    for (const [key, value] of required) {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when SAML_ENABLED=true`,
        });
      }
    }
    if (!c.SAML_IDP_CERT && !c.SAML_IDP_CERT_FILE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SAML_IDP_CERT'],
        message: 'SAML_IDP_CERT or SAML_IDP_CERT_FILE is required when SAML_ENABLED=true',
      });
    }
    if (c.NODE_ENV === 'production' && !c.SAML_ALLOW_INSECURE_HTTP) {
      for (const [key, value] of [
        ['SAML_IDP_ENTRY_POINT', c.SAML_IDP_ENTRY_POINT],
        ['SAML_SP_CALLBACK_URL', c.SAML_SP_CALLBACK_URL],
      ] as const) {
        if (value && !/^https:\/\//i.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} must be https in production (or set SAML_ALLOW_INSECURE_HTTP=true)`,
          });
        }
      }
      if (!c.SAML_COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SAML_COOKIE_SECURE'],
          message:
            'SAML_COOKIE_SECURE must be true in production when SAML is enabled (or set SAML_ALLOW_INSECURE_HTTP=true for a deliberate non-TLS edge)',
        });
      }
    }
  }
});

export type Config = z.infer<typeof Env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(normalizeEnv(source));
}

/** The validated workload federations (empty when the grant type is off). */
export function workloadFederations(config: Config): WorkloadFederationConfig[] {
  return parseWorkloadFederations(config.WORKLOAD_FEDERATIONS);
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
