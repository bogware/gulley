import type { Principal } from '@gulley/auth';
import { err, ok, type Result } from '@gulley/core';
import { randomBytes } from 'node:crypto';
import type { IdentityProvider } from './idp';
import { pkceVerifyS256, validateLoopbackRedirect } from './pkce';
import type { AuthCodeStore, DeviceCodeStore, Grant, GrantStore, OAuthClientStore } from './stores';
import {
  mintAccessToken,
  mintRefreshToken,
  newHandle,
  parseAccess,
  parseRefresh,
  verifyHash,
} from './tokens';

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_grant'
  | 'invalid_client'
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | 'unsupported_grant_type'
  | 'server_error';

export interface OAuthError {
  error: OAuthErrorCode;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

/** Authorizes the consenting admin against the client's tenancy. Returns false
 *  to deny (deny-by-default). Wired by the control-api consent routes so a viewer
 *  / out-of-tenant admin cannot broker a data-plane token. */
export type ConsentGuard = (tenancy: {
  clientId: string;
  orgId: string;
  workspaceId: string;
}) => Promise<boolean>;

export interface BrokerConfig {
  pepper: string;
  accessTtlMs: number;
  refreshTtlMs: number;
  absoluteTtlMs: number;
  deviceCodeTtlMs: number;
  deviceIntervalMs: number;
  now?: () => number;
  /** Fired when a token family is killed because a SUPERSEDED refresh token was
   *  replayed (genuine reuse → theft signal). Best-effort; never blocks the revoke. */
  onReuse?: (grant: {
    handle: string;
    clientId: string;
    principalId: string;
    orgId: string;
  }) => void;
}

export interface BrokerDeps {
  grants: GrantStore;
  devices: DeviceCodeStore;
  codes: AuthCodeStore;
  clients: OAuthClientStore;
  idp: IdentityProvider;
}

const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ0123456789';

function genUserCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[(bytes[i] ?? 0) % USER_CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const e = (code: OAuthErrorCode): Result<never, OAuthError> => err({ error: code });

export class BrokerService {
  constructor(
    private readonly cfg: BrokerConfig,
    private readonly deps: BrokerDeps,
  ) {}

  private now(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  private async issueGrant(base: {
    clientId: string;
    principalId: string;
    displayName: string;
    orgId: string;
    workspaceId: string;
  }): Promise<TokenResponse> {
    const now = this.now();
    const handle = newHandle();
    const at = mintAccessToken(this.cfg.pepper, handle);
    const rt = mintRefreshToken(this.cfg.pepper, handle, 1);
    const grant: Grant = {
      handle,
      clientId: base.clientId,
      principalId: base.principalId,
      displayName: base.displayName,
      orgId: base.orgId,
      workspaceId: base.workspaceId,
      status: 'active',
      accessTokenHash: at.hash,
      accessTokenExpiresAt: now + this.cfg.accessTtlMs,
      refreshTokenHash: rt.hash,
      prevRefreshTokenHash: null,
      refreshGeneration: 1,
      absoluteExpiresAt: now + this.cfg.absoluteTtlMs,
    };
    await this.deps.grants.create(grant);
    return {
      access_token: at.token,
      token_type: 'Bearer',
      expires_in: Math.floor(this.cfg.accessTtlMs / 1000),
      refresh_token: rt.token,
    };
  }

  // --- device flow ---

  async deviceAuthorization(clientId: string): Promise<
    Result<
      {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      },
      OAuthError
    >
  > {
    const client = await this.deps.clients.get(clientId);
    if (!client || !client.enabled || !client.grantTypes.includes('device_code')) {
      return e('invalid_client');
    }
    const now = this.now();
    const deviceCode = randomBytes(24).toString('base64url');
    await this.deps.devices.create({
      deviceCode,
      userCode: genUserCode(),
      clientId,
      status: 'pending',
      expiresAt: now + this.cfg.deviceCodeTtlMs,
      lastPolledAt: 0,
      intervalMs: this.cfg.deviceIntervalMs,
    });
    const d = await this.deps.devices.getByDeviceCode(deviceCode);
    return ok({
      device_code: deviceCode,
      user_code: d?.userCode ?? '',
      verification_uri: '/oauth/device',
      expires_in: Math.floor(this.cfg.deviceCodeTtlMs / 1000),
      interval: Math.floor(this.cfg.deviceIntervalMs / 1000),
    });
  }

  /** Consent step — identity comes ONLY from the (validated) IdP session, never
   *  a client-supplied field. */
  async deviceApprove(
    userCode: string,
    identity: { subject: string; displayName: string },
    guard?: ConsentGuard,
  ): Promise<Result<void, OAuthError>> {
    const d = await this.deps.devices.getByUserCode(userCode);
    if (!d) return e('invalid_request');
    if (this.now() >= d.expiresAt) return e('expired_token');
    if (d.status !== 'pending') return e('invalid_request');
    // Deny-by-default: the consenting admin must be authorized for the client's
    // tenancy before a data-plane grant can be brokered.
    if (guard) {
      const client = await this.deps.clients.get(d.clientId);
      if (!client) return e('invalid_client');
      if (
        !(await guard({
          clientId: client.clientId,
          orgId: client.orgId,
          workspaceId: client.workspaceId,
        }))
      ) {
        return e('access_denied');
      }
    }
    await this.deps.devices.update(d.deviceCode, {
      status: 'approved',
      principalId: identity.subject,
      displayName: identity.displayName,
    });
    return ok(undefined);
  }

  async tokenDeviceCode(
    deviceCode: string,
    clientId: string,
  ): Promise<Result<TokenResponse, OAuthError>> {
    const d = await this.deps.devices.getByDeviceCode(deviceCode);
    if (!d || d.clientId !== clientId) return e('invalid_grant');
    const now = this.now();
    if (now >= d.expiresAt) return e('expired_token');
    if (now - d.lastPolledAt < d.intervalMs) {
      await this.deps.devices.update(deviceCode, { lastPolledAt: now });
      return e('slow_down');
    }
    await this.deps.devices.update(deviceCode, { lastPolledAt: now });
    if (d.status === 'pending') return e('authorization_pending');
    if (d.status === 'denied') return e('access_denied');
    if (d.status === 'redeemed') return e('invalid_grant');

    // Claim first, then mint, so a double poll cannot issue two grants.
    if (!(await this.deps.devices.transition(deviceCode, 'approved', 'redeemed'))) {
      return e('invalid_grant');
    }
    const client = await this.deps.clients.get(clientId);
    if (!client || !d.principalId) return e('server_error');
    const tok = await this.issueGrant({
      clientId,
      principalId: d.principalId,
      displayName: d.displayName ?? d.principalId,
      orgId: client.orgId,
      workspaceId: client.workspaceId,
    });
    return ok(tok);
  }

  // --- authorization code + PKCE (S256 only) ---

  async authorize(
    params: {
      clientId: string;
      redirectUri: string;
      state: string;
      codeChallenge: string;
      codeChallengeMethod: string;
      identity: { subject: string; displayName: string };
    },
    guard?: ConsentGuard,
  ): Promise<Result<{ code: string; state: string }, OAuthError>> {
    const client = await this.deps.clients.get(params.clientId);
    if (!client || !client.enabled || !client.grantTypes.includes('authorization_code')) {
      return e('invalid_client');
    }
    if (params.codeChallengeMethod !== 'S256') return e('invalid_request'); // reject 'plain'
    if (!validateLoopbackRedirect(params.redirectUri, client.redirectAllowlist)) {
      return e('invalid_request');
    }
    if (
      guard &&
      !(await guard({
        clientId: client.clientId,
        orgId: client.orgId,
        workspaceId: client.workspaceId,
      }))
    ) {
      return e('access_denied');
    }
    const code = randomBytes(24).toString('base64url');
    await this.deps.codes.create({
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      principalId: params.identity.subject,
      displayName: params.identity.displayName,
      orgId: client.orgId,
      workspaceId: client.workspaceId,
      expiresAt: this.now() + 300_000,
    });
    return ok({ code, state: params.state });
  }

  async tokenAuthCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
  }): Promise<Result<TokenResponse, OAuthError>> {
    const c = await this.deps.codes.consume(params.code);
    if (!c || c.clientId !== params.clientId) return e('invalid_grant');
    if (this.now() >= c.expiresAt) return e('invalid_grant');
    if (c.redirectUri !== params.redirectUri) return e('invalid_grant');
    if (!pkceVerifyS256(params.codeVerifier, c.codeChallenge)) return e('invalid_grant');
    const tok = await this.issueGrant({
      clientId: c.clientId,
      principalId: c.principalId,
      displayName: c.displayName,
      orgId: c.orgId,
      workspaceId: c.workspaceId,
    });
    return ok(tok);
  }

  // --- refresh (secret-authoritative reuse detection) ---

  async refresh(
    refreshToken: string,
    clientId: string,
  ): Promise<Result<TokenResponse, OAuthError>> {
    const parsed = parseRefresh(refreshToken);
    if (!parsed) return e('invalid_grant');
    const grant = await this.deps.grants.get(parsed.handle);
    if (!grant || grant.status !== 'active' || grant.clientId !== clientId)
      return e('invalid_grant');
    const now = this.now();
    if (now >= grant.absoluteExpiresAt) {
      await this.deps.grants.revoke(grant.handle);
      return e('invalid_grant');
    }
    if (!(await this.deps.idp.isPrincipalActive(grant.principalId))) {
      await this.deps.grants.revoke(grant.handle); // revoke on deprovision
      return e('invalid_grant');
    }

    const isCurrent =
      parsed.generation === grant.refreshGeneration &&
      verifyHash(this.cfg.pepper, parsed.secret, grant.refreshTokenHash);
    if (isCurrent) {
      const newGen = grant.refreshGeneration + 1;
      const at = mintAccessToken(this.cfg.pepper, grant.handle);
      const rt = mintRefreshToken(this.cfg.pepper, grant.handle, newGen);
      const applied = await this.deps.grants.rotate(grant.handle, grant.refreshGeneration, {
        accessTokenHash: at.hash,
        accessTokenExpiresAt: now + this.cfg.accessTtlMs,
        refreshTokenHash: rt.hash,
        prevRefreshTokenHash: grant.refreshTokenHash ?? '',
        refreshGeneration: newGen,
      });
      if (!applied) return e('invalid_grant'); // lost optimistic race — NO revoke
      return ok({
        access_token: at.token,
        token_type: 'Bearer',
        expires_in: Math.floor(this.cfg.accessTtlMs / 1000),
        refresh_token: rt.token,
      });
    }

    const isSuperseded =
      parsed.generation === grant.refreshGeneration - 1 &&
      grant.prevRefreshTokenHash != null &&
      verifyHash(this.cfg.pepper, parsed.secret, grant.prevRefreshTokenHash);
    if (isSuperseded) {
      await this.deps.grants.revoke(grant.handle); // genuine single-step reuse → kill family
      try {
        this.cfg.onReuse?.({
          handle: grant.handle,
          clientId: grant.clientId,
          principalId: grant.principalId,
          orgId: grant.orgId,
        });
      } catch {
        /* best-effort theft signal; never block the revoke */
      }
      return e('invalid_grant');
    }

    return e('invalid_grant'); // forged / unknown secret — NO state change (no DoS)
  }

  // --- revocation (only on cryptographic proof; always resolves) ---

  async revoke(token: string): Promise<void> {
    const rt = parseRefresh(token);
    if (rt) {
      const g = await this.deps.grants.get(rt.handle);
      if (
        g &&
        g.status === 'active' &&
        (verifyHash(this.cfg.pepper, rt.secret, g.refreshTokenHash) ||
          (g.prevRefreshTokenHash != null &&
            verifyHash(this.cfg.pepper, rt.secret, g.prevRefreshTokenHash)))
      ) {
        await this.deps.grants.revoke(rt.handle);
      }
      return;
    }
    const at = parseAccess(token);
    if (at) {
      const g = await this.deps.grants.get(at.handle);
      if (g && g.status === 'active' && verifyHash(this.cfg.pepper, at.secret, g.accessTokenHash)) {
        await this.deps.grants.revoke(at.handle);
      }
    }
  }

  // --- data-plane resolution ---

  async resolveBrokerToken(token: string): Promise<Result<Principal, { reason: string }>> {
    const at = parseAccess(token);
    if (!at) return err({ reason: 'malformed' });
    const g = await this.deps.grants.get(at.handle);
    if (!g || g.status !== 'active') return err({ reason: 'inactive' });
    if (this.now() >= g.accessTokenExpiresAt) return err({ reason: 'expired' });
    if (!verifyHash(this.cfg.pepper, at.secret, g.accessTokenHash))
      return err({ reason: 'bad-secret' });
    if (!g.orgId || !g.workspaceId) return err({ reason: 'no-tenancy' }); // deny by default
    return ok({
      kind: 'oauth-broker',
      id: g.principalId,
      displayName: g.displayName,
      authMode: 'oauth-broker',
      scope: {
        orgId: g.orgId,
        workspaceId: g.workspaceId,
        allowedProviders: '*',
        allowedModels: '*',
      },
    });
  }
}
