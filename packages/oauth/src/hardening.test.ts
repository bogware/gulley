import { describe, expect, it } from 'vitest';
import type { IdentityProvider } from './idp';
import { BrokerService, type BrokerConfig } from './service';
import {
  InMemoryAuthCodeStore,
  InMemoryDeviceCodeStore,
  InMemoryGrantStore,
  InMemoryOAuthClientStore,
} from './stores';
import { parseRefresh } from './tokens';

/** An IdP that counts how often the broker consults it. */
class CountingIdp implements IdentityProvider {
  readonly mode = 'simulated' as const;
  calls = 0;
  active = true;
  async isPrincipalActive(): Promise<boolean> {
    this.calls++;
    return this.active;
  }
}

function makeBroker(): { broker: BrokerService; idp: CountingIdp; grants: InMemoryGrantStore } {
  const idp = new CountingIdp();
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
    pepper: 'oauth-hardening-pepper',
    accessTtlMs: 3_600_000,
    refreshTtlMs: 30 * 86_400_000,
    absoluteTtlMs: 90 * 86_400_000,
    deviceCodeTtlMs: 900_000,
    deviceIntervalMs: 5_000,
    now: () => 1_700_000_000_000,
  };
  const grants = new InMemoryGrantStore();
  return {
    broker: new BrokerService(cfg, {
      grants,
      devices: new InMemoryDeviceCodeStore(),
      codes: new InMemoryAuthCodeStore(),
      clients,
      idp,
    }),
    idp,
    grants,
  };
}

async function issue(broker: BrokerService): Promise<string> {
  const da = await broker.deviceAuthorization('claude-code');
  if (!da.ok) throw new Error('device auth failed');
  await broker.deviceApprove(da.value.user_code, { subject: 'user-1', displayName: 'User One' });
  const tok = await broker.tokenDeviceCode(da.value.device_code, 'claude-code');
  if (!tok.ok) throw new Error('token failed');
  return tok.value.refresh_token;
}

describe('refresh: the secret is verified BEFORE the IdP is consulted', () => {
  it('a forged secret on a real handle never reaches the IdP and changes no state', async () => {
    const { broker, idp } = makeBroker();
    const rt = await issue(broker);
    const handle = parseRefresh(rt)!.handle;
    const forged = `gko_rt_${handle}.1.${'q'.repeat(43)}`;
    expect((await broker.refresh(forged, 'claude-code')).ok).toBe(false);
    expect(idp.calls).toBe(0);
    // The genuine token still works (and DOES consult the IdP once).
    expect((await broker.refresh(rt, 'claude-code')).ok).toBe(true);
    expect(idp.calls).toBe(1);
  });

  it('a deactivated principal is still revoked on a genuine refresh', async () => {
    const { broker, idp } = makeBroker();
    const rt = await issue(broker);
    idp.active = false;
    expect((await broker.refresh(rt, 'claude-code')).ok).toBe(false);
    expect((await broker.refresh(rt, 'claude-code')).ok).toBe(false); // family revoked
  });
});

describe('GrantStore.revoke reports whether a grant existed', () => {
  it('true for a live family, false for an unknown handle', async () => {
    const { broker, grants } = makeBroker();
    const rt = await issue(broker);
    const handle = parseRefresh(rt)!.handle;
    expect(await grants.revoke('no-such-handle')).toBe(false);
    expect(await grants.revoke(handle)).toBe(true);
    expect((await grants.get(handle))?.status).toBe('revoked');
  });
});
