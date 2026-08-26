import {
  type AdminResolverDeps,
  type AdminSessionStore,
  InMemoryAdminSessionStore,
  InMemoryKeyStore,
} from '@gulley/auth';
import { type ConfigVersionStore, InMemoryConfigVersionStore } from '@gulley/config';
import { type ConfigNotifier, newOriginId } from '@gulley/storage';
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
    configVersions: new InMemoryConfigVersionStore(),
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
