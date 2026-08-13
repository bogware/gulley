export type GrantStatus = 'active' | 'revoked';

/** One row per token family. Rotation advances `refreshGeneration` and moves the
 *  current refresh hash into `prevRefreshTokenHash` so a single-step reuse of the
 *  superseded token can be distinguished (→ revoke) from a forged/unknown one. */
export interface Grant {
  handle: string;
  clientId: string;
  principalId: string;
  displayName: string;
  orgId: string;
  workspaceId: string;
  status: GrantStatus;
  accessTokenHash: string | null;
  accessTokenExpiresAt: number;
  refreshTokenHash: string | null;
  prevRefreshTokenHash: string | null;
  refreshGeneration: number;
  absoluteExpiresAt: number;
}

export interface RotateFields {
  accessTokenHash: string;
  accessTokenExpiresAt: number;
  refreshTokenHash: string;
  prevRefreshTokenHash: string;
  refreshGeneration: number;
}

export interface GrantStore {
  create(g: Grant): Promise<void>;
  get(handle: string): Promise<Grant | null>;
  revoke(handle: string): Promise<void>;
  setAccess(handle: string, hash: string, expiresAt: number): Promise<void>;
  /** Atomic compare-and-rotate: applies `next` only if the current generation is
   *  still `expectedGen` (optimistic concurrency). Returns false on a lost race. */
  rotate(handle: string, expectedGen: number, next: RotateFields): Promise<boolean>;
}

export class InMemoryGrantStore implements GrantStore {
  private readonly byHandle = new Map<string, Grant>();

  async create(g: Grant): Promise<void> {
    this.byHandle.set(g.handle, { ...g });
  }
  async get(handle: string): Promise<Grant | null> {
    const g = this.byHandle.get(handle);
    return g ? { ...g } : null;
  }
  async revoke(handle: string): Promise<void> {
    const g = this.byHandle.get(handle);
    if (g) g.status = 'revoked';
  }
  async setAccess(handle: string, hash: string, expiresAt: number): Promise<void> {
    const g = this.byHandle.get(handle);
    if (g) {
      g.accessTokenHash = hash;
      g.accessTokenExpiresAt = expiresAt;
    }
  }
  // Synchronous check-and-set: no await between read and write, so a concurrent
  // rotation with the same expectedGen loses the race deterministically.
  async rotate(handle: string, expectedGen: number, next: RotateFields): Promise<boolean> {
    const g = this.byHandle.get(handle);
    if (!g || g.status !== 'active' || g.refreshGeneration !== expectedGen) return false;
    g.accessTokenHash = next.accessTokenHash;
    g.accessTokenExpiresAt = next.accessTokenExpiresAt;
    g.refreshTokenHash = next.refreshTokenHash;
    g.prevRefreshTokenHash = next.prevRefreshTokenHash;
    g.refreshGeneration = next.refreshGeneration;
    return true;
  }
}

// --- device authorization ---

export type DeviceStatus = 'pending' | 'approved' | 'redeemed' | 'denied';

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  clientId: string;
  status: DeviceStatus;
  principalId?: string;
  displayName?: string;
  orgId?: string;
  workspaceId?: string;
  expiresAt: number;
  lastPolledAt: number;
  intervalMs: number;
}

export interface DeviceCodeStore {
  create(d: DeviceCode): Promise<void>;
  getByDeviceCode(deviceCode: string): Promise<DeviceCode | null>;
  getByUserCode(userCode: string): Promise<DeviceCode | null>;
  update(deviceCode: string, patch: Partial<DeviceCode>): Promise<void>;
  /** Atomic transition approved→redeemed (claim-first). Returns false if not
   *  currently in `from`. */
  transition(deviceCode: string, from: DeviceStatus, to: DeviceStatus): Promise<boolean>;
}

export class InMemoryDeviceCodeStore implements DeviceCodeStore {
  private readonly byDevice = new Map<string, DeviceCode>();
  private readonly byUser = new Map<string, string>();

  async create(d: DeviceCode): Promise<void> {
    this.byDevice.set(d.deviceCode, { ...d });
    this.byUser.set(d.userCode, d.deviceCode);
  }
  async getByDeviceCode(deviceCode: string): Promise<DeviceCode | null> {
    const d = this.byDevice.get(deviceCode);
    return d ? { ...d } : null;
  }
  async getByUserCode(userCode: string): Promise<DeviceCode | null> {
    const dc = this.byUser.get(userCode);
    if (!dc) return null;
    const d = this.byDevice.get(dc);
    return d ? { ...d } : null;
  }
  async update(deviceCode: string, patch: Partial<DeviceCode>): Promise<void> {
    const d = this.byDevice.get(deviceCode);
    if (d) Object.assign(d, patch);
  }
  async transition(deviceCode: string, from: DeviceStatus, to: DeviceStatus): Promise<boolean> {
    const d = this.byDevice.get(deviceCode);
    if (!d || d.status !== from) return false;
    d.status = to;
    return true;
  }
}

// --- authorization code (PKCE) ---

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  principalId: string;
  displayName: string;
  orgId: string;
  workspaceId: string;
  expiresAt: number;
}

export interface AuthCodeStore {
  create(c: AuthCode): Promise<void>;
  /** Consume the code once (claim-first): returns it and deletes it atomically. */
  consume(code: string): Promise<AuthCode | null>;
}

export class InMemoryAuthCodeStore implements AuthCodeStore {
  private readonly byCode = new Map<string, AuthCode>();
  async create(c: AuthCode): Promise<void> {
    this.byCode.set(c.code, { ...c });
  }
  async consume(code: string): Promise<AuthCode | null> {
    const c = this.byCode.get(code);
    if (!c) return null;
    this.byCode.delete(code);
    return c;
  }
}

export interface OAuthClient {
  clientId: string;
  name: string;
  orgId: string;
  workspaceId: string;
  grantTypes: readonly string[];
  redirectAllowlist: readonly string[];
  enabled: boolean;
}

export interface OAuthClientStore {
  get(clientId: string): Promise<OAuthClient | null>;
}

export class InMemoryOAuthClientStore implements OAuthClientStore {
  private readonly byId = new Map<string, OAuthClient>();
  add(c: OAuthClient): void {
    this.byId.set(c.clientId, c);
  }
  async get(clientId: string): Promise<OAuthClient | null> {
    return this.byId.get(clientId) ?? null;
  }
}
