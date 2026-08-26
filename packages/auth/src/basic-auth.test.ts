import { hashSync } from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { resolveBasicPrincipal } from './basic-resolver';
import { apr1, parseHtpasswd, verifyPassword } from './htpasswd';

// Ground-truth htpasswd hashes for password "s3cr3t-pass" (generated with
// `openssl passwd -apr1` / `openssl dgst -sha1`).
const PW = 's3cr3t-pass';
const APR1 = '$apr1$Xy9zAbW1$yWHFWKOrw3L2VFJNzY4D81';
const SHA1 = '{SHA}odKJkwKY4tho9rvOxJxWgAnNmac=';

describe('verifyPassword', () => {
  it('verifies a bcrypt hash (and its $2y$ variant)', () => {
    const b = hashSync(PW, 10);
    expect(verifyPassword(b, PW)).toBe(true);
    expect(verifyPassword(b, 'wrong')).toBe(false);
    // $2y$ is algorithmically identical to $2b$ and must be accepted.
    expect(verifyPassword(b.replace(/^\$2b\$/, '$2y$'), PW)).toBe(true);
  });

  it('verifies an Apache $apr1$ MD5 hash against the openssl vector', () => {
    expect(apr1(PW, 'Xy9zAbW1')).toBe(APR1);
    expect(verifyPassword(APR1, PW)).toBe(true);
    expect(verifyPassword(APR1, 'nope')).toBe(false);
  });

  it('verifies a {SHA} hash', () => {
    expect(verifyPassword(SHA1, PW)).toBe(true);
    expect(verifyPassword(SHA1, 'nope')).toBe(false);
  });

  it('verifies plaintext and FAILS CLOSED on unsupported/blank formats', () => {
    expect(verifyPassword('{plain}letmein', 'letmein')).toBe(true);
    expect(verifyPassword('letmein', 'letmein')).toBe(true); // unmarked plaintext
    expect(verifyPassword('letmein', 'other')).toBe(false);
    // DES crypt (13 chars) is unsupported → fails closed, and is NEVER accepted as
    // its own password (the plaintext-fallthrough vulnerability).
    expect(verifyPassword('abJnggxhB/yWI', PW)).toBe(false);
    expect(verifyPassword('abJnggxhB/yWI', 'abJnggxhB/yWI')).toBe(false);
    // Unsupported $5$/$6$ crypt schemes fail closed too.
    expect(verifyPassword('$6$salt$hashhashhash', '$6$salt$hashhashhash')).toBe(false);
    // A blank hash entry authenticates nobody — not even a blank password.
    expect(verifyPassword('', '')).toBe(false);
  });
});

describe('parseHtpasswd', () => {
  it('parses entries, skipping comments and blanks', () => {
    const map = parseHtpasswd(`# a comment\n\nalice:${APR1}\nbob:${SHA1}\n`);
    expect(map.size).toBe(2);
    expect(map.get('alice')).toBe(APR1);
    expect(map.get('bob')).toBe(SHA1);
  });
});

describe('resolveBasicPrincipal', () => {
  const header = (u: string, p: string): string =>
    `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  const cfg = {
    htpasswd: parseHtpasswd(`alice:${APR1}\nbob:${SHA1}`),
    users: new Map([['alice', { workspaceId: 'ws_a', allowedModels: ['claude-sonnet-4-6'] }]]),
    defaultOrgId: 'org_1',
    defaultWorkspaceId: 'ws_default',
  };

  it('resolves a valid user with its scoped overrides', () => {
    const r = resolveBasicPrincipal(header('alice', PW), cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      kind: 'basic',
      authMode: 'basic',
      id: 'basic:alice',
      displayName: 'alice',
      scope: { orgId: 'org_1', workspaceId: 'ws_a', allowedModels: ['claude-sonnet-4-6'] },
    });
  });

  it('DENIES by default for a user without overrides or a configured default', () => {
    const r = resolveBasicPrincipal(header('bob', PW), cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Deny-by-default: no override + no default ⇒ empty allow-lists (reaches nothing).
    expect(r.value.scope).toMatchObject({
      workspaceId: 'ws_default',
      allowedProviders: [],
      allowedModels: [],
    });
  });

  it('honors an explicitly configured permissive default', () => {
    const permissive = {
      ...cfg,
      defaultAllowedProviders: '*' as const,
      defaultAllowedModels: '*' as const,
    };
    const r = resolveBasicPrincipal(header('bob', PW), permissive);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scope).toMatchObject({ allowedProviders: '*', allowedModels: '*' });
  });

  it('rejects a bad password, unknown user, and malformed header', () => {
    expect(resolveBasicPrincipal(header('alice', 'wrong'), cfg).ok).toBe(false);
    expect(resolveBasicPrincipal(header('carol', PW), cfg).ok).toBe(false);
    expect(resolveBasicPrincipal('Bearer xyz', cfg).ok).toBe(false);
    expect(resolveBasicPrincipal(undefined, cfg).ok).toBe(false);
  });
});
