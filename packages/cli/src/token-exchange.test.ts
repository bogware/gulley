import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli';
import { JWT_BEARER_GRANT_TYPE, K8S_SA_TOKEN_PATH } from './token-exchange';

/**
 * `gulley token exchange` over a scripted broker + GitHub token service: the exact
 * wire shape of the RFC 7523 request, each assertion source, and that the assertion
 * never reaches stdout/stderr.
 */
const ASSERTION =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeXN0ZW06c2VydmljZWFjY291bnQ6cHJvZDpidWlsZGVyIn0.sig';
const GH_ASSERTION =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZXBvOmFjbWUvYXBpOnJlZjpyZWZzL2hlYWRzL21haW4ifQ.ghsig';

function harness(opts: { reject?: string; githubEnv?: boolean } = {}) {
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, string>;
    contentType: string;
  }> = [];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    const contentType = String(headers['content-type'] ?? '');
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    requests.push({ url, method: init?.method ?? 'GET', headers, body, contentType });
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return json(200, {
        issuer: 'https://api.gulley.test',
        token_endpoint: 'https://api.gulley.test/oauth/token',
        grant_types_supported: [JWT_BEARER_GRANT_TYPE],
      });
    }
    if (url.startsWith('https://pipelines.actions.githubusercontent.com/token')) {
      if (headers['authorization'] !== 'bearer runner-token') return json(401, {});
      return json(200, { value: GH_ASSERTION });
    }
    if (url.endsWith('/oauth/token')) {
      if (body['grant_type'] !== JWT_BEARER_GRANT_TYPE)
        return json(400, { error: 'unsupported_grant_type' });
      if (opts.reject) return json(400, { error: opts.reject, error_description: 'generic' });
      return json(200, { access_token: 'gko_at_h9.svc', token_type: 'Bearer', expires_in: 900 });
    }
    return json(404, { error: 'not_found' });
  };

  const io: CliIo = {
    readText: (p) => files.get(p),
    writeText: (p, c) => void files.set(p, c),
    deleteFile: (p) => void files.delete(p),
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    fetch: fetchImpl,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    homeDir: '/home/ci',
    env: opts.githubEnv
      ? {
          ACTIONS_ID_TOKEN_REQUEST_URL:
            'https://pipelines.actions.githubusercontent.com/token?api-version=2',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-token',
        }
      : {},
    lock: async () => () => {},
  };
  return { io, out, err, requests, files };
}

describe('gulley token exchange (RFC 7523 JWT-bearer)', () => {
  it('reads the projected Kubernetes SA token and POSTs the form-encoded jwt-bearer grant', async () => {
    const h = harness();
    h.files.set(K8S_SA_TOKEN_PATH, `${ASSERTION}\n`);
    const code = await runCli(
      ['token', 'exchange', '--control', 'https://api.gulley.test/', '--k8s-sa'],
      h.io,
    );
    expect(code).toBe(0);
    expect(h.out).toEqual(['gko_at_h9.svc']);
    const req = h.requests.find((r) => r.url.endsWith('/oauth/token'));
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
    expect(req!.contentType).toBe('application/x-www-form-urlencoded');
    expect(req!.body).toEqual({ grant_type: JWT_BEARER_GRANT_TYPE, assertion: ASSERTION });
    // The assertion is a bearer credential: it never reaches stdout/stderr.
    expect(h.out.join('\n')).not.toContain(ASSERTION);
    expect(h.err.join('\n')).not.toContain(ASSERTION);
    expect(h.err.join('\n')).toContain('~15 min');
    // Nothing is persisted.
    expect([...h.files.keys()]).toEqual([K8S_SA_TOKEN_PATH]);
  });

  it('--assertion-file + --client + --env name the client and print an export line', async () => {
    const h = harness();
    h.files.set('/tmp/assertion.jwt', ASSERTION);
    const code = await runCli(
      [
        'token',
        'exchange',
        '--control',
        'https://api.gulley.test',
        '--assertion-file',
        '/tmp/assertion.jwt',
        '--client',
        'ci-runner',
        '--env',
      ],
      h.io,
    );
    expect(code).toBe(0);
    expect(h.out).toEqual(['export ANTHROPIC_AUTH_TOKEN=gko_at_h9.svc']);
    const req = h.requests.find((r) => r.url.endsWith('/oauth/token'));
    expect(req!.body['client_id']).toBe('ci-runner');
  });

  it('--github mints an OIDC token for the broker audience from the runner token service', async () => {
    const h = harness({ githubEnv: true });
    const code = await runCli(
      ['token', 'exchange', '--control', 'https://api.gulley.test', '--github'],
      h.io,
    );
    expect(code).toBe(0);
    const gh = h.requests.find((r) => r.url.includes('githubusercontent.com/token'));
    expect(gh).toBeDefined();
    const u = new URL(gh!.url);
    expect(u.searchParams.get('audience')).toBe('https://api.gulley.test'); // the broker issuer
    expect(u.searchParams.get('api-version')).toBe('2'); // existing query preserved
    expect(gh!.headers['authorization']).toBe('bearer runner-token');
    const tok = h.requests.find((r) => r.url.endsWith('/oauth/token'));
    expect(tok!.body['assertion']).toBe(GH_ASSERTION);
    expect(h.err.join('\n')).not.toContain(GH_ASSERTION);
    // An explicit audience overrides the default.
    const h2 = harness({ githubEnv: true });
    await runCli(
      [
        'token',
        'exchange',
        '--control',
        'https://api.gulley.test',
        '--github',
        '--audience',
        'gulley',
      ],
      h2.io,
    );
    expect(new URL(h2.requests[1]!.url).searchParams.get('audience')).toBe('gulley');
    // Outside Actions (no env) the guidance names the missing permission.
    const h3 = harness();
    expect(
      await runCli(
        ['token', 'exchange', '--control', 'https://api.gulley.test', '--github'],
        h3.io,
      ),
    ).toBe(1);
    expect(h3.err.join('\n')).toContain('id-token: write');
  });

  it('a rejected assertion is exit 1 with guidance and no token on stdout', async () => {
    const h = harness({ reject: 'invalid_grant' });
    h.files.set(K8S_SA_TOKEN_PATH, ASSERTION);
    expect(
      await runCli(['token', 'exchange', '--control', 'https://api.gulley.test', '--k8s-sa'], h.io),
    ).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join('\n')).toContain('WORKLOAD_FEDERATIONS');
    expect(h.err.join('\n')).not.toContain(ASSERTION);
    const off = harness({ reject: 'unsupported_grant_type' });
    off.files.set(K8S_SA_TOKEN_PATH, ASSERTION);
    await runCli(['token', 'exchange', '--control', 'https://api.gulley.test', '--k8s-sa'], off.io);
    expect(off.err.join('\n')).toContain('jwt-bearer grant is off');
  });

  it('validates its arguments and a missing token file', async () => {
    const h = harness();
    expect(await runCli(['token', 'exchange', '--k8s-sa'], h.io)).toBe(2); // no --control
    expect(
      await runCli(['token', 'exchange', '--control', 'https://x', '--k8s-sa', '--github'], h.io),
    ).toBe(2);
    expect(await runCli(['token', 'exchange', '--control', 'https://x'], h.io)).toBe(2);
    expect(
      await runCli(['token', 'exchange', '--control', 'https://api.gulley.test', '--k8s-sa'], h.io),
    ).toBe(1);
    expect(h.err.join('\n')).toContain(K8S_SA_TOKEN_PATH);
    // --token-path overrides the default mount.
    h.files.set('/var/run/custom/token', ASSERTION);
    expect(
      await runCli(
        [
          'token',
          'exchange',
          '--control',
          'https://api.gulley.test',
          '--k8s-sa',
          '--token-path',
          '/var/run/custom/token',
        ],
        h.io,
      ),
    ).toBe(0);
  });
});
