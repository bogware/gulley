/**
 * Live config / GitOps check (in-memory; no DB this session). Boots control-api,
 * seeds a config over the admin API, then proves:
 *   (a) round-trip fidelity — applying the exported doc leaves content unchanged;
 *   (b) virtual keys are never touched by reconcile (apply with virtualKeys:[]
 *       still leaves the minted key resolvable);
 *   (c) a provider endpoint pointing at IMDS is rejected (422 egress);
 *   (d) an inline secret in a route config is rejected (422 inline_secret);
 *   (e) optimistic concurrency — two applies at the same base version: one 200,
 *       one 409;
 *   (f) revert works — re-applying earlier content succeeds (content hash reused).
 *
 *   pnpm --filter @gulley/control-api run config:check
 */
import { resolveVirtualKey } from '@gulley/auth';
import { contentHash, type ConfigDocument } from '@gulley/config';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

const PEPPER = 'config-check-pepper-at-least-16chars';
const SESSION_SECRET = 'config-check-session-secret-32-chars!!';

async function main(): Promise<void> {
  const gadm = 'gadm_' + randomBytes(32).toString('base64url');
  const ctx = createInMemoryControlContext({
    pepper: PEPPER,
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
  });
  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const call = async (
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const version = async (): Promise<number> =>
    Number((await call('GET', '/config/versions')).json['version']);

  try {
    // seed via the admin API
    const orgId = ((await call('POST', '/orgs', { name: 'Acme' })).json['org'] as { id: string })
      .id;
    const wsId = (
      (await call('POST', '/workspaces', { orgId, name: 'Default' })).json['workspace'] as {
        id: string;
      }
    ).id;
    await call('POST', '/providers', {
      workspaceId: wsId,
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    await call('POST', '/routes', {
      workspaceId: wsId,
      name: 'default',
      config: { model: 'haiku' },
    });
    const keyToken = (await call('POST', '/keys', { workspaceId: wsId, name: 'ci' })).json[
      'token'
    ] as string;

    const D0 = (await call('GET', '/config/export')).json['document'] as ConfigDocument;
    const clone = (): ConfigDocument => JSON.parse(JSON.stringify(D0)) as ConfigDocument;

    // (c) egress reject + (d) inline-secret reject (version stays 0) ----------
    const egressDoc = clone();
    egressDoc.orgs[0]!.workspaces[0]!.providers[0]!.baseUrl = 'http://169.254.169.254/';
    const egress = await call('POST', '/config/apply', { document: egressDoc, baseVersion: 0 });

    const secretDoc = clone();
    secretDoc.orgs[0]!.workspaces[0]!.routes[0]!.config = { keyHash: 'a'.repeat(64) };
    const secret = await call('POST', '/config/apply', { document: secretDoc, baseVersion: 0 });

    // (a) round-trip: apply the exported doc, content unchanged ---------------
    const applyD0 = await call('POST', '/config/apply', {
      document: D0,
      baseVersion: await version(),
    });
    const roundTripOk = applyD0.status === 200 && applyD0.json['contentHash'] === contentHash(D0);

    // (b) virtual-key non-deletion -------------------------------------------
    const noKeys = clone();
    noKeys.orgs[0]!.workspaces[0]!.virtualKeys = [];
    await call('POST', '/config/apply', { document: noKeys, baseVersion: await version() });
    const keyStillResolves = (
      await resolveVirtualKey({ apiKey: keyToken }, { keyStore: ctx.keyStore, pepper: PEPPER })
    ).ok;

    // (e) optimistic concurrency ---------------------------------------------
    const baseV = await version();
    const [a, b] = await Promise.all([
      call('POST', '/config/apply', { document: D0, baseVersion: baseV }),
      call('POST', '/config/apply', { document: D0, baseVersion: baseV }),
    ]);
    const statuses = [a.status, b.status].sort();
    const concurrencyOk = statuses[0] === 200 && statuses[1] === 409;

    // (f) revert: mutate then re-apply the original content ------------------
    const mutated = clone();
    mutated.orgs[0]!.workspaces[0]!.routes[0]!.config = { model: 'sonnet' };
    const applyMut = await call('POST', '/config/apply', {
      document: mutated,
      baseVersion: await version(),
    });
    const revert = await call('POST', '/config/apply', {
      document: D0,
      baseVersion: await version(),
    });
    const revertOk =
      applyMut.status === 200 &&
      revert.status === 200 &&
      revert.json['contentHash'] === contentHash(D0);

    // drift is report-only + starts clean after an apply
    const drift = (await call('GET', '/config/drift')).json;

    process.stdout.write(
      `(a) round-trip:       ${roundTripOk}\n` +
        `(b) key non-deletion: ${keyStillResolves}\n` +
        `(c) egress reject:    ${egress.status === 422} (${(egress.json['error'] as { kind?: string })?.kind})\n` +
        `(d) inline-secret:    ${secret.status === 422} (${(secret.json['error'] as { kind?: string })?.kind})\n` +
        `(e) concurrency:      ${concurrencyOk} [${statuses.join(',')}]\n` +
        `(f) revert:           ${revertOk}\n` +
        `    drift.drifted:    ${drift['drifted']}\n`,
    );

    const pass =
      roundTripOk &&
      keyStillResolves &&
      egress.status === 422 &&
      secret.status === 422 &&
      concurrencyOk &&
      revertOk;
    process.stdout.write(
      pass ? '✅ CONFIG GITOPS CHECK PASSED\n' : '❌ CONFIG GITOPS CHECK FAILED\n',
    );
    process.stdout.write('⏭ WORM / Postgres immutability: DEFERRED (no database this session)\n');
    if (!pass) throw new Error('one or more config/GitOps behaviors did not hold');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
