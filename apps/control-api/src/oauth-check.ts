/**
 * Live OAuth broker check. Boots control-api + the broker over HTTP (in-memory
 * stores, real crypto, a simulated IdP — no Entra tenant needed) and proves:
 *   - device flow: pending poll -> admin consent -> tokens; token scope carries
 *     the client tenancy (org/workspace);
 *   - refresh rotates; reusing the superseded refresh token revokes the family;
 *   - a FORGED reuse token does not revoke an active family (no DoS);
 *   - /oauth/revoke needs cryptographic proof (a bogus token is a no-op 200);
 *   - PKCE auth-code: S256 verifier works, a wrong verifier fails, plain is
 *     rejected;
 *   - id_token JWS is ES256-pinned (alg:none / HS256 rejected).
 *
 *   pnpm --filter @gulley/control-api run oauth:check
 */
import {
  BrokerService,
  InMemoryAuthCodeStore,
  InMemoryDeviceCodeStore,
  InMemoryGrantStore,
  InMemoryOAuthClientStore,
  parseRefresh,
  pkceChallengeS256,
  SimulatedIdp,
  verifyEs256,
} from '@gulley/oauth';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { registerOAuthRoutes } from './oauth-routes';
import { buildServer } from './server';

const PEPPER = 'oauth-check-pepper-at-least-16chars';
const SESSION_SECRET = 'oauth-check-session-secret-32-chars!!!';

async function main(): Promise<void> {
  const gadm = 'gadm_' + randomBytes(32).toString('base64url');
  const ctx = createInMemoryControlContext({
    pepper: PEPPER,
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
  });

  const clients = new InMemoryOAuthClientStore();
  clients.add({
    clientId: 'claude-code',
    name: 'Claude Code',
    orgId: 'org_live',
    workspaceId: 'ws_live',
    grantTypes: ['device_code', 'authorization_code', 'refresh_token'],
    redirectAllowlist: ['/callback'],
    enabled: true,
  });
  const idp = new SimulatedIdp();
  void idp;
  const broker = new BrokerService(
    {
      pepper: PEPPER,
      accessTtlMs: 3_600_000,
      refreshTtlMs: 30 * 86_400_000,
      absoluteTtlMs: 90 * 86_400_000,
      deviceCodeTtlMs: 900_000,
      deviceIntervalMs: 0,
    },
    {
      grants: new InMemoryGrantStore(),
      devices: new InMemoryDeviceCodeStore(),
      codes: new InMemoryAuthCodeStore(),
      clients,
      idp,
    },
  );

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  registerOAuthRoutes(app, broker, ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const http = async (
    method: string,
    path: string,
    token: string | undefined,
    payload?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  const deviceIssue = async (): Promise<{ access: string; refresh: string; pending: string }> => {
    const da = await http('POST', '/oauth/device_authorization', undefined, {
      client_id: 'claude-code',
    });
    const deviceCode = da.json['device_code'] as string;
    const userCode = da.json['user_code'] as string;
    const pending = await http('POST', '/oauth/token', undefined, {
      grant_type: 'device_code',
      device_code: deviceCode,
      client_id: 'claude-code',
    });
    await http('POST', '/oauth/device/authorize', gadm, { user_code: userCode });
    const tok = await http('POST', '/oauth/token', undefined, {
      grant_type: 'device_code',
      device_code: deviceCode,
      client_id: 'claude-code',
    });
    return {
      access: tok.json['access_token'] as string,
      refresh: tok.json['refresh_token'] as string,
      pending: pending.json['error'] as string,
    };
  };

  try {
    // 1) device flow + tenancy ----------------------------------------------
    const fam1 = await deviceIssue();
    const p1 = await broker.resolveBrokerToken(fam1.access);
    const tenancyOk =
      p1.ok && p1.value.scope.orgId === 'org_live' && p1.value.scope.workspaceId === 'ws_live';
    const pendingOk = fam1.pending === 'authorization_pending';

    // 2) refresh rotate + superseded reuse revokes the family ----------------
    const rot = await http('POST', '/oauth/token', undefined, {
      grant_type: 'refresh_token',
      refresh_token: fam1.refresh,
      client_id: 'claude-code',
    });
    const reuse = await http('POST', '/oauth/token', undefined, {
      grant_type: 'refresh_token',
      refresh_token: fam1.refresh,
      client_id: 'claude-code',
    });
    const familyRevoked = (await broker.resolveBrokerToken(fam1.access)).ok === false;
    const reuseOk = rot.status === 200 && reuse.status === 400 && familyRevoked;

    // 3) forged reuse does NOT revoke an active (fresh) family ---------------
    const fam2 = await deviceIssue();
    const handle2 = parseRefresh(fam2.refresh)?.handle ?? '';
    const forged = await http('POST', '/oauth/token', undefined, {
      grant_type: 'refresh_token',
      refresh_token: `gko_rt_${handle2}.1.${'z'.repeat(43)}`,
      client_id: 'claude-code',
    });
    const forgedNoDos = forged.status === 400 && (await broker.resolveBrokerToken(fam2.access)).ok;

    // 4) revoke needs proof --------------------------------------------------
    const bogusRevoke = await http('POST', '/oauth/revoke', undefined, {
      token: `gko_rt_${handle2}.1.${'q'.repeat(43)}`,
    });
    const stillActive = (await broker.resolveBrokerToken(fam2.access)).ok;
    await http('POST', '/oauth/revoke', undefined, { token: fam2.access });
    const revokedNow = (await broker.resolveBrokerToken(fam2.access)).ok === false;
    const revokeOk = bogusRevoke.status === 200 && stillActive && revokedNow;

    // 5) PKCE auth-code ------------------------------------------------------
    const verifier = randomBytes(32).toString('base64url');
    const challenge = pkceChallengeS256(verifier);
    const redirect = 'http://127.0.0.1:5555/callback';
    const q = `client_id=claude-code&redirect_uri=${encodeURIComponent(redirect)}&state=st&code_challenge=${challenge}&code_challenge_method=S256`;
    const auth = await http('GET', `/oauth/authorize?${q}`, gadm);
    const code = auth.json['code'] as string;
    const good = await http('POST', '/oauth/token', undefined, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: 'claude-code',
    });
    const auth2 = await http('GET', `/oauth/authorize?${q}`, gadm);
    const bad = await http('POST', '/oauth/token', undefined, {
      grant_type: 'authorization_code',
      code: auth2.json['code'],
      code_verifier: 'wrong-verifier',
      redirect_uri: redirect,
      client_id: 'claude-code',
    });
    const plainQ = q.replace('code_challenge_method=S256', 'code_challenge_method=plain');
    const plain = await http('GET', `/oauth/authorize?${plainQ}`, gadm);
    const pkceOk = good.status === 200 && bad.status === 400 && plain.status === 400;

    // 6) id_token ES256 pinning ---------------------------------------------
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const sign = (alg: string): string => {
      const head = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'x', tid: 't' })).toString('base64url');
      if (alg === 'none') return `${head}.${payload}.`;
      const sig = createSign('SHA256')
        .update(`${head}.${payload}`)
        .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
      return `${head}.${payload}.${sig.toString('base64url')}`;
    };
    const jwsOk =
      verifyEs256(sign('ES256'), publicKey).ok &&
      !verifyEs256(sign('none'), publicKey).ok &&
      !verifyEs256(`${sign('HS256').split('.').slice(0, 2).join('.')}.zz`, publicKey).ok;

    process.stdout.write(
      `1 device+tenancy:   ${tenancyOk} (pending=${pendingOk})\n` +
        `2 rotate+reuse:     ${reuseOk}\n` +
        `3 forged no-DoS:    ${forgedNoDos}\n` +
        `4 revoke-on-proof:  ${revokeOk}\n` +
        `5 PKCE S256:        ${pkceOk}\n` +
        `6 ES256 alg-pin:    ${jwsOk}\n`,
    );

    const pass = tenancyOk && pendingOk && reuseOk && forgedNoDos && revokeOk && pkceOk && jwsOk;
    process.stdout.write(pass ? '✅ OAUTH LIVE CHECK PASSED\n' : '❌ OAUTH LIVE CHECK FAILED\n');
    if (!pass) throw new Error('one or more OAuth broker behaviors did not hold');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
