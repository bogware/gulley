/** A persisted virtual key, minus the secret (only its HMAC is kept). */
export interface StoredKey {
  id: string;
  keyPrefix: string;
  keyHash: string;
  orgId: string;
  workspaceId: string;
  displayName: string;
  epoch: number;
  disabled: boolean;
  expiresAt: Date | null;
  allowedProviders: readonly string[] | '*';
  allowedModels: readonly string[] | '*';
  /** Group/team tags carried onto the principal's scope (for per-group config). */
  groups?: readonly string[];
}

/** Port for looking up virtual keys. Postgres-backed in prod, in-memory in tests. */
export interface KeyStore {
  findByPrefix(keyPrefix: string): Promise<StoredKey | null>;
  touchLastUsed(id: string): Promise<void>;
}

export class InMemoryKeyStore implements KeyStore {
  private readonly byPrefix = new Map<string, StoredKey>();
  readonly lastUsed = new Set<string>();

  add(key: StoredKey): void {
    this.byPrefix.set(key.keyPrefix, key);
  }

  async findByPrefix(keyPrefix: string): Promise<StoredKey | null> {
    return this.byPrefix.get(keyPrefix) ?? null;
  }

  async touchLastUsed(id: string): Promise<void> {
    this.lastUsed.add(id);
  }

  /** Disable a stored key by prefix (admin revoke); bumps its epoch. */
  disableByPrefix(prefix: string): void {
    const k = this.byPrefix.get(prefix);
    if (k) this.byPrefix.set(prefix, { ...k, disabled: true, epoch: k.epoch + 1 });
  }

  /** Swap a key's secret in place (admin rotate): re-key under the new prefix/hash. */
  rekey(oldPrefix: string, newPrefix: string, newHash: string): void {
    const k = this.byPrefix.get(oldPrefix);
    if (!k) return;
    this.byPrefix.delete(oldPrefix);
    this.byPrefix.set(newPrefix, {
      ...k,
      keyPrefix: newPrefix,
      keyHash: newHash,
      epoch: k.epoch + 1,
    });
  }
}
