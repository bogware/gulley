import {
  type AdminResolverDeps,
  type AdminSessionStore,
  InMemoryAdminSessionStore,
  InMemoryKeyStore,
} from '@gulley/auth';
import {
  type ConfigStore,
  type ConfigVersionStore,
  InMemoryConfigVersionStore,
} from '@gulley/config';
import {
  type ConfigNotifier,
  chargebackReport,
  type ChargebackRow,
  createDatabase,
  type Database,
  ledgerSpendTotals,
  newOriginId,
  PostgresAdminUserStore,
  PostgresAuditSink,
  PostgresMembershipStore,
  PostgresScimGroupStore,
  PostgresConfigStore,
  PostgresConfigVersionStore,
  PostgresKeyAdminStore,
  PostgresMaskVaultStore,
  PostgresSubjectKeyStore,
  PostgresRequestLogQuery,
  PostgresAdminSessionStore,
  PostgresGrantStore,
  PostgresDeviceCodeStore,
  PostgresAuthCodeStore,
  PostgresOAuthClientStore,
  PostgresTenancyStore,
  readAuditRows,
  type MaskVaultStore,
} from '@gulley/storage';
import {
  BrokerService,
  type IdentityProvider,
  InMemoryAuthCodeStore,
  InMemoryDeviceCodeStore,
  InMemoryGrantStore,
  InMemoryOAuthClientStore,
} from '@gulley/oauth';
import {
  type AsymmetricSigner,
  type BatchVerifier,
  type Encryptor,
  ShreddableCipher,
  type Signer,
  type SubjectKeyStore,
} from '@gulley/crypto';
import type { AuditMirror } from '@gulley/worm';
import type { Anchor } from './anchor';
import { type SiemConnector, SiemExporter } from './siem';
import { type EvalStore, InMemoryEvalStore } from './eval-store';
import type { EvalRunner } from './eval-runner';
import type { RolloutPromoter } from './eval-rollout-routes';
import type { GatewayMetricsProvider } from './gateway-metrics';
import type { ApplyCommitDeps } from '@gulley/config';
import type { OidcProvider } from '@gulley/oidc';
import { WormShipper } from './worm-shipper';
import {
  type ProviderUsageSource,
  runShadowSpendReconciliation,
  type ShadowSpendReport,
} from './shadow-spend';
import type { OidcRoleRule } from './oidc-gate';
import {
  type AuditRow,
  type AuditSink,
  GuardedAuditSink,
  InMemoryAuditSink,
  InMemoryRequestLog,
  type RequestLogQuery,
  verifyAuditChain,
} from '@gulley/pipeline';
import { InMemoryPromptRegistry, type PromptRegistry } from '@gulley/prompts';
import { type AccessControl, InMemoryAccessControl, isRole, type Membership } from '@gulley/rbac';
import type { CollectionKind, KeyAdmin } from './domain';
import { COLLECTION_KINDS } from './domain';
import {
  KeyAdminStore,
  MembershipStore,
  OrgStore,
  ProjectStore,
  ProviderCredentialStore,
  ProviderStore,
  ScopedCollection,
  type TenancyPersistence,
  WorkspaceStore,
} from './stores';

export interface ControlContext {
  orgs: OrgStore;
  workspaces: WorkspaceStore;
  /** DB mode: reload the org/workspace read models from Postgres (boot + after a
   *  config apply that may have created tenancy rows). Absent ⇒ in-memory only. */
  hydrateTenancy?: () => Promise<{ orgs: number; workspaces: number }>;
  projects: ProjectStore;
  memberships: MembershipStore;
  providers: ProviderStore;
  credentials: ProviderCredentialStore;
  collections: Record<CollectionKind, ScopedCollection>;
  /** Governed prompt registry — versioned, hash-chained prompt templates. */
  prompts: PromptRegistry;
  keys: KeyAdmin;
  keyStore: InMemoryKeyStore;
  audit: AuditSink;
  access: AccessControl;
  sessionStore: AdminSessionStore;
  configVersions: ConfigVersionStore;
  /** Durable config store (Postgres); absent = in-memory ControlConfigStore. */
  configStore?: ConfigStore;
  /** Runs a config apply's reconcile + audit + version-append in ONE Postgres
   *  transaction; absent = the in-memory path (no cross-store atomicity needed). */
  configAtomic?: <T>(fn: (deps: ApplyCommitDeps) => Promise<T>) => Promise<T>;
  /** Read side of the request log: admin log browser + usage analytics. */
  requestLogQuery: RequestLogQuery;
  /** Chargeback/showback over the durable spend ledger (grouped by workspace / model
   *  / provider / attr:<tag>). Absent when no DB is wired. */
  chargeback?: (opts: {
    groupBy: string;
    from?: Date;
    to?: Date;
    workspaceIds?: string[];
  }) => Promise<ChargebackRow[]>;
  /** Shadow-spend reconciliation: provider usage/cost APIs vs the gateway ledger, to
   *  surface spend that bypassed Gulley. Absent when no DB is wired. */
  shadowSpend?: (opts: {
    from?: Date;
    to?: Date;
    workspaceIds?: string[];
  }) => Promise<ShadowSpendReport>;
  /** Live gateway observability: fetch + parse the gateway's Prometheus /metrics.
   *  Absent ⇒ /admin/observability/* returns 501. */
  gatewayMetrics?: GatewayMetricsProvider;
  /** OAuth broker (enterprise device + auth-code/PKCE). Present ⇒ /oauth/* is mounted. */
  oauthBroker?: BrokerService;
  /** Durable broker stores for the OAuth admin console (DB mode): grant/device/client
   *  listing + revoke + client CRUD. Absent ⇒ the OAuth admin endpoints 501. */
  oauthAdmin?: {
    grants: PostgresGrantStore;
    devices: PostgresDeviceCodeStore;
    clients: PostgresOAuthClientStore;
  };
  /** Admin-session registry (for the Sessions console). Same object as
   *  resolverDeps.sessionStore; its optional list/revoke drive the view. */
  sessions: AdminSessionStore;
  resolverDeps: AdminResolverDeps;
  /** Durable admin-user directory (DB mode); absent = in-memory principal only. */
  adminUsers?: PostgresAdminUserStore;
  /** Durable role grants (DB mode) — authoritative for a session's effective
   *  memberships (loaded via resolverDeps.membershipLoader). */
  durableMemberships?: PostgresMembershipStore;
  /** SCIM-provisioned groups (DB mode) — member changes grant/revoke role memberships. */
  scimGroups?: PostgresScimGroupStore;
  /** Verify the underlying audit chain (the sink is guarded, so expose it). Async
   *  because the durable chain is read from Postgres when a DB is present. */
  verifyAudit: () => Promise<{ verified: boolean; count: number }>;
  /** Read the full audit chain (ordered) for an attestation export; absent = not
   *  supported by this backend. */
  auditRows?: () => Promise<AuditRow[]>;
  /** HMAC key that signs auditor attestations; absent = attestation export off. */
  attestationKey?: string;
  /** Optional label stamped on the attestation. */
  attestationSubject?: string;
  /** Audit-export ASYMMETRIC signer (KMS). When present it signs the attestation and
   *  the WORM batches, and its public key is served at GET /audit/public-key so an
   *  auditor verifies both offline. Absent = HMAC/shared-secret signing only. */
  auditSigner?: AsymmetricSigner;
  /** WORM-live shipper: mirrors the complete durable audit chain to S3 Object Lock
   *  in signed, contiguous batches. Absent = WORM not configured (endpoints 501). */
  wormShipper?: WormShipper;
  /** External anchor sink for periodic signed chain-head checkpoints (rewrite
   *  detection even against the operator). Absent = anchoring off (endpoints 501). */
  anchor?: Anchor;
  /** SIEM exporter: tails new audit-trail events to Splunk/Sentinel/webhook. Absent =
   *  SIEM export off (endpoints 501). */
  siemExporter?: SiemExporter;
  /** Durable mask-reversal store (M22 D); present (with an encryptor) ⇒ the reveal
   *  endpoint is served. */
  maskVault?: MaskVaultStore;
  /** Envelope decryptor for the mask vault — the SAME key the gateway encrypted with.
   *  When crypto-shred is on this is a ShreddableCipher (per-subject keys). */
  maskVaultEncryptor?: Encryptor;
  /** Per-subject crypto-shred key registry; present ⇒ the /admin/crypto-shred endpoints
   *  are served and mask-vault reveal of a shredded subject fails (data unrecoverable). */
  subjectKeys?: SubjectKeyStore;
  /** Eval-in-the-loop rollout registry (suites + rollouts). Always present; the run
   *  endpoint additionally needs an {@link evalRunner}. */
  evalStore?: EvalStore;
  /** Runs an eval case against a model through the real gateway. Absent ⇒
   *  /admin/rollouts/:id/run returns 501. */
  evalRunner?: EvalRunner;
  /** Promotes a rollout (repoints the model alias via config-apply). Absent ⇒ built
   *  from this context; tests inject a stub. */
  rolloutPromoter?: RolloutPromoter;
  /** Hosts a provider base URL may egress to; empty = any non-blocked host. */
  outboundAllowlist: ReadonlySet<string>;
  /** The gateway's public base URL for generated client configs; absent ⇒ the
   *  client-config endpoint is not served. */
  gatewayPublicUrl?: string;
  /** This control plane's own public base URL (the OAuth broker's issuer, e.g.
   *  https://api.gulley.acme.internal). Used for RFC 8414 metadata, the device-flow
   *  verification URI fallback, and OAuth-mode client configs. Absent ⇒ derived per
   *  request from the (proxy-trusted) Host header. */
  controlApiPublicUrl?: string;
  /** The admin console's public base URL; when set, device-flow consent points at
   *  the console's /oauth/device page (else the control-api's minimal page). */
  consolePublicUrl?: string;
  /** Ed25519 private key (PEM) that signs onboarding packs; absent ⇒ the
   *  onboarding-pack + public-key endpoints are not served. */
  onboardingSigningKey?: string;
  /** OIDC session gate config; absent = OIDC login disabled (token-paste only). */
  oidc?: OidcSessionConfig;
  /** Broadcasts a post-commit config signal to gateway replicas; absent = no
   *  hot-reload propagation (single-process / v1 default). */
  notifier?: ConfigNotifier;
  /** This process's origin id, stamped on emitted signals so a subscriber that
   *  is also a publisher can ignore its own writes. */
  originId: string;
  /** The durable Postgres handle when running in DB mode; absent = in-memory. Exposed so
   *  process-level maintenance (e.g. the OAuth-ephemera retention sweep) can run against
   *  the same pool. */
  db?: Database;
}

export interface OidcSessionConfig {
  provider: OidcProvider;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
  groupsClaim: string;
  roleRules: OidcRoleRule[];
  postLoginRedirect: string;
  cookieSecure: boolean;
  /** Injected HTTP for the token exchange (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface InMemoryContextOptions {
  pepper: string;
  bootstrapEnabled: boolean;
  bootstrapTokenSha256?: string | undefined;
  sessionSecrets: readonly string[];
  maxSessionTtlMs: number;
  outboundAllowlist?: ReadonlySet<string>;
  /** Inject a tenancy persistence port (tests); DB mode builds PostgresTenancyStore. */
  tenancy?: TenancyPersistence;
  /** Gateway public base URL for generated client configs. */
  gatewayPublicUrl?: string;
  /** Control-plane (broker issuer) + console public base URLs; see ControlContext. */
  controlApiPublicUrl?: string;
  consolePublicUrl?: string;
  /** Ed25519 private key (PEM) that signs onboarding packs. */
  onboardingSigningKey?: string;
  /** Inject a pre-seeded query backend (tests); defaults to a fresh in-memory log. */
  requestLogQuery?: RequestLogQuery;
  oidc?: OidcSessionConfig;
  /** Config-change broadcaster (composite PG+Redis bus in prod); absent = none. */
  notifier?: ConfigNotifier;
  /** Postgres URL; when set, the config path is durable (persists to the tables
   *  the gateway reads) instead of in-memory. */
  databaseUrl?: string;
  /** Connect timeout for the pool built from databaseUrl (config.DB_CONNECT_TIMEOUT_MS). */
  dbConnectTimeoutMs?: number;
  /** Inject a pre-built Database (tests); overrides databaseUrl. */
  db?: Database;
  /** HMAC key that signs auditor attestations; absent = attestation export off. */
  attestationKey?: string;
  /** Optional label stamped on the attestation. */
  attestationSubject?: string;
  /** Audit-export asymmetric signer (KMS in prod; a LocalKeypairSigner twin in tests).
   *  Signs the attestation + WORM batches; its public key is served for offline
   *  verification. */
  auditSigner?: AsymmetricSigner;
  /** WORM-live wiring: the retained mirror + the batch signer/verifier. Prod builds
   *  an S3AuditMirror + HMAC signer from config; tests inject an InMemoryAuditMirror
   *  + InMemoryHmacSigner. Absent = WORM off. */
  worm?: {
    mirror: AuditMirror;
    signer: Signer;
    verifier: BatchVerifier;
    batchMax?: number;
  };
  /** External anchor sink (prod: an HttpAnchor; tests inject an InMemoryAnchor). */
  anchor?: Anchor;
  /** SIEM connector (prod: Splunk/Sentinel/webhook; tests inject a fake). Wrapped in a
   *  SiemExporter over the durable audit chain. */
  siem?: { connector: SiemConnector; batchMax?: number };
  /** Durable mask-reversal store (tests inject one). */
  maskVault?: MaskVaultStore;
  /** Envelope decryptor for the mask vault (tests inject a shared cipher). */
  maskVaultEncryptor?: Encryptor;
  /** Enable BYOK crypto-shred: wrap the mask encryptor in a ShreddableCipher over a
   *  per-subject key registry (durable when a DB is present; tests inject one directly). */
  cryptoShredEnabled?: boolean;
  /** Inject a SubjectKeyStore directly (tests); overrides the DB-derived default. */
  subjectKeys?: SubjectKeyStore;
  /** Inject an eval-rollout store (tests); default is a fresh in-memory registry. */
  evalStore?: EvalStore;
  /** Eval runner (prod: a GatewayEvalRunner from config; tests inject a fake returning
   *  canned results). Absent ⇒ the rollout run endpoint 501s. */
  evalRunner?: EvalRunner;
  /** Inject a rollout promoter (tests); default repoints the alias via config-apply. */
  rolloutPromoter?: RolloutPromoter;
  /** Provider usage/cost ingest sources for shadow-spend reconciliation. Tests
   *  inject fakes; prod wires Anthropic/OpenAI admin-API clients from config. */
  providerUsageSources?: ProviderUsageSource[];
  /** Shadow/provider spend ratio (basis points) at/above which a provider is
   *  flagged for a bypass alert. Default 500 (5%). */
  shadowSpendFlagBps?: number;
  /** Inject the shadow-spend port directly (tests / a custom backend); overrides
   *  the DB-derived default. */
  shadowSpend?: ControlContext['shadowSpend'];
  /** Live gateway metrics provider (prod: built from GATEWAY_METRICS_URL; tests inject
   *  a fake). Absent ⇒ /admin/observability/* returns 501. */
  gatewayMetrics?: GatewayMetricsProvider;
  /** OAuth broker config. When `enabled`, the broker is built (durable stores when a DB
   *  is present) and /oauth/* is mounted. */
  oauthBroker?: {
    enabled: boolean;
    pepper: string;
    accessTtlMs?: number;
    refreshTtlMs?: number;
    absoluteTtlMs?: number;
    deviceCodeTtlMs?: number;
    deviceIntervalMs?: number;
    /** Upstream identity provider for revoke-on-deprovision. When omitted the broker
     *  treats every principal as active (dev/simulated) — wire an EntraGraphIdp in prod. */
    idp?: IdentityProvider;
  };
  /** SCIM Groups → role mapping (group displayName → { role, orgId }; orgId "*" =
   *  platform-wide). Drives role provisioning on /scim/v2/Groups member changes. */
  scimGroupRoleMap?: Record<string, { role: string; orgId: string }>;
}

/** Build a fully in-memory control-plane context — used by tests and the live
 *  check. The Postgres-backed context is a documented seam (no Docker here). */
export function createInMemoryControlContext(opts: InMemoryContextOptions): ControlContext {
  // Durable config path (opt-in): when a DB is available, config apply persists
  // to the Postgres tables the gateway reads, and versions are durable too.
  // Connect fast-fail + idle reclaim; the statement timeout stays off (long chain scans).
  const db =
    opts.db ??
    (opts.databaseUrl
      ? createDatabase(opts.databaseUrl, {
          connectTimeoutMs: opts.dbConnectTimeoutMs ?? 5_000,
          idleTimeoutMs: 30_000,
        })
      : undefined);

  const inner = new InMemoryAuditSink();
  // Admin mutations AND mask-vault PII reveals audit through ctx.audit. With a DB,
  // back it with the durable, hash-chained Postgres sink (was in-memory even when
  // a DB was configured, so a restart wiped the record of who revealed which PII).
  const audit = new GuardedAuditSink(db ? new PostgresAuditSink(db) : inner);
  const keyStore = new InMemoryKeyStore();
  // Durable session registry (DB mode) so the console can list + revoke live admin
  // sessions; in-memory otherwise (revocation + per-process listing only).
  const sessionStore: AdminSessionStore = db
    ? new PostgresAdminSessionStore(db)
    : new InMemoryAdminSessionStore();

  // Durable RBAC (DB mode): the admin-user directory + role grants persisted in
  // Postgres. Unlike the in-memory MembershipStore (a write-only ledger), these rows
  // are AUTHORITATIVE — loaded into a session principal at auth time via
  // membershipLoader, so a grant/revoke is effective immediately.
  const adminUsers = db ? new PostgresAdminUserStore(db) : undefined;
  const durableMemberships = db ? new PostgresMembershipStore(db) : undefined;
  const scimGroups = db
    ? new PostgresScimGroupStore(db, (displayName) => {
        const e = opts.scimGroupRoleMap?.[displayName];
        return e && isRole(e.role)
          ? { role: e.role, orgId: e.orgId === '*' ? null : e.orgId }
          : null;
      })
    : undefined;
  const membershipLoader = durableMemberships
    ? async (subject: string): Promise<Membership[]> => {
        const rows = await durableMemberships.membershipsForSubject(subject);
        return rows
          .filter((r) => isRole(r.role))
          .map((r) => ({
            role: r.role as Membership['role'],
            // A persisted NULL org is a platform grant (covers all orgs).
            orgId: r.orgId ?? '*',
            workspaceId: r.workspaceId,
          }));
      }
    : undefined;

  // The authoritative, ordered audit chain source — durable Postgres rows when a DB
  // is present (the auditor-facing source of truth), else the in-memory sink. Both
  // attestation export AND the WORM shipper read from this single closure, so WORM
  // ships the exact complete chain an attestation covers.
  const auditRows: () => Promise<AuditRow[]> = db
    ? () => readAuditRows(db)
    : async () => inner.rows;

  // Incremental (tail) reader for the WORM shipper + SIEM exporter: they track a cursor
  // and only ever want rows past it, so they read `seq > sinceSeq` instead of pulling the
  // ever-growing chain whole every ~60s tick (escalating DB load + heap pressure toward
  // OOM as the compliance record accumulates). The full-chain reader above stays for
  // attestation / verify / anchor, which must walk the complete chain.
  const auditRowsSince = (sinceSeq?: number): Promise<AuditRow[]> =>
    db
      ? readAuditRows(db, sinceSeq)
      : Promise.resolve(
          sinceSeq === undefined ? inner.rows : inner.rows.filter((r) => r.seq > sinceSeq),
        );

  // WORM-live shipper: ships that complete durable chain to the immutable mirror.
  const wormShipper = opts.worm
    ? new WormShipper({
        mirror: opts.worm.mirror,
        signer: opts.worm.signer,
        verifier: opts.worm.verifier,
        readRows: auditRowsSince,
        ...(opts.worm.batchMax !== undefined ? { batchMax: opts.worm.batchMax } : {}),
      })
    : undefined;

  // SIEM exporter: tails new audit events from the same complete durable chain.
  const siemExporter = opts.siem
    ? new SiemExporter({
        connector: opts.siem.connector,
        readRows: auditRowsSince,
        ...(opts.siem.batchMax !== undefined ? { batchMax: opts.siem.batchMax } : {}),
      })
    : undefined;

  // BYOK crypto-shred: a per-subject key registry (subject keys wrapped by the master
  // encryptor = the customer's BYOK key), and a ShreddableCipher wrapping the master so
  // mask-vault records are encrypted per-subject and a shred makes them unrecoverable.
  const subjectKeys: SubjectKeyStore | undefined =
    opts.subjectKeys ??
    (opts.cryptoShredEnabled && db && opts.maskVaultEncryptor
      ? new PostgresSubjectKeyStore(db, opts.maskVaultEncryptor)
      : undefined);
  const maskEncryptor: Encryptor | undefined =
    subjectKeys && opts.maskVaultEncryptor
      ? new ShreddableCipher(opts.maskVaultEncryptor, subjectKeys)
      : opts.maskVaultEncryptor;

  // OAuth broker (enterprise device + auth-code/PKCE). Durable stores when a DB is
  // present so the admin console can list + revoke grants/clients/device-codes; a
  // superseded-refresh replay (theft) fires onReuse → an oauth.refresh_reuse audit row.
  const oauthAdmin = db
    ? {
        grants: new PostgresGrantStore(db),
        devices: new PostgresDeviceCodeStore(db),
        clients: new PostgresOAuthClientStore(db),
      }
    : undefined;
  const brokerCfg = opts.oauthBroker;
  // Prod: an EntraGraphIdp (Graph accountEnabled) wired in by main.ts so a disabled
  // user loses broker access at the next refresh. Absent (dev/no Graph creds): treat
  // every principal as active.
  const prodIdp: IdentityProvider = brokerCfg?.idp ?? {
    mode: 'entra',
    isPrincipalActive: async () => true,
  };
  const oauthBroker =
    brokerCfg?.enabled && brokerCfg.pepper
      ? new BrokerService(
          {
            pepper: brokerCfg.pepper,
            accessTtlMs: brokerCfg.accessTtlMs ?? 3_600_000,
            refreshTtlMs: brokerCfg.refreshTtlMs ?? 30 * 86_400_000,
            absoluteTtlMs: brokerCfg.absoluteTtlMs ?? 90 * 86_400_000,
            deviceCodeTtlMs: brokerCfg.deviceCodeTtlMs ?? 900_000,
            deviceIntervalMs: brokerCfg.deviceIntervalMs ?? 5000,
            onReuse: (g) => {
              // Best-effort theft signal; swallow a rejected audit write so it never
              // becomes an unhandled promise rejection (the family is already revoked).
              audit
                .append({
                  orgId: null,
                  actor: g.principalId,
                  action: 'oauth.refresh_reuse',
                  target: g.handle,
                  payload: { clientId: g.clientId, principalId: g.principalId },
                })
                .catch(() => {});
            },
          },
          oauthAdmin
            ? {
                grants: oauthAdmin.grants,
                devices: oauthAdmin.devices,
                codes: new PostgresAuthCodeStore(db!),
                clients: oauthAdmin.clients,
                idp: prodIdp,
              }
            : {
                grants: new InMemoryGrantStore(),
                devices: new InMemoryDeviceCodeStore(),
                codes: new InMemoryAuthCodeStore(),
                clients: new InMemoryOAuthClientStore(),
                idp: prodIdp,
              },
        )
      : undefined;

  const collections = Object.fromEntries(
    COLLECTION_KINDS.map((k) => [k, new ScopedCollection()]),
  ) as Record<CollectionKind, ScopedCollection>;
  const configStore = db ? new PostgresConfigStore(db) : undefined;
  const configVersions: ConfigVersionStore = db
    ? new PostgresConfigVersionStore(db)
    : new InMemoryConfigVersionStore();
  // Atomic config commit: reconcile + audit row + version row in one tx, over
  // tx-bound Postgres stores (so a failure — incl. a lost version-PK race — rolls
  // the whole apply back). Postgres audit here keeps the config-apply audit row
  // durable + atomic with the change.
  const configAtomic = db
    ? <T>(fn: (deps: ApplyCommitDeps) => Promise<T>): Promise<T> =>
        db.transaction((tx) =>
          fn({
            store: new PostgresConfigStore(tx as unknown as Database),
            audit: new PostgresAuditSink(tx as unknown as Database),
            versions: new PostgresConfigVersionStore(tx as unknown as Database),
          }),
        )
    : undefined;

  // Tenancy registries: durable write-through + boot hydration in DB mode (see
  // PostgresTenancyStore) so console-created orgs/workspaces exist in Postgres before
  // keys / OAuth clients reference them, and survive a restart.
  const tenancy = opts.tenancy ?? (db ? new PostgresTenancyStore(db) : undefined);
  const orgs = new OrgStore(tenancy);
  const workspaces = new WorkspaceStore(tenancy);

  return {
    orgs,
    workspaces,
    hydrateTenancy: tenancy
      ? async () => ({ orgs: await orgs.hydrate(), workspaces: await workspaces.hydrate() })
      : undefined,
    projects: new ProjectStore(),
    memberships: new MembershipStore(),
    providers: new ProviderStore(),
    credentials: new ProviderCredentialStore(),
    collections,
    prompts: new InMemoryPromptRegistry(),
    keys: db
      ? new PostgresKeyAdminStore(db, opts.pepper)
      : new KeyAdminStore(keyStore, opts.pepper),
    keyStore,
    audit,
    access: new InMemoryAccessControl(),
    sessionStore,
    configVersions,
    configStore,
    configAtomic,
    requestLogQuery:
      opts.requestLogQuery ?? (db ? new PostgresRequestLogQuery(db) : new InMemoryRequestLog()),
    chargeback: db ? (o) => chargebackReport(db, o) : undefined,
    shadowSpend:
      opts.shadowSpend ??
      (db
        ? async (o) => {
            const to = o.to ?? new Date();
            const from = o.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
            const gateway = await ledgerSpendTotals(db, {
              from,
              to,
              workspaceIds: o.workspaceIds,
            });
            return runShadowSpendReconciliation(
              gateway.map((r) => ({ provider: r.provider, costMicroUsd: r.costMicroUsd })),
              opts.providerUsageSources ?? [],
              from,
              to,
              { flagRatioBps: opts.shadowSpendFlagBps },
            );
          }
        : undefined),
    gatewayMetrics: opts.gatewayMetrics,
    oauthBroker,
    oauthAdmin,
    sessions: sessionStore,
    resolverDeps: {
      bootstrapEnabled: opts.bootstrapEnabled,
      bootstrapTokenSha256: opts.bootstrapTokenSha256,
      sessionSecrets: opts.sessionSecrets,
      sessionStore,
      maxSessionTtlMs: opts.maxSessionTtlMs,
      membershipLoader,
    },
    adminUsers,
    durableMemberships,
    scimGroups,
    // Verify the durable chain when a DB is present (the same rows attestation
    // reads), else the in-memory sink — so a DB-backed deploy no longer reports the
    // empty in-memory chain while admin/PII-reveal audits land in Postgres.
    verifyAudit: async () => {
      const rows = db ? await readAuditRows(db) : inner.rows;
      const r = verifyAuditChain(rows);
      return { verified: r.verified, count: r.count };
    },
    // Attestation reads the durable chain when a DB is present (the auditor-facing
    // source of truth), else the in-memory sink (dev/test) — same core verifier.
    auditRows,
    attestationKey: opts.attestationKey,
    attestationSubject: opts.attestationSubject,
    auditSigner: opts.auditSigner,
    wormShipper,
    anchor: opts.anchor,
    siemExporter,
    // Only served when an encryptor is present (the store never sees plaintext, and
    // reveal must decrypt) — so a DB alone doesn't turn the reveal endpoint on.
    maskVault:
      opts.maskVault ??
      (db && opts.maskVaultEncryptor ? new PostgresMaskVaultStore(db) : undefined),
    // The mask-vault encryptor is the crypto-shred cipher when a subject-key store is
    // wired, so every vault record is encrypted under its subject's key and a shred
    // makes it permanently unrecoverable; otherwise it's the raw master encryptor.
    maskVaultEncryptor: maskEncryptor,
    subjectKeys,
    evalStore: opts.evalStore ?? new InMemoryEvalStore(),
    evalRunner: opts.evalRunner,
    rolloutPromoter: opts.rolloutPromoter,
    outboundAllowlist: opts.outboundAllowlist ?? new Set(),
    gatewayPublicUrl: opts.gatewayPublicUrl,
    controlApiPublicUrl: opts.controlApiPublicUrl,
    consolePublicUrl: opts.consolePublicUrl,
    onboardingSigningKey: opts.onboardingSigningKey,
    oidc: opts.oidc,
    notifier: opts.notifier,
    originId: newOriginId(),
    db,
  };
}
