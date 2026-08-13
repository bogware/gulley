import {
  type AdminResolverDeps,
  type AdminSessionStore,
  InMemoryAdminSessionStore,
  InMemoryKeyStore,
} from '@gulley/auth';
import { type ConfigVersionStore, InMemoryConfigVersionStore } from '@gulley/config';
import { type AuditSink, GuardedAuditSink, InMemoryAuditSink } from '@gulley/pipeline';
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
  resolverDeps: AdminResolverDeps;
  /** Verify the underlying audit chain (the sink is guarded, so expose it). */
  verifyAudit: () => { verified: boolean; count: number };
  /** Hosts a provider base URL may egress to; empty = any non-blocked host. */
  outboundAllowlist: ReadonlySet<string>;
}

export interface InMemoryContextOptions {
  pepper: string;
  bootstrapEnabled: boolean;
  bootstrapTokenSha256?: string | undefined;
  sessionSecrets: readonly string[];
  maxSessionTtlMs: number;
  outboundAllowlist?: ReadonlySet<string>;
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
    resolverDeps: {
      bootstrapEnabled: opts.bootstrapEnabled,
      bootstrapTokenSha256: opts.bootstrapTokenSha256,
      sessionSecrets: opts.sessionSecrets,
      sessionStore,
      maxSessionTtlMs: opts.maxSessionTtlMs,
    },
    verifyAudit: () => ({ verified: inner.verify(), count: inner.rows.length }),
    outboundAllowlist: opts.outboundAllowlist ?? new Set(),
  };
}
