import {
  type KeyStore,
  type Principal,
  resolveVirtualKey,
  scopeAllowsModel,
  scopeAllowsProvider,
} from '@gulley/auth';
import { type BudgetStore, estimateWorstCaseMicroUsd } from '@gulley/budget';
import type { CacheableRequest, CacheEngine, CacheLookup } from '@gulley/cache';
import { computeCost, toMicroUsd } from '@gulley/cost';
import { isErr } from '@gulley/core';
import {
  filterByPolicy,
  type GuardrailEngine,
  type OutputInspection,
  StreamingReplacer,
  StreamingScanner,
  type TokenVault,
} from '@gulley/guardrails';
import type { AuditSink, Ledger, RequestLogSink, RequestStatus } from '@gulley/pipeline';
import { SSEParser, type UsageExtractor } from '@gulley/providers';
import {
  type CircuitBreaker,
  isFailoverStatus,
  type RouteTarget,
  type RoutingStrategy,
  selectCandidates,
} from '@gulley/routing';
import type { Telemetry } from '@gulley/telemetry';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** A client-facing surface backed by a routing strategy (single / load-balance
 *  / fallback across upstream targets). */
export interface ProviderRoute {
  clientPaths: string[];
  createExtractor: () => UsageExtractor;
  strategy: RoutingStrategy;
  /** Per-route guardrail engine; falls back to the context's global engine. */
  guardrails?: GuardrailEngine;
  /** Set false to exclude this route from caching even when a cache is wired. */
  cacheable?: boolean;
}

export interface GatewayContext {
  routes: ProviderRoute[];
  keyStore: KeyStore;
  pepper: string;
  ledger: Ledger;
  requestLog: RequestLogSink;
  audit: AuditSink;
  breaker: CircuitBreaker;
  budgets: BudgetStore;
  telemetry: Telemetry;
  /** Global guardrail engine (audit-only by default). */
  guardrails?: GuardrailEngine;
  /** Two-tier response cache; absent = caching disabled. */
  cache?: CacheEngine;
}

const JSON_PARSE_CAP = 8 * 1024 * 1024;
/** Responses over this size are streamed through but never cached. */
const CACHE_BODY_CAP = 2 * 1024 * 1024;
/** Findings at or above this confidence make a response too sensitive to cache. */
const CACHE_SENSITIVE_CONFIDENCE = 0.8;

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
  let body = (request.body as Buffer | undefined) ?? Buffer.alloc(0);

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
  const provider0 = candidates[0]?.provider ?? 'unknown';

  // --- guardrails (input): audit by default; block / mask / redact per policy ---
  const engine = route.guardrails ?? ctx.guardrails;
  let inputFindings = 0;
  let guardrailAction: string | undefined;
  let vault: TokenVault | undefined;
  let inputMasked = false;
  if (engine) {
    const gr = await engine.inspectInput(body.toString('utf8'));
    inputFindings = gr.summary.total;
    if (gr.blocked) {
      await ctx.audit.append({
        orgId: principal.scope.orgId,
        actor: principal.id,
        action: 'guardrail.blocked',
        target: provider0,
        payload: {
          direction: 'input',
          reason: gr.blockedReason,
          categories: gr.summary.categories,
        },
      });
      ctx.telemetry.recordRequest({
        provider: provider0,
        requestModel: requestedModel,
        responseModel: requestedModel,
        route: candidates[0]?.upstreamPath ?? '',
        statusCode: 403,
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        streamed: false,
        startedAtMs: started,
        guardrailInputFindings: inputFindings,
        guardrailAction: 'block',
      });
      await reply.code(403).send({
        type: 'error',
        error: { type: 'guardrail_blocked', message: gr.blockedReason ?? 'blocked by guardrail' },
      });
      return;
    }
    if (gr.transformedText !== undefined) {
      body = Buffer.from(gr.transformedText, 'utf8');
      inputMasked = true;
      guardrailAction = gr.vault ? 'mask' : 'redact';
      vault = gr.vault;
    }
  }

  // --- cache lookup (before budget: a hit consumes no budget and no upstream) ---
  const cacheOn =
    ctx.cache !== undefined &&
    route.cacheable !== false &&
    !inputMasked &&
    !cacheControlHas(request, 'no-cache');
  let cacheReq: CacheableRequest | undefined;
  let cacheLookup: CacheLookup | undefined;
  if (cacheOn && ctx.cache) {
    cacheReq = {
      scope: principal.scope.workspaceId,
      provider: provider0,
      model: requestedModel,
      path: route.clientPaths[0] ?? '',
      body,
      variant: headerValue(request, 'anthropic-beta'),
    };
    cacheLookup = await ctx.cache.lookup(cacheReq);
    if (cacheLookup.response) {
      await serveFromCache(
        ctx,
        route,
        reply,
        request,
        principal,
        provider0,
        requestedModel,
        cacheLookup,
        started,
      );
      return;
    }
  }

  // --- budget: reserve worst-case at admission (hard cap, TOCTOU-safe) ---
  const maxOutput =
    numField(parsed['max_tokens']) ??
    numField(parsed['max_output_tokens']) ??
    DEFAULT_MAX_OUTPUT_TOKENS;
  const worstCase = estimateWorstCaseMicroUsd(provider0, requestedModel, body.length, maxOutput);
  let reserved = false;
  if (worstCase > 0) {
    const decision = await ctx.budgets.reserve(principal.scope.workspaceId, requestId, worstCase);
    if (decision && !decision.allowed) {
      request.log.info(
        { cap: decision.capMicroUsd, used: decision.usedMicroUsd },
        'budget exceeded',
      );
      await ctx.audit.append({
        orgId: principal.scope.orgId,
        actor: principal.id,
        action: 'budget.rejected',
        target: provider0,
        payload: {
          model: requestedModel,
          capMicroUsd: decision.capMicroUsd,
          usedMicroUsd: decision.usedMicroUsd,
          worstCaseMicroUsd: worstCase,
        },
      });
      ctx.telemetry.recordRequest({
        provider: provider0,
        requestModel: requestedModel,
        responseModel: requestedModel,
        route: candidates[0]?.upstreamPath ?? '',
        statusCode: 402,
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        streamed: false,
        startedAtMs: started,
        guardrailInputFindings: engine ? inputFindings : undefined,
      });
      await reply
        .code(402)
        .send({ type: 'error', error: { type: 'budget_exceeded', message: 'budget exceeded' } });
      return;
    }
    reserved = decision !== null && decision.allowed;
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
  const provider = served?.provider ?? provider0;

  const parserSse = new SSEParser();
  const usage = route.createExtractor();
  let statusCode = upstream?.statusCode ?? 502;
  let status: RequestStatus = controller.signal.aborted
    ? 'aborted'
    : statusCode < 400
      ? 'ok'
      : 'error';
  let settled = false;

  // Output guardrails: a windowed audit scanner (never mutates) + an optional
  // detokenizer that restores masked values in the client-bound stream. Output
  // block/redact enforcement requires buffering, so it applies to non-streamed
  // responses only; streamed output guardrails are audit.
  const outScanner = engine ? new StreamingScanner(engine.combinedDetector()) : undefined;
  const detok = vault ? new StreamingReplacer(vault.entries()) : undefined;
  const decoder = outScanner || detok ? new StringDecoder('utf8') : undefined;
  const outputEnforcing = engine !== undefined && engine.outputPolicy.action !== 'audit';
  const bufferOutput = outputEnforcing && !streamed && statusCode < 400;

  // Capture the full response when we need it whole: non-streamed metering,
  // buffered enforcement, or a cacheable miss we intend to store.
  const storeCache =
    cacheOn && cacheLookup?.status === 'miss' && !outputEnforcing && statusCode < 400;
  const captureFull = !streamed || bufferOutput || storeCache;
  const fullChunks: Buffer[] = [];
  let fullBytes = 0;
  let captureOverflow = false;
  let outputEnforced: OutputInspection | undefined;

  const teardown = async (): Promise<void> => {
    if (settled) return;
    settled = true;

    const n = usage.normalized();
    const meteredModel = n.model ?? requestedModel;
    const cost = computeCost(provider, meteredModel, n);
    const costMicroUsd = toMicroUsd(cost.totalUsd);
    const createdAt = new Date();

    // Output guardrail findings: from the buffered enforcement pass, or the
    // streaming audit scanner, filtered to what the output policy cares about.
    const outFindings = bufferOutput
      ? (outputEnforced?.findings ?? [])
      : outScanner && engine
        ? filterByPolicy(outScanner.findings(), engine.outputPolicy)
        : [];
    const outputSensitive = outFindings.some((f) => f.confidence >= CACHE_SENSITIVE_CONFIDENCE);

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
          guardrailInputFindings: inputFindings,
          guardrailOutputFindings: outFindings.length,
          cache: cacheLookup?.status ?? 'bypass',
        },
      });
      // Commit actual spend, refunding the reservation's worst-case remainder.
      if (reserved) {
        await ctx.budgets.commit(principal.scope.workspaceId, requestId, costMicroUsd);
      }
      // Persist to cache — only clean, non-sensitive, non-truncated 2xx bodies.
      if (
        storeCache &&
        ctx.cache &&
        cacheReq &&
        cacheLookup &&
        status === 'ok' &&
        statusCode < 400 &&
        !captureOverflow &&
        !outputSensitive &&
        !cacheControlHas(request, 'no-store') &&
        fullChunks.length > 0
      ) {
        const full = Buffer.concat(fullChunks);
        if (full.length <= CACHE_BODY_CAP) {
          await ctx.cache.store(
            cacheReq,
            {
              statusCode,
              headers: filterResponseHeaders(upstream?.headers ?? {}),
              body: full,
              streamed,
              model: meteredModel,
              inputTokens: cost.totalInputTokens,
              outputTokens: cost.outputTokens,
              createdAtMs: Date.now(),
            },
            cacheLookup,
          );
        }
      }
    } catch (err) {
      request.log.error({ err }, 'metering/audit teardown failed');
    }

    ctx.telemetry.recordRequest({
      provider,
      requestModel: requestedModel,
      responseModel: meteredModel,
      route: served?.upstreamPath ?? route.clientPaths[0] ?? '',
      statusCode,
      status,
      inputTokens: cost.totalInputTokens,
      outputTokens: cost.outputTokens,
      costMicroUsd,
      streamed,
      stopReason: n.stopReason,
      startedAtMs: started,
      cacheStatus: cacheLookup?.status ?? 'bypass',
      guardrailInputFindings: engine ? inputFindings : undefined,
      guardrailOutputFindings: engine ? outFindings.length : undefined,
      guardrailAction: guardrailAction ?? (outputEnforced?.blocked ? 'block' : undefined),
    });
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
  if (!bufferOutput) {
    reply.raw.writeHead(statusCode, {
      ...filterResponseHeaders(upstream.headers),
      'x-gulley-request-id': requestId,
      'x-gulley-target': served.name,
      'x-gulley-cache': cacheLookup?.status ?? 'bypass',
    });
  }

  const servedTarget = served;
  const upstreamHeaders = upstream.headers;
  const upstreamBody = upstream.body;

  upstreamBody.on('data', (chunk: Buffer) => {
    if (captureFull && !captureOverflow) {
      if (fullBytes + chunk.length <= JSON_PARSE_CAP) {
        fullChunks.push(chunk);
        fullBytes += chunk.length;
      } else {
        captureOverflow = true;
      }
    }

    let text: string | undefined;
    if (decoder) {
      text = decoder.write(chunk);
      if (outScanner && text) outScanner.push(text);
    }

    if (streamed) {
      try {
        usage.ingestSse(parserSse.push(text ?? chunk.toString('utf8')));
      } catch {
        /* metering is best-effort */
      }
    }

    if (bufferOutput) return; // hold bytes; enforce + write once at end

    let outBuf = chunk;
    if (detok && text !== undefined) outBuf = Buffer.from(detok.push(text), 'utf8');
    try {
      if (!reply.raw.writableEnded) reply.raw.write(outBuf);
    } catch {
      controller.abort();
    }
  });

  upstreamBody.on('end', () => {
    const tail = decoder ? decoder.end() : '';
    if (tail && outScanner) outScanner.push(tail);

    if (streamed) {
      try {
        if (tail) usage.ingestSse(parserSse.push(tail));
        usage.ingestSse(parserSse.push('\n\n'));
      } catch {
        /* best-effort */
      }
    } else if (fullBytes > 0 && !captureOverflow) {
      try {
        usage.ingestJson(JSON.parse(Buffer.concat(fullChunks).toString('utf8')));
      } catch {
        /* unparseable body — still forwarded verbatim */
      }
    }

    if (bufferOutput && engine) {
      // Enforce the output policy on the whole (non-streamed) body, then write.
      const text = Buffer.concat(fullChunks).toString('utf8');
      const out = engine.inspectOutputText(text);
      outputEnforced = out;
      const bodyOut = out.blocked
        ? Buffer.from(
            JSON.stringify({
              type: 'error',
              error: { type: 'guardrail_blocked', message: 'response withheld by guardrail' },
            }),
          )
        : Buffer.from(out.transformedText ?? text, 'utf8');
      if (!reply.raw.writableEnded) {
        reply.raw.writeHead(statusCode, {
          ...filterResponseHeaders(upstreamHeaders),
          'content-type': 'application/json',
          'x-gulley-request-id': requestId,
          'x-gulley-target': servedTarget.name,
          'x-gulley-cache': 'bypass',
          'x-gulley-guardrail': out.blocked
            ? 'output-blocked'
            : out.transformedText
              ? 'output-redacted'
              : 'audit',
        });
        reply.raw.write(bodyOut);
        reply.raw.end();
      }
    } else {
      if (detok) {
        const rest = detok.flush();
        if (rest && !reply.raw.writableEnded) reply.raw.write(Buffer.from(rest, 'utf8'));
      }
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    void teardown();
  });

  upstreamBody.on('error', (err: Error) => {
    status = controller.signal.aborted ? 'aborted' : 'error';
    request.log.error({ err }, 'upstream stream error');
    if (!reply.raw.writableEnded) reply.raw.end();
    void teardown();
  });
}

/** Replay a cached response verbatim and record a $0 (no-upstream) request. */
async function serveFromCache(
  ctx: GatewayContext,
  route: ProviderRoute,
  reply: FastifyReply,
  request: FastifyRequest,
  principal: Principal,
  provider: string,
  requestModel: string,
  lookup: CacheLookup,
  started: number,
): Promise<void> {
  const cached = lookup.response;
  if (!cached) return;
  const requestId = request.id;

  reply.hijack();
  reply.raw.writeHead(cached.statusCode, {
    ...filterResponseHeaders(cached.headers),
    'x-gulley-request-id': requestId,
    'x-gulley-target': `cache:${lookup.status}`,
    'x-gulley-cache': lookup.status,
    'cache-status': `Gulley; hit`,
  });
  if (!reply.raw.writableEnded) {
    reply.raw.write(cached.body);
    reply.raw.end();
  }

  const createdAt = new Date();
  try {
    await ctx.requestLog.write({
      requestId,
      principalId: principal.id,
      workspaceId: principal.scope.workspaceId,
      provider,
      model: cached.model,
      route: route.clientPaths[0] ?? '',
      statusCode: cached.statusCode,
      status: 'ok',
      streamed: cached.streamed,
      inputTokens: cached.inputTokens,
      outputTokens: cached.outputTokens,
      costMicroUsd: 0,
      latencyMs: Date.now() - started,
      createdAt,
    });
    await ctx.audit.append({
      orgId: principal.scope.orgId,
      actor: principal.id,
      action: 'proxy.cache_hit',
      target: provider,
      payload: {
        provider,
        model: cached.model,
        cache: lookup.status,
        statusCode: cached.statusCode,
      },
    });
  } catch (err) {
    request.log.error({ err }, 'cache-hit teardown failed');
  }

  ctx.telemetry.recordRequest({
    provider,
    requestModel,
    responseModel: cached.model,
    route: route.clientPaths[0] ?? '',
    statusCode: cached.statusCode,
    status: 'ok',
    inputTokens: cached.inputTokens,
    outputTokens: cached.outputTokens,
    costMicroUsd: 0,
    streamed: cached.streamed,
    startedAtMs: started,
    cacheStatus: lookup.status,
  });
}

function numField(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
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

function cacheControlHas(request: FastifyRequest, directive: string): boolean {
  const cc = headerValue(request, 'cache-control');
  return cc !== undefined && cc.toLowerCase().includes(directive);
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
