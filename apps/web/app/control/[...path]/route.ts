import type { NextRequest } from 'next/server';
import { controlApiUpstream } from '../../../lib/control-upstream';

/**
 * Same-origin proxy for the control-api: the browser talks only to `/control/*` on
 * the console's origin (no CORS, the OIDC session cookie stays first-party) and this
 * handler forwards to the control-api named by `CONTROL_API_URL` — read at REQUEST
 * time. The previous `next.config.mjs` rewrite baked the upstream into the build
 * (the runtime env was silently ignored, so one image could not serve two
 * environments and the Terraform `CONTROL_API_URL` was a no-op).
 *
 * Streams request and response bodies (SSE trace endpoints work), forwards every
 * `Set-Cookie` (the session cookie), never follows upstream redirects (the OIDC login
 * 302 must reach the browser), and answers 502/504 itself when the upstream is down
 * so the console's sign-in falls back cleanly instead of hanging.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Default 60 s: long enough for an evidence-bundle export or a config apply. */
const UPSTREAM_TIMEOUT_MS = Number(process.env['CONTROL_API_PROXY_TIMEOUT_MS'] ?? 60_000);

function forwardHeaders(req: Request): Headers {
  const out = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  // The control-api trusts a fixed number of proxy hops; tell it who the client is.
  const ip = req.headers.get('x-forwarded-for');
  const host = req.headers.get('host');
  if (host && !out.has('x-forwarded-host')) out.set('x-forwarded-host', host);
  if (!out.has('x-forwarded-proto'))
    out.set('x-forwarded-proto', new URL(req.url).protocol.replace(':', ''));
  if (ip) out.set('x-forwarded-for', ip);
  return out;
}

async function proxy(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${controlApiUpstream()}/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req),
      body: hasBody ? req.body : undefined,
      // @ts-expect-error -- Node's fetch needs duplex for a streamed request body.
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    const timeout = (err as { name?: string }).name === 'TimeoutError';
    return Response.json(
      {
        error: {
          type: timeout ? 'upstream_timeout' : 'upstream_unavailable',
          message: timeout ? 'control API timed out' : 'control API unreachable',
        },
      },
      { status: timeout ? 504 : 502 },
    );
  }
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === 'set-cookie' || k === 'content-encoding') return;
    headers.set(key, value);
  });
  // Multiple Set-Cookie headers must be appended individually (Headers.set would join them).
  const cookies =
    typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
