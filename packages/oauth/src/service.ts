import type { Principal } from '@gulley/auth';
import { err, ok, type Result } from '@gulley/core';
import { randomBytes } from 'node:crypto';
import type { FederationVerifierPort } from './federation';
import type { IdentityProvider } from './idp';
import { pkceVerifyS256, validateLoopbackRedirect } from './pkce';
import type {
  AuthCodeStore,
  DeviceCodeStore,
  Grant,
  GrantScope,
  GrantStore,
  OAuthClientStore,
} from './stores';
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

/** Consent-page preview of a pending device authorization (never the device_code). */
export interface DevicePreview {
  clientId: string;
  clientName: string;
  orgId: string;
  workspaceId: string;
  expiresAt: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  /** Absent on an ACCESS-ONLY grant (the RFC 7523 JWT-bearer exchange): a workload
   *  re-presents a fresh assertion instead of refreshing. */
  refresh_token?: string;
}

/** The RFC 7523 grant type URN (`grant_type` of a JWT-bearer token exchange). */
export const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** A successful JWT-bearer exchange: the wire response plus the identity it was
 *  bound to (for the caller's audit row — never echoed to the workload). */
export interface JwtBearerIssued {
  token: TokenResponse;
  identity: {
    handle: string;
    principalId: string;
    federation: string;
    subject: string;
    orgId: string;
    workspaceId: string;
    expiresAt: number;
  };
}

/** The built-in pseudo-client a JWT-bearer exchange is recorded under when the
 *  caller sends no `client_id`. It is not in the client registry and can do nothing
 *  else (no device/auth-code/refresh capability); the FEDERATION, not the client,
 *  decides tenancy + scope. A registered client may be named instead, in which case
 *  it must be enabled, carry the jwt-bearer grant type, and share the federation's
 *  tenancy. */
export const WORKLOAD_CLIENT_ID = 'workload';

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
  /** Workload identity federation verifier (RFC 7523 JWT-bearer). Absent ⇒ the
   *  jwt-bearer grant type is `unsupported_grant_type`. */
  federation?: FederationVerifierPort;
}

const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ0123456789';

function genUserCode(): string {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[(bytes[i] ?? 0) % USER_CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const e = (code: OAuthErrorCode): Result<never, OAuthError> => err({ error: code });

/** User codes are shown as `XXXX-XXXX` but people type them lowercase, without the
 *  dash, or with stray whitespace; canonicalize before lookup (the alphabet is
 *  upper-case + digits, so this is lossless). */
export function normalizeUserCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : input.trim().toUpperCase();
}

export class BrokerService {
  constructor(
    private readonly cfg: BrokerConfig,
    private readonly deps: BrokerDeps,
  ) {}

  private now(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  /** True when a workload federation verifier is wired (the jwt-bearer grant type
   *  is served and advertised). */
  get supportsJwtBearer(): boolean {
    return this.deps.federation !== undefined;
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
      kind: 'user',
    };
    await this.deps.grants.create(grant);
    return {
      access_token: at.token,
      token_type: 'Bearer',
      expires_in: Math.floor(this.cfg.accessTtlMs / 1000),
      refresh_token: rt.token,
    };
  }

  // --- RFC 7523 JWT-bearer: workload identity → scoped, access-only token ---

  /**
   * Exchange a verified workload assertion (Kubernetes service-account token, GitHub
   * Actions OIDC token, …) for an ACCESS-ONLY grant bound to the service principal
   * the matching federation maps it to. No refresh token is minted: the family's
   * absolute expiry IS the access expiry, and a refresh attempt with any token of
   * this family is `invalid_grant`. Every verification failure is a single generic
   * `invalid_grant` (the reason is logged by the caller, never echoed).
   *
   * `clientId` is optional: absent, the grant is recorded under the built-in
   * {@link WORKLOAD_CLIENT_ID}; present, the client must exist, be enabled, carry the
   * jwt-bearer grant type and share the federation's tenancy (`invalid_client`).
   */
  async tokenJwtBearer(params: {
    assertion: string;
    clientId?: string;
    /** The broker's public origin — the `aud` a federation expects unless it
     *  configures its own. */
    defaultAudience?: string;
  }): Promise<Result<JwtBearerIssued, OAuthError & { reason?: string }>> {
    const verifier = this.deps.federation;
    if (!verifier) return e('unsupported_grant_type');
    if (!params.assertion) return e('invalid_request');

    // Resolve the client record the grant is issued under. The built-in pseudo-client
    // is never registered: it resolves to a synthetic, tenancy-less record. Any other
    // id must be a registered, enabled, jwt-bearer-capable client — checked BEFORE the
    // assertion is verified so an invalid client never consumes the assertion's `jti`.
    const client = await this.resolveJwtBearerClient(params.clientId);
    if (!client) return e('invalid_client');
    const v = await verifier.verify(params.assertion, { defaultAudience: params.defaultAudience });
    if (!v.ok) return err({ error: 'invalid_grant', reason: v.error.reason });
    // A registered client scopes to ONE tenancy; it cannot mint for another.
    if (
      client.orgId !== null &&
      (v.value.orgId !== client.orgId || v.value.workspaceId !== client.workspaceId)
    ) {
      return err({ error: 'invalid_client', reason: 'tenancy-mismatch' });
    }
    return this.issueServiceGrant(client.clientId, v.value);
  }

  /** The client a jwt-bearer grant is recorded under: the requested registered client
   *  when it exists, is enabled and carries the grant type; the built-in pseudo-client
   *  (no tenancy of its own — the federation decides) when none was named; null when
   *  the named client cannot be used. */
  private async resolveJwtBearerClient(
    requested: string | undefined,
  ): Promise<{ clientId: string; orgId: string | null; workspaceId: string | null } | null> {
    const id = requested && requested.length > 0 ? requested : WORKLOAD_CLIENT_ID;
    const registered = await this.deps.clients.get(id);
    if (registered) {
      if (!registered.enabled || !registered.grantTypes.includes(JWT_BEARER_GRANT_TYPE)) {
        return null;
      }
      return {
        clientId: registered.clientId,
        orgId: registered.orgId,
        workspaceId: registered.workspaceId,
      };
    }
    return id === WORKLOAD_CLIENT_ID
      ? { clientId: WORKLOAD_CLIENT_ID, orgId: null, workspaceId: null }
      : null;
  }

  private async issueServiceGrant(
    clientId: string,
    id: {
      principalId: string;
      displayName: string;
      federation: string;
      subject: string;
      orgId: string;
      workspaceId: string;
      scope: GrantScope;
      ttlSeconds: number;
      onBehalfOf: boolean;
    },
  ): Promise<Result<JwtBearerIssued, OAuthError>> {
    const now = this.now();
    const handle = newHandle();
    const at = mintAccessToken(this.cfg.pepper, handle);
    const expiresAt = now + id.ttlSeconds * 1000;
    const grant: Grant = {
      handle,
      clientId,
      principalId: id.principalId,
      displayName: id.displayName,
      orgId: id.orgId,
      workspaceId: id.workspaceId,
      status: 'active',
      accessTokenHash: at.hash,
      accessTokenExpiresAt: expiresAt,
      refreshTokenHash: null, // access-only: nothing to rotate
      prevRefreshTokenHash: null,
      refreshGeneration: 0,
      absoluteExpiresAt: expiresAt,
      kind: 'service',
      federation: id.federation,
      subject: id.subject,
      scope: id.scope,
      onBehalfOf: id.onBehalfOf,
    };
    await this.deps.grants.create(grant);
    return ok({
      token: { access_token: at.token, token_type: 'Bearer', expires_in: id.ttlSeconds },
      identity: {
        handle,
        principalId: id.principalId,
        federation: id.federation,
        subject: id.subject,
        orgId: id.orgId,
        workspaceId: id.workspaceId,
        expiresAt,
      },
    });
  }

  /** Revoke every active family of a principal (SCIM / IdP deprovision). */
  async revokePrincipal(principalId: string): Promise<number> {
    return this.deps.grants.revokeByPrincipal(principalId);
  }

  // --- device flow ---

  /**
   * RFC 8628 §3.2 device authorization response. `verificationUri` MUST be an absolute
   * URL the end user can open (the console's consent page); the caller (control-api)
   * derives it from CONSOLE_PUBLIC_URL / its own public origin. The
   * `verification_uri_complete` variant carries the user code so a harness can offer a
   * one-click / QR path (the user still confirms the code on the page).
   */
  async deviceAuthorization(
    clientId: string,
    opts: { verificationUri?: string } = {},
  ): Promise<
    Result<
      {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
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
    const userCode = genUserCode();
    await this.deps.devices.create({
      deviceCode,
      userCode,
      clientId,
      status: 'pending',
      expiresAt: now + this.cfg.deviceCodeTtlMs,
      lastPolledAt: 0,
      intervalMs: this.cfg.deviceIntervalMs,
    });
    const verificationUri = opts.verificationUri ?? '/oauth/device';
    const sep = verificationUri.includes('?') ? '&' : '?';
    return ok({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}${sep}user_code=${encodeURIComponent(userCode)}`,
      expires_in: Math.floor(this.cfg.deviceCodeTtlMs / 1000),
      interval: Math.floor(this.cfg.deviceIntervalMs / 1000),
    });
  }

  /** Look up a pending device authorization by its user code (consent-page preview:
   *  which client is asking, for which tenancy). Never returns the device_code. */
  async devicePreview(userCode: string): Promise<Result<DevicePreview, OAuthError>> {
    const d = await this.deps.devices.getByUserCode(normalizeUserCode(userCode));
    if (!d) return e('invalid_request');
    if (this.now() >= d.expiresAt) return e('expired_token');
    if (d.status !== 'pending') return e('invalid_request');
    const client = await this.deps.clients.get(d.clientId);
    if (!client) return e('invalid_client');
    return ok({
      clientId: client.clientId,
      clientName: client.name,
      orgId: client.orgId,
      workspaceId: client.workspaceId,
      expiresAt: d.expiresAt,
    });
  }

  /** The end user declines at the consent page: the polling client gets
   *  `access_denied` on its next poll. Identity is the (validated) session, as for
   *  approve; the same tenancy guard applies so an out-of-tenant admin cannot deny
   *  someone else's authorization either. */
  async deviceDeny(userCode: string, guard?: ConsentGuard): Promise<Result<void, OAuthError>> {
    const d = await this.deps.devices.getByUserCode(normalizeUserCode(userCode));
    if (!d) return e('invalid_request');
    if (this.now() >= d.expiresAt) return e('expired_token');
    if (d.status !== 'pending') return e('invalid_request');
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
    if (!(await this.deps.devices.transition(d.deviceCode, 'pending', 'denied'))) {
      return e('invalid_request');
    }
    return ok(undefined);
  }

  /** Consent step — identity comes ONLY from the (validated) IdP session, never
   *  a client-supplied field. */
  async deviceApprove(
    userCode: string,
    identity: { subject: string; displayName: string },
    guard?: ConsentGuard,
  ): Promise<Result<void, OAuthError>> {
    const d = await this.deps.devices.getByUserCode(normalizeUserCode(userCode));
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
    // A service (JWT-bearer) grant is access-only: there is no refresh secret to
    // verify, so no IdP call and no state change — the workload re-presents a fresh
    // assertion instead.
    if (grant.kind === 'service' || grant.refreshTokenHash === null) return e('invalid_grant');
    const now = this.now();
    if (now >= grant.absoluteExpiresAt) {
      await this.deps.grants.revoke(grant.handle);
      return e('invalid_grant');
    }

    // Verify the presented secret BEFORE consulting the IdP: a caller who only knows a
    // handle (it is not secret — it appears in admin listings and logs) must not be able
    // to drive a Graph call per request (an amplification + directory-probe oracle).
    const isCurrent =
      parsed.generation === grant.refreshGeneration &&
      verifyHash(this.cfg.pepper, parsed.secret, grant.refreshTokenHash);
    if (isCurrent) {
      if (!(await this.deps.idp.isPrincipalActive(grant.principalId))) {
        await this.deps.grants.revoke(grant.handle); // revoke on deprovision
        return e('invalid_grant');
      }
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

  // --- introspection (RFC 7662, access tokens only) ---

  /** Active ⇒ the grant's identity/expiry (+ kind / federation / subject / scope for
   *  a service grant); null for any inactive/unknown/forged token. Read-only,
   *  constant-time secret verify, no state change. */
  async introspectAccessToken(token: string): Promise<{
    clientId: string;
    principalId: string;
    accessTokenExpiresAt: number;
    kind: Grant['kind'];
    federation?: string;
    subject?: string;
    scope: GrantScope;
    onBehalfOf: boolean;
  } | null> {
    const at = parseAccess(token);
    if (!at) return null;
    const g = await this.deps.grants.get(at.handle);
    if (!g || g.status !== 'active') return null;
    if (this.now() >= g.accessTokenExpiresAt) return null;
    if (!verifyHash(this.cfg.pepper, at.secret, g.accessTokenHash)) return null;
    return {
      clientId: g.clientId,
      principalId: g.principalId,
      accessTokenExpiresAt: g.accessTokenExpiresAt,
      kind: g.kind ?? 'user',
      federation: g.federation,
      subject: g.subject,
      scope: grantScope(g),
      onBehalfOf: g.onBehalfOf === true,
    };
  }

  // --- data-plane resolution ---

  async resolveBrokerToken(token: string): Promise<Result<Principal, { reason: string }>> {
    return resolveBrokerAccessToken(token, {
      grants: this.deps.grants,
      pepper: this.cfg.pepper,
      now: () => this.now(),
    });
  }
}

/** Dependencies the stateless data-plane resolver needs — a read-only grant lookup and
 *  the same token pepper the broker minted with. */
export interface BrokerResolveDeps {
  grants: Pick<GrantStore, 'get'>;
  pepper: string;
  now?: () => number;
}

/**
 * Verify a brokered access token (`gko_at_<handle>.<secret>`) and resolve it to a
 * data-plane {@link Principal}. Read-only (a lookup + secret verify + expiry/active
 * check — no refresh, no rotation, no state change) and FAIL-CLOSED on every miss, so
 * it is safe to call from the stateless gateway hot path with only a grant-store read
 * adapter + the shared pepper. Shared with {@link BrokerService.resolveBrokerToken}.
 */
export async function resolveBrokerAccessToken(
  token: string,
  deps: BrokerResolveDeps,
): Promise<Result<Principal, { reason: string }>> {
  const now = deps.now ?? Date.now;
  const at = parseAccess(token);
  if (!at) return err({ reason: 'malformed' });
  const g = await deps.grants.get(at.handle);
  if (!g || g.status !== 'active') return err({ reason: 'inactive' });
  if (now() >= g.accessTokenExpiresAt) return err({ reason: 'expired' });
  if (!verifyHash(deps.pepper, at.secret, g.accessTokenHash)) return err({ reason: 'bad-secret' });
  if (!g.orgId || !g.workspaceId) return err({ reason: 'no-tenancy' }); // deny by default
  const scope = grantScope(g);
  const service = g.kind === 'service';
  return ok({
    kind: 'oauth-broker',
    id: g.principalId,
    displayName: g.displayName,
    authMode: 'oauth-broker',
    scope: {
      orgId: g.orgId,
      workspaceId: g.workspaceId,
      allowedProviders: scope.allowedProviders,
      allowedModels: scope.allowedModels,
      ...(scope.groups ? { groups: scope.groups } : {}),
    },
    // A user grant IS its consenting user; a service grant is a workload and may
    // only assert a user per request when its federation says so.
    ...(service
      ? {
          serviceAccount: g.federation ?? 'unknown',
          onBehalfOf: g.onBehalfOf === true,
        }
      : { userId: g.principalId }),
  });
}

/** The data-plane scope stored on a grant; legacy user grants (no stored scope)
 *  resolve to everything the client tenancy allows. */
export function grantScope(g: Pick<Grant, 'scope'>): GrantScope {
  return g.scope ?? { allowedProviders: '*', allowedModels: '*' };
}
