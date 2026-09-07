import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveAdmin } from './admin-resolver';
import { type AdminSessionClaims, signAdminSession, verifyAdminSession } from './admin-session';

const SECRET = 'session-secret-at-least-32-chars-long!!';
const NOW = 1_800_000_000_000; // fixed ms

function claims(over: Partial<AdminSessionClaims> = {}): AdminSessionClaims {
  const iat = Math.floor(NOW / 1000);
  return {
    sub: 'u1',
    name: 'Viewer',
    jti: 'jti-1',
    memberships: [{ role: 'viewer', orgId: 'o1' }],
    iat,
    exp: iat + 900,
    typ: 'admin-session',
    ver: 1,
    ...over,
  };
}

describe('admin session sign/verify', () => {
  const verify = (t: string, now = NOW) =>
    verifyAdminSession([SECRET], t, { now, maxTtlMs: 900_000 });

  it('round-trips a valid session', () => {
    const r = verify(signAdminSession(SECRET, claims()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.principal.memberships[0]?.role).toBe('viewer');
      expect(r.value.jti).toBe('jti-1');
    }
  });

  it('rejects a tampered body, wrong secret, expired, and over-TTL sessions', () => {
    const good = signAdminSession(SECRET, claims());
    const tampered = good.slice(0, -2) + (good.endsWith('aa') ? 'bb' : 'aa');
    expect(verify(tampered).ok).toBe(false);
    expect(
      verifyAdminSession(['other-secret-that-is-long-enough!!'], good, {
        now: NOW,
        maxTtlMs: 900_000,
      }).ok,
    ).toBe(false);
    expect(verify(signAdminSession(SECRET, claims()), NOW + 901_000).ok).toBe(false); // expired
    const long = claims({ exp: Math.floor(NOW / 1000) + 100_000 });
    const r = verifyAdminSession([SECRET], signAdminSession(SECRET, long), {
      now: NOW,
      maxTtlMs: 900_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('ttl-too-long');
  });

  it('accepts a previous secret during rotation overlap', () => {
    const token = signAdminSession('old-secret-old-secret-old-secret-32', claims());
    const r = verifyAdminSession([SECRET, 'old-secret-old-secret-old-secret-32'], token, {
      now: NOW,
      maxTtlMs: 900_000,
    });
    expect(r.ok).toBe(true);
  });
});

describe('resolveAdmin (fail-closed, no fall-through)', () => {
  const gadm = 'gadm_' + 'A'.repeat(43);
  const bootstrapSha = createHash('sha256').update(gadm).digest('hex');

  const deps = {
    bootstrapEnabled: true,
    bootstrapTokenSha256: bootstrapSha,
    sessionSecrets: [SECRET],
    maxSessionTtlMs: 900_000,
    now: NOW,
  };

  it('resolves the bootstrap token to an owner principal', async () => {
    const r = await resolveAdmin(gadm, deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.memberships[0]).toMatchObject({ role: 'owner', orgId: '*' });
  });

  it('rejects a wrong bootstrap token and a disabled bootstrap', async () => {
    expect((await resolveAdmin('gadm_' + 'B'.repeat(43), deps)).ok).toBe(false);
    expect((await resolveAdmin(gadm, { ...deps, bootstrapEnabled: false })).ok).toBe(false);
  });

  it('rejects a data-plane gk_ key and empty credentials (no fall-through)', async () => {
    expect((await resolveAdmin('gk_deadbeef_secret', deps)).ok).toBe(false);
    expect((await resolveAdmin(undefined, deps)).ok).toBe(false);
  });

  it('honors session revocation via the store', async () => {
    const token = signAdminSession(SECRET, claims({ jti: 'jti-x' }));
    const store = {
      isActive: async (jti: string) => jti !== 'jti-x',
      revoke: async () => {},
    };
    const r = await resolveAdmin(token, { ...deps, sessionStore: store });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('session-revoked');
  });

  it('durable RBAC: unions persisted memberships into the session principal', async () => {
    // Token carries only viewer@o1; the durable store grants owner@o2.
    const token = signAdminSession(SECRET, claims({ sub: 'u1' }));
    const r = await resolveAdmin(token, {
      ...deps,
      membershipLoader: async (subject) => {
        expect(subject).toBe('u1');
        return [{ role: 'owner', orgId: 'o2' }];
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Effective memberships = token ∪ persisted (a persisted grant is not inert).
      expect(r.value.memberships).toContainEqual({ role: 'viewer', orgId: 'o1' });
      expect(r.value.memberships).toContainEqual({ role: 'owner', orgId: 'o2' });
    }
  });

  it('fails closed to token memberships when the membership loader throws', async () => {
    const token = signAdminSession(SECRET, claims({ sub: 'u1' }));
    const r = await resolveAdmin(token, {
      ...deps,
      membershipLoader: async () => {
        throw new Error('db down');
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.memberships).toEqual([{ role: 'viewer', orgId: 'o1' }]);
  });
});
