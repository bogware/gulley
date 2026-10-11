/**
 * Workload identity → gateway token (`gulley token exchange`): the client side of the
 * broker's RFC 7523 JWT-bearer grant. A Kubernetes pod presents its projected
 * service-account token, a GitHub Actions job its OIDC token (minted on demand from
 * the runner's `ACTIONS_ID_TOKEN_REQUEST_URL`), and the control plane hands back a
 * short-lived, scoped, access-only `gko_at_` token for the matching federation's
 * service principal. No credential is stored; the assertion is never printed.
 */
import { type BrokerEndpoints, OAuthFlowError, postForm } from './device-login';

export const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Where a Kubernetes projected service-account token is mounted by default. */
export const K8S_SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

export interface ExchangedToken {
  accessToken: string;
  /** Seconds, as reported by the broker. */
  expiresIn: number;
}

/** POST the assertion to the broker's token endpoint (form-encoded, RFC 7523 §2.1). */
export async function exchangeJwtBearer(
  endpoints: Pick<BrokerEndpoints, 'tokenEndpoint'>,
  params: { assertion: string; clientId?: string },
  fetchImpl: typeof fetch,
): Promise<ExchangedToken> {
  const { status, body } = await postForm(fetchImpl, endpoints.tokenEndpoint, {
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion: params.assertion,
    ...(params.clientId ? { client_id: params.clientId } : {}),
  });
  if (status === 200) {
    const accessToken = body['access_token'];
    const expiresIn = body['expires_in'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new OAuthFlowError('server_error', 'token response missing access_token');
    }
    return {
      accessToken,
      expiresIn: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600,
    };
  }
  const code = typeof body['error'] === 'string' ? (body['error'] as string) : 'server_error';
  // Never include the assertion in a message: it is a bearer credential.
  const why: Record<string, string> = {
    invalid_grant:
      'the broker rejected the assertion — it is not from a configured issuer, its subject matches no federation, its audience is not the broker, or it is expired/replayed (check WORKLOAD_FEDERATIONS and the token audience)',
    unsupported_grant_type:
      'the broker has no workload federations configured (WORKLOAD_FEDERATIONS) — the jwt-bearer grant is off',
    invalid_client:
      'the named client is unknown, disabled, lacks the jwt-bearer grant type, or is in another workspace than the federation',
    rate_limited: 'the broker is rate-limiting token exchanges from this address — retry later',
  };
  throw new OAuthFlowError(code, why[code] ?? `token exchange failed (${status}): ${code}`);
}

/**
 * Mint a GitHub Actions OIDC token for `audience` from the runner's token service
 * (`permissions: id-token: write` exposes ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN to the job).
 */
export async function fetchGithubIdToken(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  audience: string,
): Promise<string> {
  const requestUrl = env['ACTIONS_ID_TOKEN_REQUEST_URL'];
  const requestToken = env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  if (!requestUrl || !requestToken) {
    throw new OAuthFlowError(
      'github_oidc',
      'ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN are not set — add `permissions: id-token: write` to the job',
    );
  }
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);
  const res = await fetchImpl(url.toString(), {
    headers: { authorization: `bearer ${requestToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new OAuthFlowError('github_oidc', `GitHub OIDC token request failed (${res.status})`);
  }
  const body = (await res.json()) as { value?: unknown };
  if (typeof body.value !== 'string' || body.value.length === 0) {
    throw new OAuthFlowError('github_oidc', 'GitHub OIDC token response carried no value');
  }
  return body.value;
}
