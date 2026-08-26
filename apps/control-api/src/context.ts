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
  createDatabase,
  type Database,
  newOriginId,
  PostgresAuditSink,
  PostgresConfigStore,
  PostgresConfigVersionStore,
} from '@gulley/storage';
import type { ApplyCommitDeps } from '@gulley/config';
import type { OidcProvider } from '@gulley/oidc';
import type { OidcRoleRule } from './oidc-gate';
import {
  type AuditSink,
  GuardedAuditSink,
  InMemoryAuditSink,
  InMemoryRequestLog,
  type RequestLogQuery,
} from '@gulley/pipeline';
import { type AccessControl, InMemoryAccessControl } from '@gulley/rbac';
import type { CollectionKind } from './domain';
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
  keys: KeyAdminStore;
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
  resolverDeps: AdminResolverDeps;
  /** Verify the underlying audit chain (the sink is guarded, so expose it). */
  verifyAudit: () => { verified: boolean; count: number };
  /** Hosts a provider base URL may egress to; empty = any non-blocked host. */
  outboundAllowlist: ReadonlySet<string>;
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
}

/** Build a fully in-memory control-plane context — used by tests and the live
 *  check. The Postgres-backed context is a documented seam (no Docker here). */
export function createInMemoryControlContext(opts: InMemoryContextOptions): ControlContext {
  const inner = new InMemoryAuditSink();
  const audit = new GuardedAuditSink(inner);
  const keyStore = new InMemoryKeyStore();
  const sessionStore = new InMemoryAdminSessionStore();

  const collections = Object.fromEntries(
    COLLECTION_KINDS.map((k) => [k, new ScopedCollection()]),
  ) as Record<CollectionKind, ScopedCollection>;

  // Durable config path (opt-in): when a DB is available, config apply persists
  // to the Postgres tables the gateway reads, and versions are durable too.
  const db = opts.db ?? (opts.databaseUrl ? createDatabase(opts.databaseUrl) : undefined);
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
    keys: new KeyAdminStore(keyStore, opts.pepper),
    keyStore,
    audit,
    access: new InMemoryAccessControl(),
    sessionStore,
    configVersions,
    configStore,
    configAtomic,
    requestLogQuery: opts.requestLogQuery ?? new InMemoryRequestLog(),
    resolverDeps: {
      bootstrapEnabled: opts.bootstrapEnabled,
      bootstrapTokenSha256: opts.bootstrapTokenSha256,
      sessionSecrets: opts.sessionSecrets,
      sessionStore,
      maxSessionTtlMs: opts.maxSessionTtlMs,
    },
    verifyAudit: () => ({ verified: inner.verify(), count: inner.rows.length }),
    outboundAllowlist: opts.outboundAllowlist ?? new Set(),
    oidc: opts.oidc,
    notifier: opts.notifier,
    originId: newOriginId(),
  };
}
