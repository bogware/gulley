import http from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GoogleServiceAccountTokenProvider } from './google-auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function verifyJwt(jwt: string): boolean {
  const [h, p, s] = jwt.split('.');
  return createVerify('RSA-SHA256')
    .update(`${h}.${p}`)
    .verify(PUBLIC_PEM, s ?? '', 'base64url');
}

describe('GoogleServiceAccountTokenProvider', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function tokenServer(
    onAssertion: (jwt: string) => void,
    ttl = 3600,
  ): Promise<{ url: string; hits: () => number }> {
    let hits = 0;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits += 1;
        const params = new URLSearchParams(body);
        onAssertion(params.get('assertion') ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: `tok_${hits}`, expires_in: ttl }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    return { url, hits: () => hits };
  }

  it('signs a valid JWT assertion with the right claims and returns the access token', async () => {
    let seen = '';
    const { url } = await tokenServer((jwt) => (seen = jwt));
    const provider = new GoogleServiceAccountTokenProvider(
      { clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKey: PRIVATE_PEM, tokenUri: url },
      { now: () => 1_000_000_000_000 },
    );

    const token = await provider.getToken();
    expect(token).toBe('tok_1');

    expect(verifyJwt(seen)).toBe(true); // signed by the SA private key
    const claims = decodeSegment(seen.split('.')[1] ?? '');
    expect(claims['iss']).toBe('sa@proj.iam.gserviceaccount.com');
    expect(claims['aud']).toBe(url);
    expect(claims['scope']).toBe('https://www.googleapis.com/auth/cloud-platform');
    expect(claims['exp']).toBe((claims['iat'] as number) + 3600);
  });

  it('caches the token until near expiry, then refreshes (single exchange while valid)', async () => {
    let t = 1_000_000_000_000;
    const { url, hits } = await tokenServer(() => {}, 3600);
    const provider = new GoogleServiceAccountTokenProvider(
      { clientEmail: 'sa@proj', privateKey: PRIVATE_PEM, tokenUri: url },
      { now: () => t, skewSeconds: 60 },
    );

    expect(await provider.getToken()).toBe('tok_1');
    expect(await provider.getToken()).toBe('tok_1'); // cached
    expect(hits()).toBe(1);

    t += 3600 * 1000; // past (expiry - skew)
    expect(await provider.getToken()).toBe('tok_2'); // refreshed
    expect(hits()).toBe(2);
  });

  it('shares one exchange across concurrent callers (single-flight)', async () => {
    const { url, hits } = await tokenServer(() => {});
    const provider = new GoogleServiceAccountTokenProvider({
      clientEmail: 'sa@proj',
      privateKey: PRIVATE_PEM,
      tokenUri: url,
    });
    const [a, b, c] = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(hits()).toBe(1); // one exchange, not three
  });

  it('parses a service-account JSON', () => {
    const p = GoogleServiceAccountTokenProvider.fromJson(
      JSON.stringify({
        client_email: 'x@proj',
        private_key: PRIVATE_PEM,
        token_uri: 'https://example/token',
      }),
    );
    expect(p).toBeInstanceOf(GoogleServiceAccountTokenProvider);
  });
});
