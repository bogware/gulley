import { describe, expect, it } from 'vitest';
import { InMemoryAdminSessionStore, resolveAdmin } from './admin-resolver';
import { type AdminSessionClaims, signAdminSession, verifyAdminSession } from './admin-session';

const SECRET = 'admin-resolver-test-secret-32-characters!!';
const NOW = 1_800_000_000_000;

function token(over: Partial<AdminSessionClaims> = {}): string {
  const iat = Math.floor(NOW / 1000);
  return signAdminSession(SECRET, {
    sub: 'alice',
    name: 'Alice',
    jti: '11111111-1111-4111-8111-111111111111',
    memberships: [{ role: 'viewer', orgId: 'org-1', workspaceId: null }],
    iat,
    exp: iat + 600,
    typ: 'admin-session',
    ver: 1,
    ...over,
  });
}

const deps = (extra: Record<string, unknown> = {}) => ({
  bootstrapEnabled: false,
  sessionSecrets: [SECRET],
  maxSessionTtlMs: 900_000,
  now: NOW,
  ...extra,
});

describe('admin session `src` claim', () => {
  it('carries the mint path, and resolves a token without it as legacy', () => {
    const v = verifyAdminSession([SECRET], token({ src: 'exchange' }), {
      now: NOW,
      maxTtlMs: 900_000,
    });
    expect(v.ok && v.value.source).toBe('exchange');
    const legacy = verifyAdminSession([SECRET], token(), { now: NOW, maxTtlMs: 900_000 });
    expect(legacy.ok && legacy.value.source).toBe('legacy');
  });
});

describe('resolveAdmin — durable loader policy', () => {
  it('unions persisted grants for an OIDC/legacy session', async () => {
    const r = await resolveAdmin(
      token({ src: 'oidc' }),
      deps({
        membershipLoader: async () => [{ role: 'admin', orgId: 'org-2', workspaceId: null }],
      }),
    );
    expect(r.ok && r.value.memberships).toEqual([
      { role: 'viewer', orgId: 'org-1', workspaceId: null },
      { role: 'admin', orgId: 'org-2', workspaceId: null },
    ]);
  });

  it('NEVER widens a delegated (exchange) token with the named subject’s grants', async () => {
    let called = 0;
    const r = await resolveAdmin(
      token({ src: 'exchange', sub: 'platform-owner' }),
      deps({
        membershipLoader: async () => {
          called++;
          return [{ role: 'owner', orgId: '*', workspaceId: null }];
        },
      }),
    );
    expect(called).toBe(0);
    expect(r.ok && r.value.memberships).toEqual([
      { role: 'viewer', orgId: 'org-1', workspaceId: null },
    ]);
  });

  it('a failing loader degrades to token memberships and reports the failure', async () => {
    const seen: Array<[string, unknown]> = [];
    const r = await resolveAdmin(
      token({ src: 'oidc' }),
      deps({
        membershipLoader: async () => {
          throw new Error('pg down');
        },
        onLoaderError: (subject: string, err: unknown) => seen.push([subject, err]),
      }),
    );
    expect(r.ok && r.value.memberships).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe('alice');
    expect((seen[0]![1] as Error).message).toBe('pg down');
  });
});

describe('InMemoryAdminSessionStore.revokeBySubject', () => {
  it('revokes every live session of the subject and returns the count', async () => {
    const s = new InMemoryAdminSessionStore();
    for (const jti of ['a', 'b']) {
      await s.record({ jti, subject: 'bob', source: 'oidc', createdAt: 'x', expiresAt: 'y' });
    }
    await s.record({ jti: 'c', subject: 'carol', source: 'oidc', createdAt: 'x', expiresAt: 'y' });
    expect(await s.revokeBySubject('bob')).toBe(2);
    expect(await s.isActive('a')).toBe(false);
    expect(await s.isActive('c')).toBe(true);
    expect(await s.revokeBySubject('bob')).toBe(0); // idempotent
  });
});
