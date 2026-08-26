/**
 * Live DURABLE config check — exercises PostgresConfigStore +
 * PostgresConfigVersionStore against a real Postgres (docker-compose), which CI
 * cannot run. Requires DATABASE_URL and applied migrations. Proves:
 *   (a) apply persists to the Postgres tables the gateway reads;
 *   (b) round-trip fidelity — the exported doc's content hash equals the applied
 *       doc's, and provider credentials survive as ARN references;
 *   (c) upsert-then-prune — a second apply updates a route, adds a guardrail, and
 *       prunes a removed provider (its credential cascades away);
 *   (d) optimistic concurrency — two applies at the same base version: one 200,
 *       one 409.
 *
 *   DATABASE_URL=postgres://gulley:gulley@localhost:5432/gulley \
 *     pnpm --filter @gulley/control-api run config:db:check
 */
import { contentHash, type ConfigDocument } from '@gulley/config';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

const PEPPER = 'config-db-check-pepper-16chars!!';
const SESSION_SECRET = 'config-db-check-session-secret-32chars!';
const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic-live';

function ok(label: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error(
      'DATABASE_URL required (point at a docker-compose Postgres with migrations applied)',
    );
    process.exit(2);
  }
  const gadm = 'gadm_' + randomBytes(32).toString('base64url');
  const ctx = createInMemoryControlContext({
    pepper: PEPPER,
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: [SESSION_SECRET],
    maxSessionTtlMs: 900_000,
    databaseUrl,
  });
  const app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  await app.ready();
  const H = { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' };

  const org = `acme-${randomBytes(4).toString('hex')}`;
  const doc = (
    over: Partial<ConfigDocument['orgs'][number]['workspaces'][number]> = {},
  ): ConfigDocument => ({
    apiVersion: 'gulley/v1',
    orgs: [
      {
        name: org,
        workspaces: [
          {
            name: 'prod',
            providers: [
              {
                kind: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                enabled: true,
                credential: { secretArn: ARN, secretVersion: 'v1' } as never,
              },
            ],
            routes: [{ name: 'default', config: { strategy: 'single' } }],
            policies: [],
            budgets: [{ name: 'default', config: { capMicroUsd: 1_000_000 } }],
            rateLimits: [],
            guardrails: [],
            modelAliases: [],
            virtualKeys: [],
            ...over,
          },
        ],
      },
    ],
  });

  const apply = async (document: ConfigDocument, baseVersion: number) =>
    app.inject({
      method: 'POST',
      url: '/config/apply',
      headers: H,
      payload: JSON.stringify({ document, baseVersion }),
    });
  const currentVersion = async (): Promise<number> =>
    (await app.inject({ method: 'GET', url: '/config/versions', headers: H }).then((r) => r.json()))
      .version;

  // (a)+(b) apply, then export and compare content hashes.
  const v0 = await currentVersion();
  const r1 = await apply(doc(), v0);
  ok('apply persists (200)', r1.statusCode === 200);
  const exported = (await app
    .inject({ method: 'GET', url: '/config/export', headers: H })
    .then((r) => r.json())) as { document: ConfigDocument };
  // Filter the export to just our org for a stable comparison.
  const mine: ConfigDocument = {
    apiVersion: 'gulley/v1',
    orgs: exported.document.orgs.filter((o) => o.name === org),
  };
  ok('round-trip content hash matches', contentHash(mine) === contentHash(doc()));
  ok(
    'credential survives as an ARN reference',
    mine.orgs[0]?.workspaces[0]?.providers[0]?.credential?.secretArn === ARN,
  );

  // (c) upsert-then-prune.
  const v1 = await currentVersion();
  await apply(
    doc({
      providers: [],
      routes: [{ name: 'default', config: { strategy: 'fallback' } }],
      guardrails: [{ name: 'g', config: { action: 'block' } }],
    }),
    v1,
  );
  const after = (await app
    .inject({ method: 'GET', url: '/config/export', headers: H })
    .then((r) => r.json())) as { document: ConfigDocument };
  const ws = after.document.orgs.find((o) => o.name === org)?.workspaces[0];
  ok('provider pruned', (ws?.providers.length ?? -1) === 0);
  ok('route updated', ws?.routes[0]?.config?.['strategy'] === 'fallback');
  ok('guardrail created', ws?.guardrails.some((g) => g.name === 'g') === true);

  // (d) optimistic concurrency.
  const v2 = await currentVersion();
  const [a, b] = await Promise.all([apply(doc(), v2), apply(doc(), v2)]);
  const codes = [a.statusCode, b.statusCode].sort();
  ok('concurrent applies: one 200, one 409', codes[0] === 200 && codes[1] === 409);

  await app.close();
  console.log(process.exitCode ? '\nFAILED' : '\nOK — durable config store verified');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
