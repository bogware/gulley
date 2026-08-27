import { createHash, randomBytes } from 'node:crypto';
import { type ConfigSignal, InMemoryConfigBus } from '@gulley/storage';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { ControlConfigStore } from './config-store';
import { buildServer } from './server';

let app: FastifyInstance;
let gadm: string;
let bus: InMemoryConfigBus;
let signals: ConfigSignal[];

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  bus = new InMemoryConfigBus();
  signals = [];
  bus.onSignal((s) => signals.push(s));
  await bus.start();
  const ctx = createInMemoryControlContext({
    pepper: 'config-routes-pepper-16chars!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['config-routes-session-secret-32bytes-long'],
    maxSessionTtlMs: 900_000,
    notifier: bus,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
});

afterEach(async () => {
  await app.close();
});

describe('POST /config/apply broadcast', () => {
  it('emits a post-commit config signal to the bus on a successful apply', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/config/apply',
      headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        document: { apiVersion: 'gulley/v1', orgs: [] },
        baseVersion: 0,
      }),
    });
    expect(res.statusCode).toBe(200);
    const bodyOut = res.json() as { version: number; contentHash: string };
    expect(bodyOut.version).toBe(1);

    // The signal fired AFTER the commit, carries the new version + hash + an origin.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ v: 1, hash: bodyOut.contentHash });
    expect(signals[0]?.origin).toBeTruthy();
  });

  it('does not emit when the apply is rejected (stale baseVersion)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/config/apply',
      headers: { authorization: `Bearer ${gadm}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        document: { apiVersion: 'gulley/v1', orgs: [] },
        baseVersion: 99, // != current (0) → stale
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(signals).toHaveLength(0); // no broadcast on a failed write
  });
});

describe('ControlConfigStore smartRoutingPolicies round-trip (M15)', () => {
  const mkStore = () =>
    new ControlConfigStore(
      createInMemoryControlContext({
        pepper: 'control-store-test-pepper-16!!!!',
        bootstrapEnabled: false,
        sessionSecrets: ['control-store-session-secret-32bytes-ok'],
        maxSessionTtlMs: 900_000,
      }),
    );
  const ws = (over: Record<string, unknown> = {}) => ({
    name: 'w',
    providers: [],
    routes: [],
    policies: [],
    budgets: [],
    rateLimits: [],
    guardrails: [],
    modelAliases: [],
    virtualKeys: [],
    ...over,
  });
  const doc = (over: Record<string, unknown> = {}) =>
    ({ apiVersion: 'gulley/v1', orgs: [{ name: 'o', workspaces: [ws(over)] }] }) as never;
  const policy = {
    name: 'p',
    config: {
      objective: 'cost-tier',
      classifier: { mode: 'rules-then-llm' },
      categoryRoutes: { cheap: 'x' },
      selector: {},
    },
  };

  it('round-trips a policy, prunes by absence, and omits the collection when empty', async () => {
    const store = mkStore();
    await store.reconcile(doc({ smartRoutingPolicies: [policy] }));
    let exported = await store.exportDocument('*');
    expect(exported.orgs[0]?.workspaces[0]?.smartRoutingPolicies?.[0]?.name).toBe('p');

    // Re-apply without the collection → prune by absence, and the key is omitted.
    await store.reconcile(doc());
    exported = await store.exportDocument('*');
    expect(exported.orgs[0]?.workspaces[0]?.smartRoutingPolicies).toBeUndefined();
  });
});
