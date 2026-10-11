export type GrantStatus = 'active' | 'revoked';

/** Who a grant was issued to: a human who consented (device / auth-code flow) or a
 *  workload admitted by a federation (RFC 7523 JWT-bearer exchange). */
export type GrantKind = 'user' | 'service';

/** The data-plane scope stored on a grant. User grants (legacy rows) carry none and
 *  resolve to the client tenancy with `'*'` providers/models; service grants carry
 *  the federation's scope verbatim. */
export interface GrantScope {
  allowedProviders: readonly string[] | '*';
  allowedModels: readonly string[] | '*';
  groups?: readonly string[];
}

/** One row per token family. Rotation advances `refreshGeneration` and moves the
 *  current refresh hash into `prevRefreshTokenHash` so a single-step reuse of the
 *  superseded token can be distinguished (→ revoke) from a forged/unknown one.
 *  A `service` grant is ACCESS-ONLY: `refreshTokenHash` is null, `absoluteExpiresAt`
 *  equals the access expiry, and a refresh attempt is always `invalid_grant`. */
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
  kind: GrantKind;
  /** Service grants: the workload federation (trust configuration) that admitted it. */
  federation?: string;
  /** Service grants: the verified assertion `sub` (the workload's identity). */
  subject?: string;
  /** Stored scope; absent on user grants (resolved as `'*'`). */
  scope?: GrantScope;
  /** Service grants: may this principal assert an end user via `x-user-id`? */
  onBehalfOf?: boolean;
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
  /** Mark a family revoked. Returns false when no such grant exists (so an admin
   *  revoke of a bogus handle is a 404, not an audited no-op). */
  revoke(handle: string): Promise<boolean>;
  setAccess(handle: string, hash: string, expiresAt: number): Promise<void>;
  /** Atomic compare-and-rotate: applies `next` only if the current generation is
   *  still `expectedGen` (optimistic concurrency). Returns false on a lost race. */
  rotate(handle: string, expectedGen: number, next: RotateFields): Promise<boolean>;
  /** Revoke every ACTIVE family issued to `principalId` (an IdP/SCIM deprovision
   *  must kill the user's brokered tokens, not only their admin sessions). Returns
   *  the number of families revoked. */
  revokeByPrincipal(principalId: string): Promise<number>;
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
  async revoke(handle: string): Promise<boolean> {
    const g = this.byHandle.get(handle);
    if (!g) return false;
    g.status = 'revoked';
    return true;
  }
  async revokeByPrincipal(principalId: string): Promise<number> {
    let n = 0;
    for (const g of this.byHandle.values()) {
      if (g.principalId === principalId && g.status === 'active') {
        g.status = 'revoked';
        n++;
      }
    }
    return n;
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
