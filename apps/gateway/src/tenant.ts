import type { SecretResolver } from '@gulley/core';
import type { Database } from '@gulley/storage';
import { resolveProviderCredentialRef } from '@gulley/storage';
import type { UpstreamCredential } from '@gulley/providers';

/**
 * Resolves the UPSTREAM credential a given tenant (workspace) should use for a
 * provider — the core of multi-tenant isolation: one gateway fronts many tenants,
 * each authenticating to the provider with its OWN key. When a tenant has no
 * provider credential of its own, the caller falls back to the gateway's default
 * (env / route) credential, so single-tenant deployments are unaffected.
 */
export interface TenantCredentialResolver {
  resolve(workspaceId: string, provider: string): Promise<UpstreamCredential | undefined>;
}

/** Provider credential scheme by kind (mirrors the env/route builder). */
export function credentialFor(provider: string, value: string): UpstreamCredential {
  switch (provider) {
    case 'anthropic':
      return value.startsWith('sk-ant-')
        ? { scheme: 'x-api-key', value }
        : { scheme: 'bearer', value };
    case 'azure':
      return { scheme: 'api-key', value };
    default:
      return { scheme: 'bearer', value };
  }
}

/** In-process tenant credentials (dev/tests): workspaceId → provider → credential. */
export class MapTenantCredentialResolver implements TenantCredentialResolver {
  constructor(private readonly map: ReadonlyMap<string, ReadonlyMap<string, UpstreamCredential>>) {}
  async resolve(workspaceId: string, provider: string): Promise<UpstreamCredential | undefined> {
    return this.map.get(workspaceId)?.get(provider);
  }
}

interface CacheEntry {
  credential: UpstreamCredential | undefined;
  expiresAt: number;
}

/**
 * Production resolver: reads the tenant's provider credential ARN from Postgres
 * (by workspace + provider kind), resolves it to a value via the SecretResolver,
 * and caches the result with a TTL (secrets rotate). A miss (no per-tenant
 * provider) caches `undefined` too, so a single-tenant workspace doesn't re-query
 * every request.
 */
export class DbTenantCredentialResolver implements TenantCredentialResolver {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretResolver,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(workspaceId: string, provider: string): Promise<UpstreamCredential | undefined> {
    const key = `${workspaceId}|${provider}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.credential;

    let credential: UpstreamCredential | undefined;
    const ref = await resolveProviderCredentialRef(this.db, workspaceId, provider);
    if (ref) credential = credentialFor(provider, await this.secrets.resolve(ref));
    this.cache.set(key, { credential, expiresAt: this.now() + this.ttlMs });
    return credential;
  }
}
