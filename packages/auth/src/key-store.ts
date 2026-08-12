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
}
