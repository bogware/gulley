import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli';
import { parseCredentials } from './credentials';

/**
 * A scripted broker: a fake `fetch` speaking the broker's HTTP surface with the exact
 * wire format the CLI must send (form-encoded token requests), plus an in-memory
 * filesystem and a manual clock, so every command runs hermetically.
 */
function harness(opts: { pendingPolls?: number; slowDown?: boolean; deny?: boolean } = {}) {
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ url: string; body: Record<string, string>; contentType: string }> = [];
  let clock = 1_700_000_000_000;
  let polls = 0;
  let generation = 1;
  let revoked = false;
  let introspectUnavailable = false;
  const lockEvents: string[] = [];

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const contentType = String(
      (init?.headers as Record<string, string> | undefined)?.['content-type'] ?? '',
    );
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    requests.push({ url, body, contentType });
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return json(200, {
        issuer: 'https://api.gulley.test',
        device_authorization_endpoint: 'https://api.gulley.test/oauth/device_authorization',
        token_endpoint: 'https://api.gulley.test/oauth/token',
        revocation_endpoint: 'https://api.gulley.test/oauth/revoke',
      });
    }
    if (url.endsWith('/oauth/device_authorization')) {
      if (body['client_id'] !== 'claude-code') return json(400, { error: 'invalid_client' });
      return json(200, {
        device_code: 'dev-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://console.gulley.test/oauth/device',
        verification_uri_complete: 'https://console.gulley.test/oauth/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.endsWith('/oauth/token')) {
      if (body['grant_type'] === 'urn:ietf:params:oauth:grant-type:device_code') {
        polls += 1;
        if (opts.deny) return json(400, { error: 'access_denied' });
        if (opts.slowDown && polls === 1) return json(400, { error: 'slow_down' });
        if (polls <= (opts.pendingPolls ?? 1)) return json(400, { error: 'authorization_pending' });
        return json(200, {
          access_token: `gko_at_h1.access${generation}`,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `gko_rt_h1.${generation}.secret${generation}`,
        });
      }
      if (body['grant_type'] === 'refresh_token') {
        if (revoked || body['refresh_token'] !== `gko_rt_h1.${generation}.secret${generation}`) {
          return json(400, { error: 'invalid_grant' });
        }
        generation += 1;
        return json(200, {
          access_token: `gko_at_h1.access${generation}`,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `gko_rt_h1.${generation}.secret${generation}`,
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.endsWith('/oauth/revoke')) {
      revoked = true;
      return json(200, {});
    }
    if (url.endsWith('/oauth/introspect')) {
      if (introspectUnavailable) return json(404, { error: 'not_found' });
      const active = !revoked && body['token'] === `gko_at_h1.access${generation}`;
      return json(200, active ? { active: true, client_id: 'claude-code' } : { active: false });
    }
    return json(404, { error: 'not_found' });
  };

  const io: CliIo = {
    readText: (p) => files.get(p),
    writeText: (p, c, o) => {
      files.set(p, c);
      if (o?.secret) lockEvents.push(`write:${p}`);
    },
    deleteFile: (p) => {
      files.delete(p);
    },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    fetch: fetchImpl,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    homeDir: '/home/dev',
    env: {},
    lock: async (p) => {
      lockEvents.push(`lock:${p}`);
      return () => lockEvents.push(`unlock:${p}`);
    },
  };
  return {
    io,
    out,
    err,
    requests,
    files,
    lockEvents,
    advance: (ms: number) => {
      clock += ms;
    },
    get polls() {
      return polls;
    },
    revokedAtBroker: () => revoked,
    revokeAtBroker: () => {
      revoked = true;
    },
    setIntrospectUnavailable: (v: boolean) => {
      introspectUnavailable = v;
    },
  };
}

const CRED = '/home/dev/.gulley/credentials.json';

describe('gulley login (device flow)', () => {
  it('discovers the broker, shows the code, polls with the RFC grant type, stores the family', async () => {
    const h = harness({ pendingPolls: 2 });
    const code = await runCli(
      ['login', '--broker', 'https://api.gulley.test/', '--client', 'claude-code'],
      h.io,
    );
    expect(code).toBe(0);
    // The user sees the complete verification URL + the code (on stderr, never stdout).
    expect(h.err.join('\n')).toContain(
      'https://console.gulley.test/oauth/device?user_code=ABCD-EFGH',
    );
    expect(h.err.join('\n')).toContain('ABCD-EFGH');
    expect(h.out).toEqual([]);
    // Token-endpoint requests are form-encoded with the RFC 8628 grant type.
    const tokenReqs = h.requests.filter((r) => r.url.endsWith('/oauth/token'));
    expect(tokenReqs.length).toBe(3); // pending, pending, issued
    expect(tokenReqs[0]!.contentType).toBe('application/x-www-form-urlencoded');
    expect(tokenReqs[0]!.body['grant_type']).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(tokenReqs[0]!.body['device_code']).toBe('dev-1');
    // The profile defaults to the client id and is written as a secret.
    const creds = parseCredentials(h.files.get(CRED));
    expect(creds.profiles['claude-code']).toMatchObject({
      brokerUrl: 'https://api.gulley.test',
      clientId: 'claude-code',
      accessToken: 'gko_at_h1.access1',
      refreshToken: 'gko_rt_h1.1.secret1',
    });
    expect(h.lockEvents).toContain(`write:${CRED}`);
  });

  it('honors slow_down and surfaces a denial', async () => {
    const slow = harness({ slowDown: true, pendingPolls: 1 });
    expect(
      await runCli(
        ['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'],
        slow.io,
      ),
    ).toBe(0);
    const denied = harness({ deny: true });
    expect(
      await runCli(
        ['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'],
        denied.io,
      ),
    ).toBe(1);
    expect(denied.err.join('\n')).toContain('denied');
    const unknown = harness();
    expect(
      await runCli(
        ['login', '--broker', 'https://api.gulley.test', '--client', 'nope'],
        unknown.io,
      ),
    ).toBe(1);
    expect(unknown.err.join('\n')).toContain('does not know client');
  });

  it('requires --broker and --client', async () => {
    const h = harness();
    expect(await runCli(['login', '--client', 'x'], h.io)).toBe(2);
  });
});

describe('gulley token (the apiKeyHelper / Codex auth command)', () => {
  async function loggedIn() {
    const h = harness();
    await runCli(
      ['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code', '--profile', 'p'],
      h.io,
    );
    h.out.length = 0;
    h.err.length = 0;
    h.requests.length = 0;
    return h;
  }

  it('prints ONLY the access token while it is fresh (introspects, never refreshes)', async () => {
    const h = await loggedIn();
    expect(await runCli(['token', '--profile', 'p'], h.io)).toBe(0);
    expect(h.out).toEqual(['gko_at_h1.access1']);
    expect(h.requests.filter((r) => r.body['grant_type'] === 'refresh_token').length).toBe(0);
    const intro = h.requests.find((r) => r.url.endsWith('/oauth/introspect'));
    expect(intro?.body['token']).toBe('gko_at_h1.access1');
    expect(intro?.contentType).toBe('application/x-www-form-urlencoded');
    // A broker without introspection (404 / network) keeps trusting the cached token.
    h.setIntrospectUnavailable(true);
    h.out.length = 0;
    expect(await runCli(['token', '--profile', 'p'], h.io)).toBe(0);
    expect(h.out).toEqual(['gko_at_h1.access1']);
  });

  it('a token revoked at the broker is never handed to the agent: refresh is tried, then guidance', async () => {
    const h = await loggedIn();
    h.revokeAtBroker(); // admin revoke / reuse-triggered family kill
    expect(await runCli(['token', '--profile', 'p'], h.io)).toBe(1);
    expect(h.out).toEqual([]); // nothing on stdout — the agent must not get a dead token
    expect(h.requests.filter((r) => r.body['grant_type'] === 'refresh_token').length).toBe(1);
    expect(h.err.join('\n')).toContain('gulley login');
  });

  it('refreshes ahead of expiry under the lock, rotating the stored refresh token', async () => {
    const h = await loggedIn();
    h.advance(3600_000 - 5 * 60_000); // 5 min left: inside the 6-min refresh-ahead window
    expect(await runCli(['token', '--profile', 'p'], h.io)).toBe(0);
    expect(h.out).toEqual(['gko_at_h1.access2']);
    const refresh = h.requests.find((r) => r.body['grant_type'] === 'refresh_token');
    expect(refresh?.body['refresh_token']).toBe('gko_rt_h1.1.secret1');
    expect(refresh?.contentType).toBe('application/x-www-form-urlencoded');
    expect(parseCredentials(h.files.get(CRED)).profiles['p']?.refreshToken).toBe(
      'gko_rt_h1.2.secret2',
    );
    // Lock taken before the refresh and released after.
    expect(h.lockEvents.filter((e) => e.startsWith('lock:')).length).toBe(1);
    expect(h.lockEvents.at(-1)).toBe(`unlock:${CRED}`);
  });

  it('after acquiring the lock, re-reads and reuses a concurrent refresh instead of replaying', async () => {
    const h = await loggedIn();
    h.advance(3600_000); // expired
    // Simulate another helper process having refreshed (a REAL rotation at the broker)
    // while we waited for the lock: it rotated gen 1 → 2 and stored the result.
    const original = h.io.lock;
    h.io.lock = async (p) => {
      const res = await h.io.fetch('https://api.gulley.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'gko_rt_h1.1.secret1',
          client_id: 'claude-code',
        }).toString(),
      });
      const rotated = (await res.json()) as { access_token: string; refresh_token: string };
      const creds = parseCredentials(h.files.get(CRED));
      creds.profiles['p'] = {
        ...creds.profiles['p']!,
        accessToken: rotated.access_token,
        accessExpiresAt: h.io.now() + 3600_000,
        refreshToken: rotated.refresh_token,
      };
      h.files.set(CRED, JSON.stringify(creds));
      return original(p);
    };
    expect(await runCli(['token', '--profile', 'p'], h.io)).toBe(0);
    expect(h.out).toEqual(['gko_at_h1.access2']); // the other process's token, reused
    // Exactly ONE rotation happened (the other process's) — ours did not replay gen 1,
    // which the broker would have treated as theft and revoked the family.
    expect(h.requests.filter((r) => r.body['grant_type'] === 'refresh_token').length).toBe(1);
    expect(h.revokedAtBroker()).toBe(false);
  });

  it('a revoked / rotated-elsewhere session fails closed with guidance to log in again', async () => {
    const h = await loggedIn();
    h.advance(3600_000);
    // Corrupt the stored refresh token (as if the family had been rotated elsewhere).
    const creds = parseCredentials(h.files.get(CRED));
    creds.profiles['p']!.refreshToken = 'gko_rt_h1.1.stale';
    h.files.set(CRED, JSON.stringify(creds));
    expect(await runCli(['token', '--profile', 'p'], h.io)).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join('\n')).toContain('gulley login');
  });

  it('with no stored profile, exits 1 with the login hint', async () => {
    const h = harness();
    expect(await runCli(['token'], h.io)).toBe(1);
    expect(h.err.join('\n')).toContain('gulley login');
  });
});

describe('gulley logout / status', () => {
  it('revokes the refresh token at the broker and removes the profile', async () => {
    const h = harness();
    await runCli(['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'], h.io);
    expect(await runCli(['status'], h.io)).toBe(0);
    expect(h.out.join('\n')).toContain('client=claude-code');
    expect(h.out.join('\n')).not.toContain('secret1'); // never the secret
    expect(await runCli(['logout', '--profile', 'claude-code'], h.io)).toBe(0);
    expect(h.revokedAtBroker()).toBe(true);
    const revoke = h.requests.find((r) => r.url.endsWith('/oauth/revoke'));
    expect(revoke?.body['token']).toBe('gko_rt_h1.1.secret1');
    expect(h.files.has(CRED)).toBe(false); // last profile ⇒ file removed
    expect(await runCli(['status'], h.io)).toBe(1);
  });
});
