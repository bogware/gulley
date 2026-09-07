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
  PostgresConfigStore,
  PostgresConfigVersionStore,
  PostgresKeyAdminStore,
  PostgresMaskVaultStore,
  PostgresRequestLogQuery,
  readAuditRows,
  type MaskVaultStore,
} from '@gulley/storage';
import type { Encryptor } from '@gulley/crypto';
import type { ApplyCommitDeps } from '@gulley/config';
import type { OidcProvider } from '@gulley/oidc';
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
  WorkspaceStore,
} from './stores';

export interface ControlContext {
  orgs: OrgStore;
  workspaces: WorkspaceStore;
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
  resolverDeps: AdminResolverDeps;
  /** Durable admin-user directory (DB mode); absent = in-memory principal only. */
  adminUsers?: PostgresAdminUserStore;
  /** Durable role grants (DB mode) — authoritative for a session's effective
   *  memberships (loaded via resolverDeps.membershipLoader). */
  durableMemberships?: PostgresMembershipStore;
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
  /** Durable mask-reversal store (M22 D); present (with an encryptor) ⇒ the reveal
   *  endpoint is served. */
  maskVault?: MaskVaultStore;
  /** Envelope decryptor for the mask vault — the SAME key the gateway encrypted with. */
  maskVaultEncryptor?: Encryptor;
  /** Hosts a provider base URL may egress to; empty = any non-blocked host. */
  outboundAllowlist: ReadonlySet<string>;
  /** The gateway's public base URL for generated client configs; absent ⇒ the
   *  client-config endpoint is not served. */
  gatewayPublicUrl?: string;
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
  /** Gateway public base URL for generated client configs. */
  gatewayPublicUrl?: string;
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
  /** Inject a pre-built Database (tests); overrides databaseUrl. */
  db?: Database;
  /** HMAC key that signs auditor attestations; absent = attestation export off. */
  attestationKey?: string;
  /** Optional label stamped on the attestation. */
  attestationSubject?: string;
  /** Durable mask-reversal store (tests inject one). */
  maskVault?: MaskVaultStore;
  /** Envelope decryptor for the mask vault (tests inject a shared cipher). */
  maskVaultEncryptor?: Encryptor;
  /** Provider usage/cost ingest sources for shadow-spend reconciliation. Tests
   *  inject fakes; prod wires Anthropic/OpenAI admin-API clients from config. */
  providerUsageSources?: ProviderUsageSource[];
  /** Shadow/provider spend ratio (basis points) at/above which a provider is
   *  flagged for a bypass alert. Default 500 (5%). */
  shadowSpendFlagBps?: number;
  /** Inject the shadow-spend port directly (tests / a custom backend); overrides
   *  the DB-derived default. */
  shadowSpend?: ControlContext['shadowSpend'];
}

/** Build a fully in-memory control-plane context — used by tests and the live
 *  check. The Postgres-backed context is a documented seam (no Docker here). */
export function createInMemoryControlContext(opts: InMemoryContextOptions): ControlContext {
  // Durable config path (opt-in): when a DB is available, config apply persists
  // to the Postgres tables the gateway reads, and versions are durable too.
  const db = opts.db ?? (opts.databaseUrl ? createDatabase(opts.databaseUrl) : undefined);

  const inner = new InMemoryAuditSink();
  // Admin mutations AND mask-vault PII reveals audit through ctx.audit. With a DB,
  // back it with the durable, hash-chained Postgres sink (was in-memory even when
  // a DB was configured, so a restart wiped the record of who revealed which PII).
  const audit = new GuardedAuditSink(db ? new PostgresAuditSink(db) : inner);
  const keyStore = new InMemoryKeyStore();
  const sessionStore = new InMemoryAdminSessionStore();

  // Durable RBAC (DB mode): the admin-user directory + role grants persisted in
  // Postgres. Unlike the in-memory MembershipStore (a write-only ledger), these rows
  // are AUTHORITATIVE — loaded into a session principal at auth time via
  // membershipLoader, so a grant/revoke is effective immediately.
  const adminUsers = db ? new PostgresAdminUserStore(db) : undefined;
  const durableMemberships = db ? new PostgresMembershipStore(db) : undefined;
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

  return {
    orgs: new OrgStore(),
    workspaces: new WorkspaceStore(),
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
    auditRows: db ? () => readAuditRows(db) : async () => inner.rows,
    attestationKey: opts.attestationKey,
    attestationSubject: opts.attestationSubject,
    // Only served when an encryptor is present (the store never sees plaintext, and
    // reveal must decrypt) — so a DB alone doesn't turn the reveal endpoint on.
    maskVault:
      opts.maskVault ??
      (db && opts.maskVaultEncryptor ? new PostgresMaskVaultStore(db) : undefined),
    maskVaultEncryptor: opts.maskVaultEncryptor,
    outboundAllowlist: opts.outboundAllowlist ?? new Set(),
    gatewayPublicUrl: opts.gatewayPublicUrl,
    onboardingSigningKey: opts.onboardingSigningKey,
    oidc: opts.oidc,
    notifier: opts.notifier,
    originId: newOriginId(),
  };
}
