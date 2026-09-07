import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import {
  createInMemoryControlContext,
  type ControlContext,
  type InMemoryContextOptions,
} from './context';
import type { EvalCase, EvalResult } from './eval-rollout';
import type { EvalRunner } from './eval-runner';
import type { RolloutPromoter } from './eval-rollout-routes';
import { buildServer } from './server';

const OK: EvalResult = {
  outputText: '4',
  stopReason: 'end_turn',
  inputTokens: 5,
  outputTokens: 1,
  costMicroUsd: 100,
  latencyMs: 50,
  guardrailFlagged: false,
};

/** Fake runner: a per-model function returns the result for a case. */
class FakeRunner implements EvalRunner {
  constructor(private readonly fn: (model: string, c: EvalCase) => EvalResult) {}
  async run(model: string, c: EvalCase): Promise<EvalResult> {
    return this.fn(model, c);
  }
}

const SUITE = {
  name: 'math',
  cases: [
    {
      id: 'add',
      request: { messages: [{ role: 'user', content: 'what is 2+2? reply with the number only' }] },
      scorers: [{ scorer: { kind: 'contains', text: '4' } }],
    },
  ],
};

let app: FastifyInstance;
let ctx: ControlContext;
let gadm: string;
let orgId: string;
let workspaceId: string;
let promoterCalls: number;

const post = (url: string, payload: unknown, token = gadm) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
const get = (url: string, token = gadm) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

async function build(over: Partial<InMemoryContextOptions> = {}) {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  promoterCalls = 0;
  const stubPromoter: RolloutPromoter = async () => {
    promoterCalls += 1;
    return { ok: true, version: 7 };
  };
  ctx = createInMemoryControlContext({
    pepper: 'eval-rollout-pepper-16chars!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['eval-rollout-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
    evalRunner: new FakeRunner(() => OK),
    rolloutPromoter: stubPromoter,
    ...over,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  orgId = ((await post('/orgs', { name: 'Acme' }).then((r) => r.json())) as { org: { id: string } })
    .org.id;
  workspaceId = (
    (await post('/workspaces', { orgId, name: 'prod' }).then((r) => r.json())) as {
      workspace: { id: string };
    }
  ).workspace.id;
}

async function makeSuite(): Promise<string> {
  const r = await post('/admin/eval-suites', SUITE);
  return (r.json() as { suite: { id: string } }).suite.id;
}
async function makeRollout(suiteId: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await post('/admin/rollouts', {
    suiteId,
    workspaceId,
    alias: 'default',
    fromModel: 'model-old',
    toModel: 'model-new',
    ...over,
  });
  return (r.json() as { rollout: { id: string } }).rollout.id;
}

afterEach(async () => {
  await app.close();
});

describe('eval-rollout: suites', () => {
  beforeEach(() => build());

  it('creates, lists, gets, and deletes a suite', async () => {
    const id = await makeSuite();
    expect(id).toMatch(/^es_/);
    expect((await get('/admin/eval-suites').then((r) => r.json())).suites).toHaveLength(1);
    expect((await get(`/admin/eval-suites/${id}`)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/admin/eval-suites/${id}`,
          headers: { authorization: `Bearer ${gadm}` },
        })
      ).statusCode,
    ).toBe(200);
    expect((await get(`/admin/eval-suites/${id}`)).statusCode).toBe(404);
  });

  it('rejects a malformed scorer (fails closed)', async () => {
    const r = await post('/admin/eval-suites', {
      name: 'bad',
      cases: [
        {
          id: 'x',
          request: { messages: [{ role: 'user', content: 'hi' }] },
          scorers: [{ scorer: { kind: 'nonsense' } }],
        },
      ],
    });
    expect(r.statusCode).toBe(422);
  });
});

describe('eval-rollout: run + gate', () => {
  beforeEach(() => build());

  it('promotes when the candidate clears the gate', async () => {
    const suiteId = await makeSuite();
    const id = await makeRollout(suiteId);
    const r = await post(`/admin/rollouts/${id}/run`, {});
    expect(r.statusCode).toBe(200);
    const rollout = (
      r.json() as {
        rollout: { status: string; appliedVersion?: number; report: { decision: string } };
      }
    ).rollout;
    expect(rollout.report.decision).toBe('promote');
    expect(rollout.status).toBe('promoted');
    expect(rollout.appliedVersion).toBe(7);
    expect(promoterCalls).toBe(1);
    // Audited as rollout.promoted.
    const rows = (await ctx.auditRows?.()) ?? [];
    expect(rows.some((x) => x.action === 'rollout.promoted' && x.target === id)).toBe(true);
  });

  it('holds (no promote) when the candidate regresses', async () => {
    await app.close();
    // Candidate fails the 'contains 4' scorer; incumbent passes.
    await build({
      evalRunner: new FakeRunner((model) =>
        model === 'model-new' ? { ...OK, outputText: 'four' } : OK,
      ),
    });
    const suiteId = await makeSuite();
    const id = await makeRollout(suiteId);
    const r = await post(`/admin/rollouts/${id}/run`, {});
    const rollout = (r.json() as { rollout: { status: string; report: { decision: string } } })
      .rollout;
    expect(rollout.report.decision).toBe('hold');
    expect(rollout.status).toBe('held');
    expect(promoterCalls).toBe(0); // never promoted
    const rows = (await ctx.auditRows?.()) ?? [];
    expect(rows.some((x) => x.action === 'rollout.held' && x.target === id)).toBe(true);
  });

  it('501s the run when no eval runner is wired', async () => {
    await app.close();
    await build({ evalRunner: undefined });
    const suiteId = await makeSuite();
    const id = await makeRollout(suiteId);
    expect((await post(`/admin/rollouts/${id}/run`, {})).statusCode).toBe(501);
  });

  it('422s a rollout whose suite is unknown, and one with equal from/to models', async () => {
    const suiteId = await makeSuite();
    expect(
      (
        await post('/admin/rollouts', {
          suiteId: 'nope',
          workspaceId,
          alias: 'default',
          fromModel: 'a',
          toModel: 'b',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await post('/admin/rollouts', {
          suiteId,
          workspaceId,
          alias: 'default',
          fromModel: 'a',
          toModel: 'a',
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe('eval-rollout: RBAC', () => {
  beforeEach(() => build());

  it('forbids a non-owner from writing a suite or running a rollout', async () => {
    const sess = (await post('/admin/sessions', {
      memberships: [{ role: 'editor', orgId, workspaceId }],
    }).then((r) => r.json())) as { token: string };
    expect((await post('/admin/eval-suites', SUITE, sess.token)).statusCode).toBe(403);
    const suiteId = await makeSuite(); // owner creates
    const id = await makeRollout(suiteId);
    expect((await post(`/admin/rollouts/${id}/run`, {}, sess.token)).statusCode).toBe(403);
  });

  it('401s without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/eval-suites' })).statusCode).toBe(401);
  });
});

describe('eval-rollout: real promoter repoints the alias via config-apply', () => {
  // No injected promoter → the real buildRolloutPromoter(ctx) runs the config-apply path.
  beforeEach(() => build({ rolloutPromoter: undefined }));

  it('promote actually creates/repoints the model alias in the durable config', async () => {
    const suiteId = await makeSuite();
    const id = await makeRollout(suiteId, { alias: 'fast', toModel: 'claude-sonnet-4-6' });
    const r = await post(`/admin/rollouts/${id}/run`, {});
    expect(r.statusCode).toBe(200);
    expect((r.json() as { rollout: { status: string } }).rollout.status).toBe('promoted');

    // The exported config now carries the repointed alias.
    const doc = (await get('/config/export').then((x) => x.json())) as {
      document: {
        orgs: Array<{
          workspaces: Array<{
            name: string;
            modelAliases: Array<{ name: string; config: Record<string, unknown> }>;
          }>;
        }>;
      };
    };
    const ws = doc.document.orgs.flatMap((o) => o.workspaces).find((w) => w.name === 'prod');
    const alias = ws?.modelAliases.find((a) => a.name === 'fast' || a.config['pattern'] === 'fast');
    expect(alias?.config['target']).toBe('claude-sonnet-4-6');
  });
});
