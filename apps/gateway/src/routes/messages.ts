import {
  type KeyStore,
  resolveVirtualKey,
  scopeAllowsModel,
  scopeAllowsProvider,
} from '@gulley/auth';
import { computeCost, toMicroUsd } from '@gulley/cost';
import { isErr } from '@gulley/core';
import type { AuditSink, Ledger, RequestLogSink, RequestStatus } from '@gulley/pipeline';
import { SSEParser, type UsageExtractor } from '@gulley/providers';
import {
  type CircuitBreaker,
  isFailoverStatus,
  type RouteTarget,
  type RoutingStrategy,
  selectCandidates,
} from '@gulley/routing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** A client-facing surface backed by a routing strategy (single / load-balance
 *  / fallback across upstream targets). */
export interface ProviderRoute {
  clientPaths: string[];
  createExtractor: () => UsageExtractor;
  strategy: RoutingStrategy;
}

export interface GatewayContext {
  routes: ProviderRoute[];
  keyStore: KeyStore;
  pepper: string;
  ledger: Ledger;
  requestLog: RequestLogSink;
  audit: AuditSink;
  breaker: CircuitBreaker;
}

const JSON_PARSE_CAP = 8 * 1024 * 1024;

const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

export function registerRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  for (const route of ctx.routes) {
    const handler = (req: FastifyRequest, reply: FastifyReply): Promise<void> =>
      handleProxy(ctx, route, req, reply);
    for (const path of route.clientPaths) app.post(path, handler);
  }
}

async function handleProxy(
  ctx: GatewayContext,
  route: ProviderRoute,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const started = Date.now();
  const requestId = request.id;
  const body = (request.body as Buffer | undefined) ?? Buffer.alloc(0);

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    /* malformed body still gets forwarded verbatim */
  }
  const requestedModel = typeof parsed['model'] === 'string' ? parsed['model'] : 'unknown';

  // --- authn: virtual-key mode, deterministic + fail-closed ---
  const auth = await resolveVirtualKey(
    { apiKey: headerValue(request, 'x-api-key'), bearer: bearerToken(request) },
    { keyStore: ctx.keyStore, pepper: ctx.pepper },
  );
  if (isErr(auth)) {
    request.log.info({ reason: auth.error.reason }, 'auth rejected');
    await reply.code(401).send({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid credentials' },
    });
    return;
  }
  const principal = auth.value;

  // --- authz: model + provider scope (candidates filtered to allowed providers) ---
  if (!scopeAllowsModel(principal.scope, requestedModel)) {
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'model not permitted' } });
    return;
  }
  const candidates = selectCandidates(route.strategy, ctx.breaker).filter((t) =>
    scopeAllowsProvider(principal.scope, t.provider),
  );
  if (candidates.length === 0) {
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'not permitted' } });
    return;
  }

  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded && !controller.signal.aborted) controller.abort();
  });

  // --- pre-first-byte failover: try candidates until one serves a response ---
  let upstream: Awaited<ReturnType<RouteTarget['adapter']['forward']>> | undefined;
  let served: RouteTarget | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i] as RouteTarget;
    const isLast = i === candidates.length - 1;
    try {
      const resp = await target.adapter.forward({
        path: target.upstreamPath,
        body,
        headers: request.headers,
        credential: target.credential,
        signal: controller.signal,
      });
      if (!isLast && resp.statusCode >= 400 && isFailoverStatus(route.strategy, resp.statusCode)) {
        ctx.breaker.recordFailure(target.name);
        resp.body.resume(); // discard the failed body, then try the next target
        request.log.warn({ target: target.name, status: resp.statusCode }, 'failing over');
        continue;
      }
      upstream = resp;
      served = target;
      if (resp.statusCode < 400) ctx.breaker.recordSuccess(target.name);
      else ctx.breaker.recordFailure(target.name);
      break;
    } catch (err) {
      ctx.breaker.recordFailure(target.name);
      request.log.warn({ target: target.name, err }, 'target error');
      if (controller.signal.aborted) break; // client gone — stop trying
    }
  }

  const streamed = served?.alwaysStream === true || parsed['stream'] === true;
  const provider = served?.provider ?? candidates[0]?.provider ?? 'unknown';

  const parserSse = new SSEParser();
  const usage = route.createExtractor();
  const jsonChunks: Buffer[] = [];
  let jsonBytes = 0;
  let statusCode = upstream?.statusCode ?? 502;
  let status: RequestStatus = controller.signal.aborted
    ? 'aborted'
    : statusCode < 400
      ? 'ok'
      : 'error';
  let settled = false;

  const teardown = async (): Promise<void> => {
    if (settled) return;
    settled = true;

    const n = usage.normalized();
    const meteredModel = n.model ?? requestedModel;
    const cost = computeCost(provider, meteredModel, n);
    const costMicroUsd = toMicroUsd(cost.totalUsd);
    const createdAt = new Date();

    try {
      if (n.seen) {
        await ctx.ledger.record({
          requestId,
          principalId: principal.id,
          orgId: principal.scope.orgId,
          workspaceId: principal.scope.workspaceId,
          provider,
          model: meteredModel,
          cost,
          costMicroUsd,
          status,
          createdAt,
        });
      }
      await ctx.requestLog.write({
        requestId,
        principalId: principal.id,
        workspaceId: principal.scope.workspaceId,
        provider,
        model: meteredModel,
        route: served?.upstreamPath ?? route.clientPaths[0] ?? '',
        statusCode,
        status,
        streamed,
        inputTokens: cost.totalInputTokens,
        outputTokens: cost.outputTokens,
        costMicroUsd,
        latencyMs: Date.now() - started,
        createdAt,
      });
      await ctx.audit.append({
        orgId: principal.scope.orgId,
        actor: principal.id,
        action: 'proxy.request',
        target: served?.name ?? provider,
        payload: {
          provider,
          model: meteredModel,
          status,
          statusCode,
          streamed,
          inputTokens: cost.totalInputTokens,
          outputTokens: cost.outputTokens,
          costMicroUsd,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'metering/audit teardown failed');
    }
  };

  // Every candidate failed to produce a response (all connection errors).
  if (!upstream || !served) {
    status = controller.signal.aborted ? 'aborted' : 'error';
    statusCode = 502;
    await teardown();
    if (!reply.sent) {
      await reply
        .code(502)
        .send({ type: 'error', error: { type: 'api_error', message: 'no upstream available' } });
    }
    return;
  }

  // Take over the raw socket: raw byte fidelity + guaranteed teardown.
  reply.hijack();
  reply.raw.writeHead(statusCode, {
    ...filterResponseHeaders(upstream.headers),
    'x-gulley-request-id': requestId,
    'x-gulley-target': served.name,
  });

  const upstreamBody = upstream.body;
  upstreamBody.on('data', (chunk: Buffer) => {
    try {
      if (!reply.raw.writableEnded) reply.raw.write(chunk);
    } catch {
      controller.abort();
      return;
    }
    if (streamed) {
      try {
        usage.ingestSse(parserSse.push(chunk.toString('utf8')));
      } catch {
        /* metering is best-effort */
      }
    } else if (jsonBytes < JSON_PARSE_CAP) {
      jsonChunks.push(chunk);
      jsonBytes += chunk.length;
    }
  });

  upstreamBody.on('end', () => {
    if (streamed) {
      try {
        usage.ingestSse(parserSse.push('\n\n'));
      } catch {
        /* best-effort */
      }
    } else if (jsonBytes > 0 && jsonBytes < JSON_PARSE_CAP) {
      try {
        usage.ingestJson(
          JSON.parse(Buffer.concat(jsonChunks).toString('utf8')) as Record<string, unknown>,
        );
      } catch {
        /* unparseable body — still forwarded verbatim */
      }
    }
    if (!reply.raw.writableEnded) reply.raw.end();
    void teardown();
  });

  upstreamBody.on('error', (err: Error) => {
    status = controller.signal.aborted ? 'aborted' : 'error';
    request.log.error({ err }, 'upstream stream error');
    if (!reply.raw.writableEnded) reply.raw.end();
    void teardown();
  });
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const auth = headerValue(request, 'authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

function filterResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
