import { randomUUID } from 'node:crypto';
import { applyConfig } from '@gulley/config';
import { type AdminPrincipal, coveredOrgIds } from '@gulley/rbac';
import type { FastifyInstance } from 'fastify';

import { adminRoute, body, forbidden, notFound, scopeForWorkspace, str } from './admin';
import { ControlConfigStore } from './config-store';
import type { ControlContext } from './context';
import {
  decideRollout,
  type EvalCase,
  type EvalResult,
  type EvalSuite,
  type RolloutTarget,
  type RolloutThresholds,
  type Scorer,
  type ScorerConfig,
} from './eval-rollout';
import type { StoredRollout } from './eval-store';

/**
 * Eval-in-the-loop rollout controller — HTTP surface (offline golden-set gate).
 *
 * Suites (golden prompts + deterministic scorers) and rollouts (a model-alias repoint
 * gated on a suite) are managed here. Running a rollout proxies every case through the
 * real gateway against BOTH the incumbent and the candidate model, scores them, and —
 * only if the candidate clears the gate — repoints the alias through the durable,
 * audited config-apply path, so clients never change.
 *
 * Served only when an eval runner is wired (EVAL_ROLLOUT_ENABLED + a gateway URL/key);
 * otherwise /admin/rollouts/:id/run returns 501. Writes/runs are owner-only
 * (`config:apply`); reads are admin-and-up (`audit:verify`).
 */

const SCORER_KINDS = new Set<Scorer['kind']>([
  'contains',
  'regex',
  'json-valid',
  'max-cost-micro-usd',
  'max-latency-ms',
  'max-output-tokens',
  'not-refused',
  'guardrail-clean',
]);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseScorer(raw: unknown): Parsed<ScorerConfig> {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: 'scorer must be an object' };
  const o = raw as Record<string, unknown>;
  const s = o['scorer'];
  if (typeof s !== 'object' || s === null) return { ok: false, error: 'scorer.scorer required' };
  const kind = (s as Record<string, unknown>)['kind'];
  if (typeof kind !== 'string' || !SCORER_KINDS.has(kind as Scorer['kind'])) {
    return { ok: false, error: `unknown scorer kind: ${String(kind)}` };
  }
  const sc = s as Record<string, unknown>;
  // Per-kind required fields (fail closed on a malformed scorer so a bad gate can't
  // silently pass everything).
  if (kind === 'contains' && typeof sc['text'] !== 'string')
    return { ok: false, error: 'contains.text required' };
  if (kind === 'regex' && typeof sc['pattern'] !== 'string')
    return { ok: false, error: 'regex.pattern required' };
  if (
    (kind === 'max-cost-micro-usd' || kind === 'max-latency-ms' || kind === 'max-output-tokens') &&
    typeof sc['limit'] !== 'number'
  ) {
    return { ok: false, error: `${kind}.limit (number) required` };
  }
  return { ok: true, value: { scorer: s as Scorer, critical: o['critical'] === true } };
}

function parseCase(raw: unknown): Parsed<EvalCase> {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: 'case must be an object' };
  const o = raw as Record<string, unknown>;
  const id = str(o['id']);
  if (!id) return { ok: false, error: 'case.id required' };
  const req = o['request'];
  if (typeof req !== 'object' || req === null)
    return { ok: false, error: `case ${id}: request required` };
  const messages = (req as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages) || messages.length === 0)
    return { ok: false, error: `case ${id}: request.messages must be a non-empty array` };
  for (const m of messages) {
    if (
      typeof m !== 'object' ||
      m === null ||
      typeof (m as Record<string, unknown>)['role'] !== 'string' ||
      typeof (m as Record<string, unknown>)['content'] !== 'string'
    )
      return { ok: false, error: `case ${id}: each message needs string role + content` };
  }
  const scorersRaw = o['scorers'];
  if (!Array.isArray(scorersRaw) || scorersRaw.length === 0)
    return { ok: false, error: `case ${id}: at least one scorer required` };
  const scorers: ScorerConfig[] = [];
  for (const sr of scorersRaw) {
    const p = parseScorer(sr);
    if (!p.ok) return { ok: false, error: `case ${id}: ${p.error}` };
    scorers.push(p.value);
  }
  const r = req as Record<string, unknown>;
  return {
    ok: true,
    value: {
      id,
      request: {
        messages: messages as Array<{ role: string; content: string }>,
        ...(typeof r['system'] === 'string' ? { system: r['system'] } : {}),
        ...(typeof r['max_tokens'] === 'number' ? { max_tokens: r['max_tokens'] } : {}),
      },
      scorers,
    },
  };
}

function parseSuite(raw: Record<string, unknown>): Parsed<EvalSuite> {
  const name = str(raw['name']);
  if (!name) return { ok: false, error: 'name required' };
  const casesRaw = raw['cases'];
  if (!Array.isArray(casesRaw) || casesRaw.length === 0)
    return { ok: false, error: 'at least one case required' };
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const cr of casesRaw) {
    const p = parseCase(cr);
    if (!p.ok) return { ok: false, error: p.error };
    if (seen.has(p.value.id)) return { ok: false, error: `duplicate case id: ${p.value.id}` };
    seen.add(p.value.id);
    cases.push(p.value);
  }
  const id = str(raw['id']) ?? `es_${randomUUID()}`;
  return { ok: true, value: { id, name, cases } };
}

function parseThresholds(raw: unknown): RolloutThresholds {
  if (typeof raw !== 'object' || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const t: RolloutThresholds = {};
  if (typeof o['minPassRate'] === 'number') t.minPassRate = o['minPassRate'];
  if (typeof o['maxCostRegressionBps'] === 'number')
    t.maxCostRegressionBps = o['maxCostRegressionBps'];
  return t;
}

/** Repoints a model alias to the candidate model through the guarded config-apply path
 *  (durable + audited + hot-reloads the gateway). Injectable so route tests can stub it. */
export type RolloutPromoter = (
  target: RolloutTarget,
  admin: AdminPrincipal,
) => Promise<{ ok: true; version: number } | { ok: false; error: string }>;

export function buildRolloutPromoter(ctx: ControlContext): RolloutPromoter {
  return async (target, admin) => {
    const ws = ctx.workspaces.get(target.workspaceId);
    if (!ws) return { ok: false, error: 'workspace not found' };
    const org = ctx.orgs.get(ws.orgId);
    if (!org) return { ok: false, error: 'org not found' };
    const store = ctx.configStore ?? new ControlConfigStore(ctx);
    const orgIds = coveredOrgIds(admin);
    const doc = await store.exportDocument(orgIds === '*' ? '*' : new Set(orgIds));
    const w = doc.orgs.find((o) => o.name === org.name)?.workspaces.find((x) => x.name === ws.name);
    if (!w) return { ok: false, error: 'workspace not in exportable config scope' };
    const aliasName = (a: { name: string; config: Record<string, unknown> }) =>
      typeof a.config['pattern'] === 'string' ? (a.config['pattern'] as string) : a.name;
    const existing = w.modelAliases.find((a) => aliasName(a) === target.alias);
    if (existing) existing.config = { ...existing.config, target: target.toModel };
    else
      w.modelAliases.push({
        name: target.alias,
        config: { pattern: target.alias, target: target.toModel },
      });

    const base = await ctx.configVersions.currentVersion();
    const r = await applyConfig(doc, base, admin, {
      store,
      versions: ctx.configVersions,
      audit: ctx.audit,
      access: ctx.access,
      atomic: ctx.configAtomic,
      egressAllowlist: ctx.outboundAllowlist,
      onApplied: ctx.notifier
        ? (e) =>
            ctx.notifier?.emit({
              v: e.version,
              hash: e.contentHash,
              origin: ctx.originId,
              ts: Date.now(),
            })
        : undefined,
    });
    if (r.ok) return { ok: true, version: r.value.version };
    const msg = 'message' in r.error && typeof r.error.message === 'string' ? r.error.message : '';
    return { ok: false, error: `${r.error.kind}${msg ? `: ${msg}` : ''}` };
  };
}

export function registerEvalRolloutRoutes(app: FastifyInstance, ctx: ControlContext): void {
  const store = ctx.evalStore;
  if (!store) return; // feature off entirely (no in-memory store wired)
  const promote = ctx.rolloutPromoter ?? buildRolloutPromoter(ctx);

  // --- Eval suites (deployment-global; owner writes, admin+ reads) ---

  app.post(
    '/admin/eval-suites',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:apply', {}))) return forbidden(reply);
      const parsed = parseSuite(body(request));
      if (!parsed.ok)
        return reply.code(422).send({ error: { type: 'validation', message: parsed.error } });
      store.putSuite(parsed.value);
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'eval.suite_saved',
        target: parsed.value.id,
        payload: { id: parsed.value.id, name: parsed.value.name, cases: parsed.value.cases.length },
      });
      return reply.send({ suite: parsed.value });
    }),
  );

  app.get(
    '/admin/eval-suites',
    adminRoute(ctx, async (_request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      return reply.send({ suites: store.listSuites() });
    }),
  );

  app.get(
    '/admin/eval-suites/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      const suite = store.getSuite((request.params as { id: string }).id);
      if (!suite) return notFound(reply, 'eval suite');
      return reply.send({ suite });
    }),
  );

  app.delete(
    '/admin/eval-suites/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'config:apply', {}))) return forbidden(reply);
      const id = (request.params as { id: string }).id;
      if (!store.deleteSuite(id)) return notFound(reply, 'eval suite');
      await ctx.audit.append({
        orgId: null,
        actor: admin.subject,
        action: 'eval.suite_deleted',
        target: id,
        payload: { id },
      });
      return reply.send({ deleted: true });
    }),
  );

  // --- Rollouts ---

  app.post(
    '/admin/rollouts',
    adminRoute(ctx, async (request, reply, admin) => {
      const b = body(request);
      const suiteId = str(b['suiteId']);
      const workspaceId = str(b['workspaceId']);
      const alias = str(b['alias']);
      const fromModel = str(b['fromModel']);
      const toModel = str(b['toModel']);
      if (!suiteId || !workspaceId || !alias || !fromModel || !toModel) {
        return reply.code(422).send({
          error: {
            type: 'validation',
            message: 'suiteId, workspaceId, alias, fromModel, toModel required',
          },
        });
      }
      if (fromModel === toModel)
        return reply
          .code(422)
          .send({ error: { type: 'validation', message: 'fromModel and toModel must differ' } });
      if (!store.getSuite(suiteId))
        return reply.code(422).send({ error: { type: 'validation', message: 'unknown suiteId' } });
      const at = scopeForWorkspace(ctx, workspaceId);
      if (!at) return notFound(reply, 'workspace');
      if (!(await ctx.access.can(admin, 'config:apply', at))) return forbidden(reply);

      const rollout: StoredRollout = {
        id: `ro_${randomUUID()}`,
        suiteId,
        target: { workspaceId, orgId: at.orgId ?? null, alias, fromModel, toModel },
        thresholds: parseThresholds(b['thresholds']),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      store.putRollout(rollout);
      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action: 'rollout.created',
        target: rollout.id,
        payload: { suiteId, alias, fromModel, toModel, workspaceId },
      });
      return reply.send({ rollout });
    }),
  );

  app.get(
    '/admin/rollouts',
    adminRoute(ctx, async (_request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      return reply.send({ rollouts: store.listRollouts() });
    }),
  );

  app.get(
    '/admin/rollouts/:id',
    adminRoute(ctx, async (request, reply, admin) => {
      if (!(await ctx.access.can(admin, 'audit:verify', {}))) return forbidden(reply);
      const rollout = store.getRollout((request.params as { id: string }).id);
      if (!rollout) return notFound(reply, 'rollout');
      return reply.send({ rollout });
    }),
  );

  app.post(
    '/admin/rollouts/:id/run',
    adminRoute(ctx, async (request, reply, admin) => {
      const runner = ctx.evalRunner;
      if (!runner) {
        return reply
          .code(501)
          .send({ error: { type: 'not_configured', message: 'eval runner not enabled' } });
      }
      const rollout = store.getRollout((request.params as { id: string }).id);
      if (!rollout) return notFound(reply, 'rollout');
      const suite = store.getSuite(rollout.suiteId);
      if (!suite)
        return reply
          .code(409)
          .send({ error: { type: 'conflict', message: 'suite no longer exists' } });
      const at = scopeForWorkspace(ctx, rollout.target.workspaceId);
      if (!at) return notFound(reply, 'workspace');
      if (!(await ctx.access.can(admin, 'config:apply', at))) return forbidden(reply);

      // Run each case against incumbent + candidate (the two targets in parallel per
      // case; cases sequentially to keep upstream load bounded for a small golden set).
      const incumbent = new Map<string, EvalResult>();
      const candidate = new Map<string, EvalResult>();
      for (const c of suite.cases) {
        const [inc, cand] = await Promise.all([
          runner.run(rollout.target.fromModel, c),
          runner.run(rollout.target.toModel, c),
        ]);
        incumbent.set(c.id, inc);
        candidate.set(c.id, cand);
      }

      const report = decideRollout(suite, rollout.target, incumbent, candidate, rollout.thresholds);
      rollout.report = report;
      rollout.decidedAt = new Date().toISOString();

      if (report.decision === 'promote') {
        const applied = await promote(rollout.target, admin);
        if (applied.ok) {
          rollout.status = 'promoted';
          rollout.appliedVersion = applied.version;
        } else {
          rollout.status = 'error';
          rollout.error = applied.error;
        }
      } else {
        rollout.status = 'held';
      }
      store.putRollout(rollout);

      await ctx.audit.append({
        orgId: at.orgId ?? null,
        actor: admin.subject,
        action:
          rollout.status === 'promoted'
            ? 'rollout.promoted'
            : rollout.status === 'held'
              ? 'rollout.held'
              : 'rollout.error',
        target: rollout.id,
        payload: {
          suiteId: suite.id,
          alias: rollout.target.alias,
          fromModel: rollout.target.fromModel,
          toModel: rollout.target.toModel,
          decision: report.decision,
          incumbentPassRate: report.incumbent.passRate,
          candidatePassRate: report.candidate.passRate,
          reasons: report.reasons,
          ...(rollout.appliedVersion !== undefined
            ? { appliedVersion: rollout.appliedVersion }
            : {}),
          ...(rollout.error !== undefined ? { error: rollout.error } : {}),
        },
      });

      return reply.send({ rollout });
    }),
  );
}
