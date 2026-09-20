import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { controlApiUpstream } from '../../../lib/control-upstream';
import { GET, POST } from './route';

type Call = { url: string; init: RequestInit & { duplex?: string } };
let calls: Call[];
let upstreamFactory: () => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  upstreamFactory = () => new Response('{"ok":true}', { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: (init ?? {}) as Call['init'] });
      return upstreamFactory();
    }),
  );
  process.env['CONTROL_API_URL'] = 'http://api.internal:8081/';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['CONTROL_API_URL'];
});

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const req = (url: string, init?: RequestInit) => new Request(url, init) as unknown as NextRequest;

describe('/control/* runtime proxy', () => {
  it('reads CONTROL_API_URL at request time and forwards method, path, query and cookies', async () => {
    const res = await GET(
      req('http://console.test/control/auth/me?x=1', {
        headers: {
          cookie: 'gulley_admin_session=abc',
          host: 'console.test',
          connection: 'keep-alive',
        },
      }),
      ctx('auth', 'me'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('http://api.internal:8081/auth/me?x=1');
    const h = calls[0]!.init.headers as Headers;
    expect(h.get('cookie')).toBe('gulley_admin_session=abc');
    expect(h.get('connection')).toBeNull(); // hop-by-hop stripped
    expect(h.get('x-forwarded-host')).toBe('console.test');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(controlApiUpstream()).toBe('http://api.internal:8081');
  });

  it('streams a request body upstream and passes every Set-Cookie back', async () => {
    upstreamFactory = () => {
      const r = new Response('{"token":"t"}', { status: 201 });
      r.headers.append('set-cookie', 'a=1; Path=/');
      r.headers.append('set-cookie', 'b=2; Path=/; HttpOnly');
      return r;
    };
    const res = await POST(
      req('http://console.test/control/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"Acme"}',
      }),
      ctx('orgs'),
    );
    expect(res.status).toBe(201);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.duplex).toBe('half');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
  });

  it('does not follow an upstream redirect (the OIDC login 302 reaches the browser)', async () => {
    upstreamFactory = () =>
      new Response(null, { status: 302, headers: { location: 'https://idp.test/authorize' } });
    const res = await GET(req('http://console.test/control/auth/login'), ctx('auth', 'login'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://idp.test/authorize');
  });

  it('answers 502 itself when the control API is unreachable, and 504 on a timeout', async () => {
    upstreamFactory = () => {
      throw new TypeError('fetch failed');
    };
    const down = await GET(req('http://console.test/control/auth/config'), ctx('auth', 'config'));
    expect(down.status).toBe(502);
    expect((await down.json()).error.type).toBe('upstream_unavailable');
    upstreamFactory = () => {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e;
    };
    const slow = await GET(req('http://console.test/control/auth/config'), ctx('auth', 'config'));
    expect(slow.status).toBe(504);
  });
});
