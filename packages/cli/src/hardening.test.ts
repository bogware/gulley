import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli';
import { expandHome, parseCredentials } from './credentials';
import { pollDeviceToken, revokeToken, type BrokerEndpoints } from './device-login';
import { signOnboardingPack } from './onboarding';
import { generateKeyPairSync } from 'node:crypto';

/** Minimal broker + in-memory IO (a slimmer twin of cli.test.ts's harness). */
function harness(opts: { discoveryDown?: boolean; revokeDown?: boolean } = {}) {
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  let clock = 1_700_000_000_000;
  let generation = 1;
  let family = 0; // each device login mints a NEW token family (a new handle)
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      if (opts.discoveryDown) throw new TypeError('fetch failed');
      return json(200, {
        issuer: 'https://api.gulley.test',
        device_authorization_endpoint: 'https://api.gulley.test/oauth/device_authorization',
        token_endpoint: 'https://api.gulley.test/oauth/token',
        revocation_endpoint: 'https://api.gulley.test/oauth/revoke',
        introspection_endpoint: 'https://api.gulley.test/oauth/introspect',
      });
    }
    if (url.endsWith('/oauth/device_authorization')) {
      return json(200, {
        device_code: 'dev-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://console.gulley.test/oauth/device',
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.endsWith('/oauth/token')) {
      if (body['grant_type'] === 'refresh_token') generation += 1;
      else {
        family += 1;
        generation = 1;
      }
      return json(200, {
        access_token: `gko_at_h${family}.access${generation}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `gko_rt_h${family}.${generation}.secret${generation}`,
      });
    }
    if (url.endsWith('/oauth/revoke')) {
      if (opts.revokeDown) throw new TypeError('fetch failed');
      return json(200, {});
    }
    if (url.endsWith('/oauth/introspect')) return json(200, { active: true });
    return json(404, {});
  };
  const io: CliIo = {
    readText: (p) => files.get(p),
    writeText: (p, c) => void files.set(p, c),
    deleteFile: (p) => void files.delete(p),
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    fetch: fetchImpl,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    homeDir: '/home/dev',
    env: {},
    lock: async () => () => undefined,
  };
  return { io, out, err, requests, files, advance: (ms: number) => void (clock += ms) };
}
const CRED = '/home/dev/.gulley/credentials.json';

describe('expandHome', () => {
  it('expands ~ and ~/ (POSIX and Windows homes) and leaves other paths alone', () => {
    expect(expandHome('~/.codex/config.toml', '/home/dev')).toBe('/home/dev/.codex/config.toml');
    expect(expandHome('~', '/home/dev/')).toBe('/home/dev/');
    expect(expandHome('~/.codex/config.toml', 'C:\\Users\\dev')).toBe(
      'C:\\Users\\dev\\.codex/config.toml',
    );
    expect(expandHome('.claude/settings.json', '/home/dev')).toBe('.claude/settings.json');
    expect(expandHome('/abs/~/x', '/home/dev')).toBe('/abs/~/x');
  });

  it('gulley init writes the Codex pack under the home directory, not ./~', async () => {
    const h = harness();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pack = signOnboardingPack(
      {
        version: 1,
        issuedAt: new Date().toISOString(),
        agent: 'codex',
        gatewayUrl: 'https://gw.test',
        config: {
          path: '~/.codex/config.toml',
          format: 'toml',
          content: '[model_providers.gulley]\nname = "Gulley"\n',
          notes: [],
        },
      } as never,
      privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    );
    h.files.set('/tmp/pack.json', JSON.stringify(pack));
    h.files.set('/tmp/key.pem', publicKey.export({ type: 'spki', format: 'pem' }) as string);
    expect(await runCli(['init', '/tmp/pack.json', '--pubkey', '/tmp/key.pem'], h.io)).toBe(0);
    expect(h.files.has('/home/dev/.codex/config.toml')).toBe(true);
    expect([...h.files.keys()].some((k) => k.includes('~'))).toBe(false);
  });
});

describe('credentials file resilience', () => {
  it('a corrupt credentials file gives guidance instead of a JSON.parse stack', async () => {
    const h = harness();
    h.files.set(CRED, '{not json');
    expect(await runCli(['token'], h.io)).toBe(1);
    expect(h.err.join('\n')).toMatch(/corrupt/);
    expect(h.err.join('\n')).toContain('gulley login');
    expect(h.out).toEqual([]);
    expect(() => parseCredentials('{"version":2}', CRED)).toThrow(/corrupt/);
  });

  it('discovery is cached in the profile: `token` skips the well-known fetch while fresh', async () => {
    const h = harness();
    await runCli(['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'], h.io);
    const stored = parseCredentials(h.files.get(CRED)).profiles['claude-code']!;
    expect(stored.endpoints?.tokenEndpoint).toBe('https://api.gulley.test/oauth/token');
    h.requests.length = 0;
    expect(await runCli(['token', '--profile', 'claude-code'], h.io)).toBe(0);
    expect(h.requests.some((u) => u.endsWith('/.well-known/oauth-authorization-server'))).toBe(
      false,
    );
    // After the TTL the endpoints are re-discovered.
    h.advance(7 * 3_600_000);
    h.requests.length = 0;
    await runCli(['token', '--profile', 'claude-code'], h.io);
    expect(h.requests.some((u) => u.endsWith('/.well-known/oauth-authorization-server'))).toBe(
      true,
    );
  });
});

describe('logout / re-login honesty', () => {
  it('logout says whether the broker acknowledged the revocation', async () => {
    const ok = harness();
    await runCli(
      ['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'],
      ok.io,
    );
    await runCli(['logout', '--profile', 'claude-code'], ok.io);
    expect(ok.err.at(-1)).toMatch(/revoked at the broker/);

    const down = harness({ revokeDown: true });
    await runCli(
      ['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'],
      down.io,
    );
    await runCli(['logout', '--profile', 'claude-code'], down.io);
    expect(down.err.at(-1)).toMatch(/signed out locally/);
    expect(down.files.has(CRED)).toBe(false);
  });

  it('re-login over an existing profile revokes the previous family', async () => {
    const h = harness();
    await runCli(['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'], h.io);
    h.requests.length = 0;
    await runCli(['login', '--broker', 'https://api.gulley.test', '--client', 'claude-code'], h.io);
    expect(h.requests.filter((u) => u.endsWith('/oauth/revoke'))).toHaveLength(1);
  });
});

describe('device polling and revocation over a flaky network', () => {
  const endpoints: BrokerEndpoints = {
    issuer: 'https://b',
    deviceAuthorizationEndpoint: 'https://b/d',
    tokenEndpoint: 'https://b/t',
    revocationEndpoint: 'https://b/r',
    introspectionEndpoint: 'https://b/i',
  };

  it('keeps polling through transient fetch errors and gives up only after repeated failures', async () => {
    let calls = 0;
    let clock = 0;
    const flaky: typeof fetch = async () => {
      calls += 1;
      if (calls <= 2) throw new TypeError('fetch failed');
      return new Response(
        JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }),
        { status: 200 },
      );
    };
    const tokens = await pollDeviceToken(
      endpoints,
      'c',
      { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresIn: 900, interval: 1 },
      { fetch: flaky, sleep: async (ms) => void (clock += ms), now: () => clock },
    );
    expect(tokens.accessToken).toBe('a');
    expect(calls).toBe(3);

    const dead: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      pollDeviceToken(
        endpoints,
        'c',
        { deviceCode: 'd', userCode: 'u', verificationUri: 'v', expiresIn: 900, interval: 1 },
        { fetch: dead, sleep: async (ms) => void (clock += ms), now: () => clock },
      ),
    ).rejects.toMatchObject({ code: 'network_error' });
  });

  it('revokeToken reports acknowledgement', async () => {
    const ok: typeof fetch = async () => new Response('{}', { status: 200 });
    const fail: typeof fetch = async () => new Response('{}', { status: 503 });
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await revokeToken(endpoints, 't', ok)).toBe(true);
    expect(await revokeToken(endpoints, 't', fail)).toBe(false);
    expect(await revokeToken(endpoints, 't', down)).toBe(false);
  });
});
