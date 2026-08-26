import { createSign } from 'node:crypto';

/**
 * Mints Google OAuth2 access tokens from a service account, for native Vertex AI
 * calls (Vertex authenticates with a short-lived Bearer access token, not an API
 * key). Implements the self-signed-JWT → token-exchange grant
 * (`urn:ietf:params:oauth:grant-type:jwt-bearer`): sign a JWT with the SA private
 * key, POST it to the token endpoint, cache the returned access token until just
 * before it expires.
 *
 * Injectable `fetchImpl` + `now` make it fully testable against a fake token
 * endpoint with no real Google credentials.
 */
export interface ServiceAccount {
  clientEmail: string;
  /** PEM PKCS#8 private key (the SA JSON's `private_key`). */
  privateKey: string;
  /** Token endpoint (SA JSON `token_uri`); default Google's. */
  tokenUri?: string;
}

export interface GoogleTokenProviderOptions {
  scope?: string;
  /** Refresh this many seconds before actual expiry (clock-skew guard). */
  skewSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class GoogleServiceAccountTokenProvider {
  private readonly tokenUri: string;
  private readonly scope: string;
  private readonly skewSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached?: { token: string; expiresAtMs: number };
  /** Single-flight so concurrent callers share one token exchange. */
  private inflight?: Promise<string>;

  constructor(
    private readonly sa: ServiceAccount,
    opts: GoogleTokenProviderOptions = {},
  ) {
    this.tokenUri = sa.tokenUri ?? DEFAULT_TOKEN_URI;
    this.scope = opts.scope ?? CLOUD_PLATFORM_SCOPE;
    this.skewSeconds = opts.skewSeconds ?? 60;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Parse a standard service-account JSON (as from GOOGLE_APPLICATION_CREDENTIALS). */
  static fromJson(
    json: string,
    opts: GoogleTokenProviderOptions = {},
  ): GoogleServiceAccountTokenProvider {
    const o = JSON.parse(json) as Record<string, unknown>;
    const clientEmail = o['client_email'];
    const privateKey = o['private_key'];
    if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
      throw new Error('service account JSON missing client_email/private_key');
    }
    return new GoogleServiceAccountTokenProvider(
      {
        clientEmail,
        privateKey,
        tokenUri: typeof o['token_uri'] === 'string' ? o['token_uri'] : undefined,
      },
      opts,
    );
  }

  private signAssertion(): string {
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + 3600;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: this.sa.clientEmail,
        scope: this.scope,
        aud: this.tokenUri,
        iat,
        exp,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = base64url(
      createSign('RSA-SHA256').update(signingInput).end().sign(this.sa.privateKey),
    );
    return `${signingInput}.${signature}`;
  }

  private async exchange(signal?: AbortSignal): Promise<string> {
    const assertion = this.signAssertion();
    const res = await this.fetchImpl(this.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`google token exchange failed: ${res.status} ${detail}`.trim());
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') {
      throw new Error('google token exchange returned no access_token');
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.cached = {
      token: body.access_token,
      expiresAtMs: this.now() + Math.max(0, ttl - this.skewSeconds) * 1000,
    };
    return body.access_token;
  }

  /** A valid access token, minting/refreshing one as needed (single-flight). */
  async getToken(signal?: AbortSignal): Promise<string> {
    if (this.cached && this.cached.expiresAtMs > this.now()) return this.cached.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.exchange(signal).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
}
