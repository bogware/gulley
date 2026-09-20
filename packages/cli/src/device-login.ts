/**
 * OAuth 2.0 client side of the Gulley broker, as a coding harness uses it:
 *
 *   - RFC 8414 discovery (`/.well-known/oauth-authorization-server`) with a
 *     conventional fallback to `<broker>/oauth/*`;
 *   - RFC 8628 device authorization grant (`gulley login`): request a code, show the
 *     user the verification URL, poll the token endpoint honoring `interval` and
 *     `slow_down`;
 *   - refresh-token rotation (`gulley token`) and revocation (`gulley logout`).
 *
 * Every token-endpoint request is `application/x-www-form-urlencoded` (RFC 6749
 * §4.1.3 / RFC 8628 §3.4) — the wire format every standards-conformant client and
 * proxy expects. Pure over an injected `fetch`/`sleep`/`now` so it is unit-tested with
 * a scripted broker.
 */

export interface BrokerEndpoints {
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  introspectionEndpoint: string;
}

export interface TokenSet {
  accessToken: string;
  /** Seconds, as reported by the broker. */
  expiresIn: number;
  refreshToken: string;
}

export class OAuthFlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

export interface FlowDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Per-request deadline for every broker call. The agent's token helper runs on the
 *  hot path of a coding session; a stalled broker must fail fast, not hang it. */
export const BROKER_REQUEST_TIMEOUT_MS = 10_000;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS)
    : undefined;
}

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

/** Resolve the broker's endpoints. Discovery is best-effort: a broker that does not
 *  publish RFC 8414 metadata is addressed by Gulley's conventional paths. */
export async function discoverBroker(
  brokerUrl: string,
  fetchImpl: typeof fetch,
): Promise<BrokerEndpoints> {
  const base = trimUrl(brokerUrl);
  const fallback: BrokerEndpoints = {
    issuer: base,
    deviceAuthorizationEndpoint: `${base}/oauth/device_authorization`,
    tokenEndpoint: `${base}/oauth/token`,
    revocationEndpoint: `${base}/oauth/revoke`,
    introspectionEndpoint: `${base}/oauth/introspect`,
  };
  try {
    const res = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, {
      headers: { accept: 'application/json' },
      signal: timeoutSignal(),
    });
    if (!res.ok) return fallback;
    const meta = (await res.json()) as Record<string, unknown>;
    const s = (k: string): string | undefined =>
      typeof meta[k] === 'string' && (meta[k] as string).length > 0
        ? (meta[k] as string)
        : undefined;
    return {
      issuer: s('issuer') ?? fallback.issuer,
      deviceAuthorizationEndpoint:
        s('device_authorization_endpoint') ?? fallback.deviceAuthorizationEndpoint,
      tokenEndpoint: s('token_endpoint') ?? fallback.tokenEndpoint,
      revocationEndpoint: s('revocation_endpoint') ?? fallback.revocationEndpoint,
      introspectionEndpoint: s('introspection_endpoint') ?? fallback.introspectionEndpoint,
    };
  } catch {
    return fallback;
  }
}

async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(fields).toString(),
    signal: timeoutSignal(),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { error: 'server_error', error_description: text.slice(0, 200) };
    }
  }
  return { status: res.status, body };
}

function toTokenSet(body: Record<string, unknown>): TokenSet {
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  const expiresIn = body['expires_in'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new OAuthFlowError('server_error', 'token response missing access/refresh token');
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600,
  };
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export async function requestDeviceAuthorization(
  endpoints: BrokerEndpoints,
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<DeviceAuthorization> {
  const { status, body } = await postForm(fetchImpl, endpoints.deviceAuthorizationEndpoint, {
    client_id: clientId,
  });
  if (status !== 200) {
    const code = typeof body['error'] === 'string' ? (body['error'] as string) : 'server_error';
    throw new OAuthFlowError(
      code,
      code === 'invalid_client'
        ? `the broker does not know client "${clientId}" (or it lacks the device_code grant) — an admin registers it in the console (Identity → OAuth broker)`
        : `device authorization failed (${status}): ${code}`,
    );
  }
  const deviceCode = body['device_code'];
  const userCode = body['user_code'];
  const verificationUri = body['verification_uri'];
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string'
  ) {
    throw new OAuthFlowError('server_error', 'malformed device authorization response');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete:
      typeof body['verification_uri_complete'] === 'string'
        ? (body['verification_uri_complete'] as string)
        : undefined,
    expiresIn: typeof body['expires_in'] === 'number' ? (body['expires_in'] as number) : 900,
    interval: typeof body['interval'] === 'number' ? (body['interval'] as number) : 5,
  };
}

/** Poll the token endpoint until the user approves, denies, or the code expires.
 *  `authorization_pending` waits `interval`; `slow_down` adds 5s (RFC 8628 §3.5). */
export async function pollDeviceToken(
  endpoints: BrokerEndpoints,
  clientId: string,
  auth: DeviceAuthorization,
  deps: FlowDeps,
): Promise<TokenSet> {
  let intervalMs = Math.max(1, auth.interval) * 1000;
  const deadline = deps.now() + auth.expiresIn * 1000;
  let networkErrors = 0;
  for (;;) {
    await deps.sleep(intervalMs);
    if (deps.now() > deadline) {
      throw new OAuthFlowError('expired_token', 'the device code expired before approval');
    }
    let polled: { status: number; body: Record<string, unknown> };
    try {
      polled = await postForm(deps.fetch, endpoints.tokenEndpoint, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: auth.deviceCode,
        client_id: clientId,
      });
      networkErrors = 0;
    } catch (err) {
      // A transient network blip while the user is at the consent page must not
      // abort the login: keep polling inside the code's lifetime (bounded).
      networkErrors += 1;
      if (networkErrors >= 6) {
        throw new OAuthFlowError(
          'network_error',
          `the broker is unreachable (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      continue;
    }
    const { status, body } = polled;
    if (status === 200) return toTokenSet(body);
    const code = typeof body['error'] === 'string' ? (body['error'] as string) : 'server_error';
    switch (code) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5000;
        continue;
      case 'access_denied':
        throw new OAuthFlowError(code, 'the request was denied at the consent page');
      case 'expired_token':
        throw new OAuthFlowError(code, 'the device code expired before approval');
      default:
        throw new OAuthFlowError(code, `token request failed (${status}): ${code}`);
    }
  }
}

export async function refreshAccessToken(
  endpoints: BrokerEndpoints,
  clientId: string,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const { status, body } = await postForm(fetchImpl, endpoints.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (status === 200) return toTokenSet(body);
  const code = typeof body['error'] === 'string' ? (body['error'] as string) : 'server_error';
  throw new OAuthFlowError(
    code,
    code === 'invalid_grant'
      ? 'the session is no longer valid (expired, revoked, or rotated elsewhere) — run `gulley login`'
      : `refresh failed (${status}): ${code}`,
  );
}

/** Best-effort revocation. Returns whether the broker acknowledged it (a 2xx): the
 *  local credential is deleted regardless, but the caller can say honestly whether
 *  the family is dead server-side or will only expire on its own. */
export async function revokeToken(
  endpoints: BrokerEndpoints,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const { status } = await postForm(fetchImpl, endpoints.revocationEndpoint, { token });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

/**
 * RFC 7662 introspection of the access token we hold: `false` only on a definitive
 * `{active:false}`; `true` when active; `undefined` when the broker cannot say
 * (network error, no such endpoint) so the caller keeps trusting its cached token
 * rather than failing the agent on a transient blip.
 */
export async function introspectAccessToken(
  endpoints: BrokerEndpoints,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean | undefined> {
  try {
    const { status, body } = await postForm(fetchImpl, endpoints.introspectionEndpoint, { token });
    if (status !== 200 || typeof body['active'] !== 'boolean') return undefined;
    return body['active'] as boolean;
  } catch {
    return undefined;
  }
}
