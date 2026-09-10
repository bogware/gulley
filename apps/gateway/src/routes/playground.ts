import { resolveVirtualKey, scopeAllowsModel, scopeAllowsProvider } from '@gulley/auth';
import { estimateWorstCaseMicroUsd } from '@gulley/budget';
import { rankPrice } from '@gulley/cost';
import { isErr } from '@gulley/core';
import { selectCandidates } from '@gulley/routing';
import { residencyAllowedRegions } from '../residency-policy';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RouteHolder } from './messages';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_PATH = '/v1/messages';

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const auth = headerValue(request, 'authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

function numField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * POST /v1/playground/verify — the first-run "does my key/route/model work?"
 * preflight. Authenticates the caller's virtual key and reports, WITHOUT any
 * upstream call or spend, exactly what the data plane would do: authz on model +
 * provider, which target serves the request, what the input guardrails flag, the
 * worst-case cost estimate, and whether the budget would admit. It reuses the real
 * pipeline components (router, authz, guardrails, cost, budget) so the answer is
 * faithful, but it never proxies — a real streamed request goes through
 * `/v1/messages` and the `live:*` smoke scripts.
 */
export async function handlePlaygroundVerify(
  holder: RouteHolder,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const ctx = holder.ctx;
  if (!ctx.playgroundEnabled) {
    await reply
      .code(404)
      .send({ type: 'error', error: { type: 'not_found', message: 'disabled' } });
    return;
  }

  // --- authn (virtual key only; the playground is a first-run key check) ---
  const auth = await resolveVirtualKey(
    { apiKey: headerValue(request, 'x-api-key'), bearer: bearerToken(request) },
    { keyStore: ctx.keyStore, pepper: ctx.pepper },
  );
  if (isErr(auth)) {
    await reply.code(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid credentials' },
    });
    return;
  }
  const principal = auth.value;

  const body = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    await reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'invalid JSON body' },
    });
    return;
  }

  const requestedModel = typeof parsed['model'] === 'string' ? parsed['model'] : undefined;
  if (!requestedModel) {
    await reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'model is required' },
    });
    return;
  }
  const clientPath = typeof parsed['path'] === 'string' ? parsed['path'] : DEFAULT_PATH;

  // --- model routing (alias/pin + per-model strategy), mirroring the hot path ---
  const route = holder.routeFor(clientPath);
  let effectiveModel = requestedModel;
  let strategy = route?.strategy;
  if (route && ctx.modelRouter) {
    const m = ctx.modelRouter.resolve(effectiveModel);
    if (m) {
      if (m.strategy) strategy = m.strategy;
      if (m.resolved !== effectiveModel) effectiveModel = m.resolved;
    }
  }

  // --- authz: model then provider (candidates filtered to allowed providers) ---
  const modelAllowed = scopeAllowsModel(principal.scope, effectiveModel);
  const candidates =
    route && strategy && modelAllowed
      ? selectCandidates(strategy, ctx.breaker, {
          scoreboard: ctx.scoreboard,
          outlier: ctx.outlier,
          costOf: (t) => rankPrice(t.provider, effectiveModel, ctx.rateResolver),
          // Preview honors residency so "providerAllowed" matches what the hot path
          // would actually serve/refuse under the policy.
          allowedRegions: residencyAllowedRegions(ctx.residencyPolicy),
          requireZdr: ctx.residencyPolicy?.requireZdr ?? false,
        }).filter((t) => scopeAllowsProvider(principal.scope, t.provider))
      : [];
  const target = candidates[0];
  const providerAllowed = candidates.length > 0;

  // --- guardrails (input): report what the policy would do — never forwarded ---
  const engine = route?.guardrails ?? ctx.guardrails;
  let guardrails:
    | { enabled: false }
    | { enabled: true; findings: number; categories: Record<string, number>; wouldBlock: boolean } =
    {
      enabled: false,
    };
  if (engine) {
    const gr = await engine.inspectInput(body.toString('utf8'));
    guardrails = {
      enabled: true,
      findings: gr.summary.total,
      categories: gr.summary.categories,
      wouldBlock: gr.blocked,
    };
  }

  // --- cost: worst-case estimate, priced identically to the admission reserve ---
  const maxOutput =
    numField(parsed['max_tokens']) ??
    numField(parsed['max_output_tokens']) ??
    numField(parsed['max_completion_tokens']) ?? // OpenAI reasoning/o-series/gpt-5 ceiling
    DEFAULT_MAX_OUTPUT_TOKENS;
  const provider = target?.provider ?? 'unknown';
  const estimatedWorstCaseMicroUsd = target
    ? estimateWorstCaseMicroUsd(provider, effectiveModel, body.length, maxOutput, ctx.rateResolver)
    : 0;

  // --- budget: peek whether the worst-case would admit (reserve, then release) ---
  // A reserve+rollback gives a real would-admit answer using the same TOCTOU-safe
  // machinery, with no net spend: on reject nothing is reserved; on accept the
  // reservation is committed as 0 (released) immediately.
  let budget: { checked: boolean; allowed?: boolean; capMicroUsd?: number; usedMicroUsd?: number } =
    {
      checked: false,
    };
  if (estimatedWorstCaseMicroUsd > 0) {
    const pgId = `${request.id}#playground`;
    const ws = principal.scope.workspaceId;
    try {
      const d = await ctx.budgets.reserve(ws, pgId, estimatedWorstCaseMicroUsd);
      if (d) {
        budget = {
          checked: true,
          allowed: d.allowed,
          capMicroUsd: d.capMicroUsd,
          usedMicroUsd: d.usedMicroUsd,
        };
      }
    } catch {
      /* a budget backend error leaves the peek unchecked, never fails the preflight */
    } finally {
      try {
        await ctx.budgets.commit(ws, pgId, 0); // release the peek reservation
      } catch {
        /* best-effort release */
      }
    }
  }

  const ok =
    modelAllowed &&
    providerAllowed &&
    !(guardrails.enabled && guardrails.wouldBlock) &&
    (!budget.checked || budget.allowed === true);

  // Best-effort audit: an authenticated principal probed a route (no content).
  try {
    await ctx.audit.append({
      orgId: principal.scope.orgId,
      actor: principal.id,
      action: 'playground.verify',
      target: provider,
      payload: { model: effectiveModel, ok, path: clientPath },
    });
  } catch {
    /* never let audit failure break a diagnostic */
  }

  await reply.send({
    ok,
    model: { requested: requestedModel, resolved: effectiveModel },
    authz: { modelAllowed, providerAllowed, provider: providerAllowed ? provider : undefined },
    route: target
      ? { target: target.name, provider: target.provider, upstreamPath: target.upstreamPath }
      : null,
    guardrails,
    cost: { estimatedWorstCaseMicroUsd },
    budget,
  });
}
