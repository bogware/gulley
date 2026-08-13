import {
  type KeyStore,
  resolveVirtualKey,
  scopeAllowsModel,
  scopeAllowsProvider,
} from '@gulley/auth';
import { computeCost, toMicroUsd } from '@gulley/cost';
import { isErr } from '@gulley/core';
import type { AuditSink, Ledger, RequestLogSink, RequestStatus } from '@gulley/pipeline';
import {
  type ProviderAdapter,
  SSEParser,
  type UpstreamCredential,
  type UsageExtractor,
} from '@gulley/providers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** One provider surface: which client paths it serves, where it forwards, and
 *  how to authenticate + meter it. */
export interface ProviderRoute {
  provider: string;
  clientPaths: string[];
  upstreamPath: string;
  adapter: ProviderAdapter;
  credential: UpstreamCredential;
  createExtractor: () => UsageExtractor;
}

export interface GatewayContext {
  routes: ProviderRoute[];
  keyStore: KeyStore;
  pepper: string;
  ledger: Ledger;
  requestLog: RequestLogSink;
  audit: AuditSink;
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
  const streamed = parsed['stream'] === true;

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

  // --- authz: uniform scope check ---
  if (
    !scopeAllowsProvider(principal.scope, route.provider) ||
    !scopeAllowsModel(principal.scope, requestedModel)
  ) {
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'not permitted' } });
    return;
  }

  const controller = new AbortController();
  const parser = new SSEParser();
  const usage = route.createExtractor();
  const jsonChunks: Buffer[] = [];
  let jsonBytes = 0;

  let statusCode = 502;
  let status: RequestStatus = 'error';
  let settled = false;

  const teardown = async (): Promise<void> => {
    if (settled) return;
    settled = true;

    const n = usage.normalized();
    const meteredModel = n.model ?? requestedModel;
    const cost = computeCost(route.provider, meteredModel, n);
    const costMicroUsd = toMicroUsd(cost.totalUsd);
    const createdAt = new Date();

    try {
      if (n.seen) {
        await ctx.ledger.record({
          requestId,
          principalId: principal.id,
          orgId: principal.scope.orgId,
          workspaceId: principal.scope.workspaceId,
          provider: route.provider,
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
        provider: route.provider,
        model: meteredModel,
        route: route.upstreamPath,
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
        target: route.provider,
        payload: {
          model: meteredModel,
          route: route.upstreamPath,
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

  // Client disconnect before completion → abort upstream, meter partial spend.
  reply.raw.on('close', () => {
    if (!settled) {
      status = 'aborted';
      controller.abort();
    }
  });

  let upstream;
  try {
    upstream = await route.adapter.forward({
      path: route.upstreamPath,
      body,
      headers: request.headers,
      credential: route.credential,
      signal: controller.signal,
    });
  } catch (err) {
    status = controller.signal.aborted ? 'aborted' : 'error';
    request.log.error({ err }, 'upstream request failed');
    await teardown();
    if (!reply.sent) {
      await reply
        .code(502)
        .send({ type: 'error', error: { type: 'api_error', message: 'upstream request failed' } });
    }
    return;
  }

  statusCode = upstream.statusCode;
  status = upstream.statusCode < 400 ? 'ok' : 'error';

  // Take over the raw socket: raw byte fidelity + guaranteed teardown (a
  // hijacked reply bypasses Fastify onSend/onResponse hooks by design).
  reply.hijack();
  reply.raw.writeHead(upstream.statusCode, {
    ...filterResponseHeaders(upstream.headers),
    'x-gulley-request-id': requestId,
  });

  upstream.body.on('data', (chunk: Buffer) => {
    try {
      if (!reply.raw.writableEnded) reply.raw.write(chunk);
    } catch {
      controller.abort();
      return;
    }
    if (streamed) {
      try {
        usage.ingestSse(parser.push(chunk.toString('utf8')));
      } catch {
        /* metering is best-effort and must never disturb the client stream */
      }
    } else if (jsonBytes < JSON_PARSE_CAP) {
      jsonChunks.push(chunk);
      jsonBytes += chunk.length;
    }
  });

  upstream.body.on('end', () => {
    if (streamed) {
      try {
        usage.ingestSse(parser.push('\n\n')); // flush a final event missing its blank line
      } catch {
        /* best-effort */
      }
    } else if (jsonBytes > 0 && jsonBytes < JSON_PARSE_CAP) {
      try {
        usage.ingestJson(
          JSON.parse(Buffer.concat(jsonChunks).toString('utf8')) as Record<string, unknown>,
        );
      } catch {
        /* unparseable body — still forwarded verbatim above */
      }
    }
    if (!reply.raw.writableEnded) reply.raw.end();
    void teardown();
  });

  upstream.body.on('error', (err: Error) => {
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
