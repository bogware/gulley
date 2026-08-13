/**
 * Live RBAC + control-plane check. Boots the real control-api over HTTP with
 * in-memory stores and a headless break-glass bootstrap admin, then proves:
 *   (a) an owner can CRUD org→workspace→provider and the audit chain verifies;
 *   (b) deny-by-default — a viewer write is 403; a viewer's org list is filtered;
 *       an editor cannot write outside its org;
 *   (c) no privilege amplification — an admin cannot grant/mint an owner;
 *   (d) a minted virtual key resolves through the data-plane resolver, is shown
 *       without its token, and a tampered token fails closed.
 *
 *   pnpm --filter @gulley/control-api run rbac:check
 */
import { resolveVirtualKey } from '@gulley/auth';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

const PEPPER = 'rbac-check-pepper-at-least-16-chars';
const SESSION_SECRET = 'rbac-check-session-secret-32-chars-min!!';

async function main(): Promise<void> {
  const gadm = 'gadm_' + randomBytes(32).toString('base64url');
  const bootstrapSha = createHash('sha256').update(gadm).digest('hex');

  const ctx = createInMemoryControlContext({
    pepper: PEPPER,
    bootstrapEnabled: true,
    bootstrapTokenSha256: bootstrapSha,
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
  });

  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const call = async (
    method: string,
    path: string,
    token: string,
    payload?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  };

  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  try {
    // (a) owner CRUD ---------------------------------------------------------
    const org = await call('POST', '/orgs', gadm, { name: 'Acme' });
    if (org.status !== 201) fail(`owner create org: ${org.status}`);
    const orgId = (org.json['org'] as { id: string }).id;

    const other = await call('POST', '/orgs', gadm, { name: 'Other' });
    const otherOrgId = (other.json['org'] as { id: string }).id;

    const ws = await call('POST', '/workspaces', gadm, { orgId, name: 'Default' });
    if (ws.status !== 201) fail(`owner create workspace: ${ws.status}`);
    const wsId = (ws.json['workspace'] as { id: string }).id;

    const prov = await call('POST', '/providers', gadm, {
      workspaceId: wsId,
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    if (prov.status !== 201) fail(`owner create provider: ${prov.status}`);

    const verified = await call('GET', '/audit/verify', gadm);
    const chainOk = verified.json['verified'] === true && Number(verified.json['count']) >= 4;

    // mint viewer / editor / admin sessions (owner grants, no amplification) --
    const mint = async (role: string): Promise<string> => {
      const r = await call('POST', '/admin/sessions', gadm, {
        subject: `${role}@acme`,
        name: role,
        memberships: [{ role, orgId }],
      });
      if (r.status !== 201) fail(`mint ${role} session: ${r.status}`);
      return r.json['token'] as string;
    };
    const viewer = await mint('viewer');
    const editor = await mint('editor');
    const admin = await mint('admin');

    // (b) deny-by-default + scope filtering ----------------------------------
    const viewerWrite = await call('POST', '/workspaces', viewer, { orgId, name: 'nope' });
    const viewerList = await call('GET', '/orgs', viewer);
    const viewerOrgs = viewerList.json['orgs'] as Array<{ id: string }>;
    const editorInScope = await call('POST', '/workspaces', editor, { orgId, name: 'ws2' });
    const editorOutScope = await call('POST', '/workspaces', editor, {
      orgId: otherOrgId,
      name: 'x',
    });

    const denyOk =
      viewerWrite.status === 403 &&
      viewerOrgs.length === 1 &&
      viewerOrgs[0]?.id === orgId && // filtered — 'Other' absent
      editorInScope.status === 201 &&
      editorOutScope.status === 403;

    // (c) no amplification ---------------------------------------------------
    const adminGrantsOwner = await call('POST', '/memberships', admin, {
      userId: 'u1',
      role: 'owner',
      orgId,
    });
    const adminMintsOwner = await call('POST', '/admin/sessions', admin, {
      subject: 'esc',
      name: 'esc',
      memberships: [{ role: 'owner', orgId }],
    });
    const adminGrantsEditor = await call('POST', '/memberships', admin, {
      userId: 'u2',
      role: 'editor',
      orgId,
    });
    const noAmplify =
      adminGrantsOwner.status === 403 &&
      adminMintsOwner.status === 403 &&
      adminGrantsEditor.status === 201;

    // (d) key mint → resolve, redaction, tamper --------------------------------
    const key = await call('POST', '/keys', gadm, { workspaceId: wsId, name: 'ci' });
    if (key.status !== 201) fail(`mint key: ${key.status}`);
    const token = key.json['token'] as string;
    const keyId = key.json['id'] as string;

    const resolved = await resolveVirtualKey(
      { apiKey: token },
      { keyStore: ctx.keyStore, pepper: PEPPER },
    );
    const tamperedTok = token.slice(0, -3) + (token.endsWith('aaa') ? 'bbb' : 'aaa');
    const resolvedBad = await resolveVirtualKey(
      { apiKey: tamperedTok },
      { keyStore: ctx.keyStore, pepper: PEPPER },
    );
    const view = await call('GET', `/keys/${keyId}`, gadm);
    const keyView = view.json['key'] as Record<string, unknown>;
    const keyOk =
      resolved.ok &&
      resolved.value.id === keyId &&
      !resolvedBad.ok &&
      view.status === 200 &&
      !('token' in keyView) &&
      !('keyHash' in keyView);

    // final audit chain still intact after all writes
    const finalVerify = await call('GET', '/audit/verify', gadm);
    const finalChain = finalVerify.json['verified'] === true;

    process.stdout.write(
      `(a) owner CRUD + chain: ${chainOk}\n` +
        `(b) deny/filter/scope:  ${denyOk}\n` +
        `(c) no amplification:   ${noAmplify}\n` +
        `(d) key mint/resolve:   ${keyOk}\n` +
        `    audit chain final:  ${finalChain} (${finalVerify.json['count']} rows)\n`,
    );

    const pass = chainOk && denyOk && noAmplify && keyOk && finalChain;
    process.stdout.write(pass ? '✅ RBAC LIVE CHECK PASSED\n' : '❌ RBAC LIVE CHECK FAILED\n');
    if (!pass) throw new Error('one or more RBAC/control-plane behaviors did not hold');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
