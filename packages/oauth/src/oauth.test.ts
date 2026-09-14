import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyEs256 } from './jws';
import { pkceChallengeS256, pkceVerifyS256, validateLoopbackRedirect } from './pkce';
import { BrokerService, type BrokerConfig } from './service';
import {
  InMemoryAuthCodeStore,
  InMemoryDeviceCodeStore,
  InMemoryGrantStore,
  InMemoryOAuthClientStore,
} from './stores';
import { SimulatedIdp } from './idp';
import { parseRefresh } from './tokens';

function makeBroker(clock = { t: 1_700_000_000_000 }): {
  broker: BrokerService;
  idp: SimulatedIdp;
} {
  const idp = new SimulatedIdp();
  const clients = new InMemoryOAuthClientStore();
  clients.add({
    clientId: 'claude-code',
    name: 'Claude Code',
    orgId: 'org_live',
    workspaceId: 'ws_live',
    grantTypes: ['device_code', 'authorization_code', 'refresh_token'],
    redirectAllowlist: ['/callback'],
    enabled: true,
  });
  const cfg: BrokerConfig = {
    pepper: 'oauth-test-pepper',
    accessTtlMs: 3_600_000,
    refreshTtlMs: 30 * 86_400_000,
    absoluteTtlMs: 90 * 86_400_000,
    deviceCodeTtlMs: 900_000,
    deviceIntervalMs: 5_000,
    now: () => clock.t,
  };
  return {
    broker: new BrokerService(cfg, {
      grants: new InMemoryGrantStore(),
      devices: new InMemoryDeviceCodeStore(),
      codes: new InMemoryAuthCodeStore(),
      clients,
      idp,
    }),
    idp,
  };
}

async function issueViaDevice(broker: BrokerService): Promise<{ access: string; refresh: string }> {
  const da = await broker.deviceAuthorization('claude-code');
  if (!da.ok) throw new Error('device auth failed');
  await broker.deviceApprove(da.value.user_code, { subject: 'user-1', displayName: 'User One' });
  const tok = await broker.tokenDeviceCode(da.value.device_code, 'claude-code');
  if (!tok.ok) throw new Error(`token failed: ${JSON.stringify(tok)}`);
  return { access: tok.value.access_token, refresh: tok.value.refresh_token };
}

describe('device flow + tenancy', () => {
  it('issues a token whose scope comes from the client tenancy', async () => {
    const { broker } = makeBroker();
    const { access } = await issueViaDevice(broker);
    const p = await broker.resolveBrokerToken(access);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.scope.orgId).toBe('org_live');
      expect(p.value.scope.workspaceId).toBe('ws_live');
    }
  });

  it('poll before approval is authorization_pending', async () => {
    const { broker } = makeBroker();
    const da = await broker.deviceAuthorization('claude-code');
    if (!da.ok) throw new Error('device auth');
    const r = await broker.tokenDeviceCode(da.value.device_code, 'claude-code');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error).toBe('authorization_pending');
  });

  it('returns an absolute verification_uri (+ _complete) and accepts a sloppily typed code', async () => {
    const { broker } = makeBroker();
    const da = await broker.deviceAuthorization('claude-code', {
      verificationUri: 'https://console.acme.internal/oauth/device',
    });
    if (!da.ok) throw new Error('device auth');
    expect(da.value.verification_uri).toBe('https://console.acme.internal/oauth/device');
    expect(da.value.verification_uri_complete).toBe(
      `https://console.acme.internal/oauth/device?user_code=${encodeURIComponent(da.value.user_code)}`,
    );
    expect(da.value.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // The consent page can preview which client/tenancy is asking, and the user may
    // type the code lowercase without the dash.
    const sloppy = ` ${da.value.user_code.toLowerCase().replace('-', '')} `;
    const preview = await broker.devicePreview(sloppy);
    expect(preview.ok).toBe(true);
    if (preview.ok)
      expect(preview.value).toMatchObject({ clientId: 'claude-code', orgId: 'org_live' });
    const ok = await broker.deviceApprove(sloppy, { subject: 'u', displayName: 'U' });
    expect(ok.ok).toBe(true);
    const tok = await broker.tokenDeviceCode(da.value.device_code, 'claude-code');
    expect(tok.ok).toBe(true);
  });

  it('a user denial at the consent page surfaces as access_denied to the poller', async () => {
    const { broker } = makeBroker();
    const da = await broker.deviceAuthorization('claude-code');
    if (!da.ok) throw new Error('device auth');
    // The tenancy guard applies to deny as well (an out-of-tenant admin cannot deny).
    const guarded = await broker.deviceDeny(da.value.user_code, async () => false);
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.error.error).toBe('access_denied');
    const denied = await broker.deviceDeny(da.value.user_code, async () => true);
    expect(denied.ok).toBe(true);
    const poll = await broker.tokenDeviceCode(da.value.device_code, 'claude-code');
    expect(poll.ok).toBe(false);
    if (!poll.ok) expect(poll.error.error).toBe('access_denied');
    // A denied code cannot be approved afterwards, nor previewed.
    const late = await broker.deviceApprove(da.value.user_code, { subject: 'u', displayName: 'U' });
    expect(late.ok).toBe(false);
    expect((await broker.devicePreview(da.value.user_code)).ok).toBe(false);
  });

  it('consent is denied when the authorization guard rejects the tenancy', async () => {
    const { broker } = makeBroker();
    const da = await broker.deviceAuthorization('claude-code');
    if (!da.ok) throw new Error('device auth');
    const denied = await broker.deviceApprove(
      da.value.user_code,
      { subject: 'u', displayName: 'U' },
      async () => false,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.error).toBe('access_denied');
    const allowed = await broker.deviceApprove(
      da.value.user_code,
      { subject: 'u', displayName: 'U' },
      async () => true,
    );
    expect(allowed.ok).toBe(true);
  });
});

describe('refresh rotation + reuse detection', () => {
  it('rotates, and reusing the superseded token revokes the family', async () => {
    const { broker } = makeBroker();
    const { access, refresh: rt1 } = await issueViaDevice(broker);
    const rot = await broker.refresh(rt1, 'claude-code');
    expect(rot.ok).toBe(true);

    const reuse = await broker.refresh(rt1, 'claude-code'); // superseded → reuse
    expect(reuse.ok).toBe(false);
    // family revoked: the still-valid access token no longer resolves
    expect((await broker.resolveBrokerToken(access)).ok).toBe(false);
    if (rot.ok)
      expect((await broker.refresh(rot.value.refresh_token, 'claude-code')).ok).toBe(false);
  });

  it('a forged reuse token does NOT revoke the active family (no DoS)', async () => {
    const { broker } = makeBroker();
    const { access, refresh: rt1 } = await issueViaDevice(broker);
    const handle = parseRefresh(rt1)?.handle ?? '';
    const forged = `gko_rt_${handle}.1.${'z'.repeat(43)}`;
    const r = await broker.refresh(forged, 'claude-code');
    expect(r.ok).toBe(false);
    expect((await broker.resolveBrokerToken(access)).ok).toBe(true); // family still active
  });

  it('a lost optimistic race yields invalid_grant without revoking', async () => {
    const { broker } = makeBroker();
    const { refresh: rt1 } = await issueViaDevice(broker);
    const [a, b] = await Promise.all([
      broker.refresh(rt1, 'claude-code'),
      broker.refresh(rt1, 'claude-code'),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1); // exactly one winner
    const winner = a.ok ? a : b.ok ? b : null;
    expect(winner).not.toBeNull();
    if (winner?.ok)
      expect((await broker.resolveBrokerToken(winner.value.access_token)).ok).toBe(true);
  });

  it('revoke needs cryptographic proof; a bogus token is a no-op', async () => {
    const { broker } = makeBroker();
    const { access, refresh: rt1 } = await issueViaDevice(broker);
    const handle = parseRefresh(rt1)?.handle ?? '';
    await broker.revoke(`gko_rt_${handle}.1.${'q'.repeat(43)}`); // bogus secret
    expect((await broker.resolveBrokerToken(access)).ok).toBe(true); // still active
    await broker.revoke(access); // real proof
    expect((await broker.resolveBrokerToken(access)).ok).toBe(false);
  });

  it('deactivating the principal revokes on next refresh', async () => {
    const { broker, idp } = makeBroker();
    const { refresh: rt1 } = await issueViaDevice(broker);
    idp.deactivate('user-1');
    expect((await broker.refresh(rt1, 'claude-code')).ok).toBe(false);
  });
});

describe('authorization code + PKCE (S256 only)', () => {
  it('rejects plain and verifies a correct S256 verifier', async () => {
    const { broker } = makeBroker();
    const verifier = 'a'.repeat(64);
    const challenge = pkceChallengeS256(verifier);
    const plain = await broker.authorize({
      clientId: 'claude-code',
      redirectUri: 'http://127.0.0.1:53211/callback',
      state: 'st',
      codeChallenge: challenge,
      codeChallengeMethod: 'plain',
      identity: { subject: 'u', displayName: 'U' },
    });
    expect(plain.ok).toBe(false);

    const auth = await broker.authorize({
      clientId: 'claude-code',
      redirectUri: 'http://127.0.0.1:53211/callback',
      state: 'st',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      identity: { subject: 'u', displayName: 'U' },
    });
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;

    const bad = await broker.tokenAuthCode({
      code: auth.value.code,
      codeVerifier: 'wrong',
      redirectUri: 'http://127.0.0.1:53211/callback',
      clientId: 'claude-code',
    });
    expect(bad.ok).toBe(false); // code consumed; and verifier was wrong
  });

  it('validateLoopbackRedirect accepts the bracketed IPv6 loopback WHATWG URL reports', () => {
    expect(validateLoopbackRedirect('http://[::1]:5555/callback', ['/callback'])).toBe(true);
    expect(validateLoopbackRedirect('http://[::2]:5555/callback', ['/callback'])).toBe(false);
  });

  it('validateLoopbackRedirect enforces loopback + exact path', () => {
    expect(validateLoopbackRedirect('http://127.0.0.1:5000/callback', ['/callback'])).toBe(true);
    expect(validateLoopbackRedirect('http://evil.example/callback', ['/callback'])).toBe(false);
    expect(validateLoopbackRedirect('http://127.0.0.1:5000/other', ['/callback'])).toBe(false);
    expect(pkceVerifyS256('a'.repeat(64), pkceChallengeS256('a'.repeat(64)))).toBe(true);
  });
});

describe('verifyEs256 alg pinning', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const sign = (alg: string, claims: Record<string, unknown>): string => {
    const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${header}.${payload}`;
    if (alg === 'none') return `${input}.`;
    const sig = createSign('SHA256')
      .update(input)
      .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${input}.${sig.toString('base64url')}`;
  };

  it('accepts a valid ES256 token and rejects none / HS256 / tampered', () => {
    expect(verifyEs256(sign('ES256', { sub: 'x' }), publicKey).ok).toBe(true);
    expect(verifyEs256(sign('none', { sub: 'x' }), publicKey).ok).toBe(false);
    expect(
      verifyEs256(`${sign('HS256', { sub: 'x' }).split('.').slice(0, 2).join('.')}.zzzz`, publicKey)
        .ok,
    ).toBe(false);
    const good = sign('ES256', { sub: 'x' });
    expect(verifyEs256(good.slice(0, -3) + 'aaa', publicKey).ok).toBe(false);
  });
});
