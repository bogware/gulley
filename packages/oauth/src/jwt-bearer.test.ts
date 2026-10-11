import { ok, err } from '@gulley/core';
import { describe, expect, it } from 'vitest';
import type { FederatedIdentity, FederationVerifierPort } from './federation';
import { SimulatedIdp } from './idp';
import {
  BrokerService,
  type BrokerConfig,
  JWT_BEARER_GRANT_TYPE,
  resolveBrokerAccessToken,
  WORKLOAD_CLIENT_ID,
} from './service';
import {
  InMemoryAuthCodeStore,
  InMemoryDeviceCodeStore,
  InMemoryGrantStore,
  InMemoryOAuthClientStore,
} from './stores';
import { parseAccess } from './tokens';

/**
 * RFC 7523 JWT-bearer at the broker, over a FAKE verifier: the grant is access-only
 * and scoped, the resolver surfaces the service identity, refresh is impossible, and
 * the optional client binding is enforced.
 */
const IDENTITY: FederatedIdentity = {
  federation: 'gh-main',
  subject: 'repo:acme/api:ref:refs/heads/main',
  principalId: 'svc:gh-main:repo:acme/api:ref:refs/heads/main',
  displayName: 'gh-main: repo:acme/api:ref:refs/heads/main',
  orgId: 'org_1',
  workspaceId: 'ws_ci',
  scope: { allowedProviders: ['anthropic'], allowedModels: ['claude-sonnet-4-6'], groups: ['ci'] },
  ttlSeconds: 900,
  onBehalfOf: true,
  claims: { iss: 'https://token.actions.githubusercontent.com' },
};

function fakeVerifier(answer: (assertion: string) => FederatedIdentity | string) {
  const calls: Array<{ assertion: string; defaultAudience?: string }> = [];
  const port: FederationVerifierPort = {
    verify: async (assertion, opts) => {
      calls.push({ assertion, defaultAudience: opts?.defaultAudience });
      const a = answer(assertion);
      return typeof a === 'string' ? err({ reason: a as 'malformed' }) : ok(a);
    },
  };
  return { port, calls };
}

function makeBroker(federation?: FederationVerifierPort, clock = { t: 1_700_000_000_000 }) {
  const clients = new InMemoryOAuthClientStore();
  clients.add({
    clientId: 'ci-runner',
    name: 'CI runner',
    orgId: 'org_1',
    workspaceId: 'ws_ci',
    grantTypes: [JWT_BEARER_GRANT_TYPE],
    redirectAllowlist: [],
    enabled: true,
  });
  clients.add({
    clientId: 'claude-code',
    name: 'Claude Code',
    orgId: 'org_1',
    workspaceId: 'ws_dev',
    grantTypes: ['device_code', 'refresh_token'],
    redirectAllowlist: [],
    enabled: true,
  });
  const cfg: BrokerConfig = {
    pepper: 'jwt-bearer-test-pepper',
    accessTtlMs: 3_600_000,
    refreshTtlMs: 30 * 86_400_000,
    absoluteTtlMs: 90 * 86_400_000,
    deviceCodeTtlMs: 900_000,
    deviceIntervalMs: 0,
    now: () => clock.t,
  };
  const grants = new InMemoryGrantStore();
  const broker = new BrokerService(cfg, {
    grants,
    devices: new InMemoryDeviceCodeStore(),
    codes: new InMemoryAuthCodeStore(),
    clients,
    idp: new SimulatedIdp(),
    federation,
  });
  return { broker, grants, clock, cfg };
}

describe('tokenJwtBearer', () => {
  it('mints an ACCESS-ONLY grant under the built-in workload client with the federation scope stored', async () => {
    const { port, calls } = fakeVerifier(() => IDENTITY);
    const { broker, grants, clock, cfg } = makeBroker(port);
    const r = await broker.tokenJwtBearer({
      assertion: 'eyJ.assertion.sig',
      defaultAudience: 'https://api.gulley.test',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toEqual([
      { assertion: 'eyJ.assertion.sig', defaultAudience: 'https://api.gulley.test' },
    ]);
    expect(r.value.token.access_token).toMatch(/^gko_at_/);
    expect(r.value.token.expires_in).toBe(900);
    expect(r.value.token).not.toHaveProperty('refresh_token');
    expect(r.value.identity).toMatchObject({
      principalId: IDENTITY.principalId,
      federation: 'gh-main',
      subject: IDENTITY.subject,
      orgId: 'org_1',
      workspaceId: 'ws_ci',
      expiresAt: clock.t + 900_000,
    });
    const handle = parseAccess(r.value.token.access_token)!.handle;
    const g = await grants.get(handle);
    expect(g).toMatchObject({
      kind: 'service',
      clientId: WORKLOAD_CLIENT_ID,
      federation: 'gh-main',
      subject: IDENTITY.subject,
      scope: IDENTITY.scope,
      onBehalfOf: true,
      refreshTokenHash: null,
      refreshGeneration: 0,
      accessTokenExpiresAt: clock.t + 900_000,
      absoluteExpiresAt: clock.t + 900_000,
    });

    // The data-plane resolver surfaces the stored scope + the service identity.
    const p = await resolveBrokerAccessToken(r.value.token.access_token, {
      grants,
      pepper: cfg.pepper,
      now: () => clock.t,
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value).toMatchObject({
      kind: 'oauth-broker',
      id: IDENTITY.principalId,
      serviceAccount: 'gh-main',
      onBehalfOf: true,
      scope: {
        orgId: 'org_1',
        workspaceId: 'ws_ci',
        allowedProviders: ['anthropic'],
        allowedModels: ['claude-sonnet-4-6'],
        groups: ['ci'],
      },
    });
    expect(p.value.userId).toBeUndefined();
    expect(await broker.resolveBrokerToken(r.value.token.access_token)).toMatchObject({ ok: true });

    // Introspection reports the service identity.
    expect(await broker.introspectAccessToken(r.value.token.access_token)).toMatchObject({
      kind: 'service',
      federation: 'gh-main',
      subject: IDENTITY.subject,
      scope: IDENTITY.scope,
      onBehalfOf: true,
      clientId: WORKLOAD_CLIENT_ID,
    });

    // It expires exactly at the federation TTL, never the broker's user access TTL.
    clock.t += 900_001;
    expect(
      (
        await resolveBrokerAccessToken(r.value.token.access_token, {
          grants,
          pepper: cfg.pepper,
          now: () => clock.t,
        })
      ).ok,
    ).toBe(false);
  });

  it('a service token can never be refreshed (no refresh secret, no IdP call)', async () => {
    const { port } = fakeVerifier(() => IDENTITY);
    const { broker, grants } = makeBroker(port);
    const r = await broker.tokenJwtBearer({ assertion: 'a.b.c' });
    if (!r.ok) throw new Error('exchange failed');
    const handle = parseAccess(r.value.token.access_token)!.handle;
    const forged = `gko_rt_${handle}.0.${'q'.repeat(43)}`;
    const refresh = await broker.refresh(forged, WORKLOAD_CLIENT_ID);
    expect(refresh.ok).toBe(false);
    if (!refresh.ok) expect(refresh.error.error).toBe('invalid_grant');
    expect((await grants.get(handle))?.status).toBe('active'); // no DoS: untouched
    // Revocation by access token still works, and so does revoke-by-principal.
    await broker.revoke(r.value.token.access_token);
    expect((await grants.get(handle))?.status).toBe('revoked');
    const again = await broker.tokenJwtBearer({ assertion: 'a.b.c' });
    if (!again.ok) throw new Error('exchange failed');
    expect(await broker.revokePrincipal(IDENTITY.principalId)).toBe(1);
    expect((await broker.resolveBrokerToken(again.value.token.access_token)).ok).toBe(false);
  });

  it('every verification failure is a generic invalid_grant carrying the reason for the log', async () => {
    const { port } = fakeVerifier((a) => (a === 'good' ? IDENTITY : 'replayed'));
    const { broker } = makeBroker(port);
    const r = await broker.tokenJwtBearer({ assertion: 'bad' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ error: 'invalid_grant', reason: 'replayed' });
    const empty = await broker.tokenJwtBearer({ assertion: '' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.error).toBe('invalid_request');
  });

  it('is unsupported_grant_type when no federation verifier is wired', async () => {
    const { broker } = makeBroker(undefined);
    const r = await broker.tokenJwtBearer({ assertion: 'a.b.c' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error).toBe('unsupported_grant_type');
  });

  it('an optional client_id must be registered, jwt-bearer-capable and in the federation tenancy', async () => {
    const { port } = fakeVerifier(() => IDENTITY);
    const { broker, grants } = makeBroker(port);
    const bound = await broker.tokenJwtBearer({ assertion: 'a.b.c', clientId: 'ci-runner' });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      const g = await grants.get(parseAccess(bound.value.token.access_token)!.handle);
      expect(g?.clientId).toBe('ci-runner');
    }
    const unknown = await broker.tokenJwtBearer({ assertion: 'a.b.c', clientId: 'nope' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.error).toBe('invalid_client');
    // A device-flow client lacks the grant type.
    const wrongGrant = await broker.tokenJwtBearer({ assertion: 'a.b.c', clientId: 'claude-code' });
    expect(wrongGrant.ok).toBe(false);
    if (!wrongGrant.ok) expect(wrongGrant.error.error).toBe('invalid_client');
    // A client in another tenancy cannot mint for the federation's.
    const other = makeBroker(fakeVerifier(() => ({ ...IDENTITY, workspaceId: 'ws_other' })).port);
    const mismatch = await other.broker.tokenJwtBearer({
      assertion: 'a.b.c',
      clientId: 'ci-runner',
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok)
      expect(mismatch.error).toEqual({ error: 'invalid_client', reason: 'tenancy-mismatch' });
  });
});

describe('user grants keep their shape', () => {
  it('a device-flow grant is kind user, resolves with userId and the legacy wildcard scope', async () => {
    const { broker, grants, cfg, clock } = makeBroker();
    const da = await broker.deviceAuthorization('claude-code');
    if (!da.ok) throw new Error('device auth');
    await broker.deviceApprove(da.value.user_code, { subject: 'user-1', displayName: 'User One' });
    const tok = await broker.tokenDeviceCode(da.value.device_code, 'claude-code');
    if (!tok.ok) throw new Error('token');
    expect(tok.value.refresh_token).toMatch(/^gko_rt_/);
    const g = await grants.get(parseAccess(tok.value.access_token)!.handle);
    expect(g?.kind).toBe('user');
    expect(g?.scope).toBeUndefined();
    const p = await resolveBrokerAccessToken(tok.value.access_token, {
      grants,
      pepper: cfg.pepper,
      now: () => clock.t,
    });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.userId).toBe('user-1');
      expect(p.value.serviceAccount).toBeUndefined();
      expect(p.value.onBehalfOf).toBeUndefined();
      expect(p.value.scope.allowedProviders).toBe('*');
    }
    expect(await broker.introspectAccessToken(tok.value.access_token)).toMatchObject({
      kind: 'user',
      scope: { allowedProviders: '*', allowedModels: '*' },
      onBehalfOf: false,
    });
  });
});
