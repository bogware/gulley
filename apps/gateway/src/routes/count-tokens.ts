import { type Principal, scopeAllowsModel, scopeAllowsProvider } from '@gulley/auth';
import { ProviderRequestError } from '@gulley/providers';
import { selectCandidates } from '@gulley/routing';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { conversationIdentity, maskVaultKey } from '../conversation';
import { modelAllowedByPolicy } from '../model-policy';
import { residencyAllowedRegions } from '../residency-policy';
import type { GatewayContext, RouteHolder } from './messages';

/**
 * `POST /v1/messages/count_tokens` (Anthropic's optional gateway endpoint: without it
 * Claude Code falls back to a character-based estimate). A count is FREE — no budget
 * reservation, no ledger row, no cache — but it carries the same prompt as the
 * inference call, so it runs the same gates: authn, model + provider scope, the
 * central model policy, residency, and the input guardrail (a `block` policy blocks
 * it, a `mask` policy masks it under the SAME conversation key, so the counted prompt
 * is the prompt the model will see). It is dispatched to the route's first eligible
 * target through the adapter's `countTokens` (Anthropic passthrough, Bedrock's
 * CountTokens API); an adapter without one answers 404.
 */
export const COUNT_TOKENS_PATHS = [
  '/v1/messages/count_tokens',
  '/anthropic/v1/messages/count_tokens',
  '/bedrock/v1/messages/count_tokens',
] as const;

const COUNT_TOKENS_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface CountTokensDeps {
  resolvePrincipal(
    ctx: GatewayContext,
    request: FastifyRequest,
  ): Promise<{ kind: 'ok'; principal: Principal } | { kind: 'unauthorized' | 'unavailable' }>;
  filterResponseHeaders(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string | string[]>;
}

const error = (reply: FastifyReply, status: number, type: string, message: string) =>
  reply.code(status).send({ type: 'error', error: { type, message } });

export async function handleCountTokens(
  holder: RouteHolder,
  request: FastifyRequest,
  reply: FastifyReply,
  deps: CountTokensDeps,
): Promise<void> {
  const ctx = holder.ctx;
  const path = (request.url.split('?')[0] ?? request.url) || '/';
  const route = holder.routeFor(path.replace(/\/count_tokens$/, ''));
  if (!route) {
    await error(reply, 404, 'not_found_error', 'no route for path');
    return;
  }

  const resolved = await deps.resolvePrincipal(ctx, request);
  if (resolved.kind !== 'ok') {
    if (resolved.kind === 'unavailable') {
      await reply
        .code(503)
        .header('retry-after', '2')
        .send({ type: 'error', error: { type: 'api_error', message: 'auth store unavailable' } });
      return;
    }
    await error(reply, 401, 'authentication_error', 'invalid credentials');
    return;
  }
  const principal = resolved.principal;

  const raw = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
  let parsed: Record<string, unknown>;
  try {
    const v = JSON.parse(raw.toString('utf8') || '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    parsed = v as Record<string, unknown>;
  } catch {
    await error(reply, 400, 'invalid_request_error', 'body must be a JSON object');
    return;
  }
  if (typeof parsed['model'] !== 'string' || parsed['model'].length === 0) {
    await error(reply, 400, 'invalid_request_error', 'model is required');
    return;
  }

  // Alias / pinned-model resolution exactly as the inference path does it, so the
  // count is for the model the request would actually reach.
  let model = parsed['model'];
  let strategy = route.strategy;
  const alias = ctx.modelRouter?.resolve(model);
  if (alias) {
    if (alias.strategy) strategy = alias.strategy;
    if (alias.resolved !== model) {
      model = alias.resolved;
      parsed['model'] = model;
    }
  }
  if (!scopeAllowsModel(principal.scope, model)) {
    await error(reply, 403, 'permission_error', 'model not permitted for this key');
    return;
  }
  if (ctx.modelPolicy && !modelAllowedByPolicy(ctx.modelPolicy, model)) {
    await error(reply, 403, 'permission_error', 'model denied by policy');
    return;
  }

  // Input guardrail: the counted prompt is the prompt the model will see.
  const engine = route.guardrails ?? ctx.guardrails;
  let body = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (engine) {
    const conversation = conversationIdentity(request.headers, parsed, true, principal.id);
    const vaultKey = ctx.maskVaultMaster
      ? maskVaultKey(ctx.maskVaultMaster, principal.scope.workspaceId, conversation)
      : undefined;
    const gr = await engine.inspectInput(body.toString('utf8'), { vaultKey });
    if (gr.blocked) {
      await error(reply, 403, 'guardrail_blocked', gr.blockedReason ?? 'blocked by guardrail');
      return;
    }
    if (gr.transformedText !== undefined) {
      try {
        const t = JSON.parse(gr.transformedText) as unknown;
        if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('not an object');
        body = Buffer.from(gr.transformedText, 'utf8');
      } catch {
        await error(reply, 422, 'guardrail_transform_error', 'masked request is not forwardable');
        return;
      }
    }
  }

  const candidates = selectCandidates(strategy, ctx.breaker, {
    allowedRegions: residencyAllowedRegions(ctx.residencyPolicy),
    requireZdr: ctx.residencyPolicy?.requireZdr ?? false,
  }).filter((t) => scopeAllowsProvider(principal.scope, t.provider));
  const target = candidates[0];
  if (!target) {
    await error(reply, 403, 'permission_error', 'no permitted upstream for this request');
    return;
  }
  if (!target.adapter.countTokens) {
    await error(reply, 404, 'not_found_error', 'count_tokens is not available on this upstream');
    return;
  }
  const credential =
    (await ctx.tenantCredentials?.resolve(principal.scope.workspaceId, target.provider)) ??
    target.credential;

  let upstream;
  try {
    upstream = await target.adapter.countTokens({
      path: target.upstreamPath,
      body,
      headers: request.headers,
      credential,
      signal: AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS),
      headersTimeoutMs: COUNT_TOKENS_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof ProviderRequestError) {
      await error(reply, 400, 'invalid_request_error', err.message);
      return;
    }
    request.log.warn({ err, target: target.name }, 'count_tokens upstream failed');
    await error(reply, 502, 'api_error', 'upstream count_tokens failed');
    return;
  }

  const payload = await readCapped(upstream.body, MAX_RESPONSE_BYTES);
  const headers = deps.filterResponseHeaders(upstream.headers);
  delete headers['content-length'];
  await reply
    .code(upstream.statusCode)
    .headers(headers)
    .header('x-gulley-target', target.name)
    .send(payload);
}

async function readCapped(body: Readable, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    const buf = c as Buffer;
    if (size + buf.length > cap) {
      chunks.push(buf.subarray(0, cap - size));
      body.destroy();
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return Buffer.concat(chunks);
}
