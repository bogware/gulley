import {
  type BasicAuthConfig,
  type KeyStore,
  type Principal,
  resolveBasicPrincipal,
  resolveVirtualKey,
  scopeAllowsModel,
  scopeAllowsProvider,
} from '@gulley/auth';
import { type BudgetStore, estimateWorstCaseMicroUsd } from '@gulley/budget';
import type { CacheableRequest, CacheEngine, CacheLookup } from '@gulley/cache';
import { computeCost, type RateResolver, toMicroUsd } from '@gulley/cost';
import { isErr } from '@gulley/core';
import {
  filterByPolicy,
  type GuardrailEngine,
  type OutputInspection,
  StreamingReplacer,
  StreamingScanner,
  type TokenVault,
} from '@gulley/guardrails';
import type { CelAuthorizer, CelTransformer, HeaderChanges } from '@gulley/cel';
import type { GatewayMetrics } from '@gulley/metrics';
import { type JwtAuthConfig, looksLikeJwt, resolveJwtPrincipal } from '../jwt-auth';
import type { AuditSink, Ledger, RequestLogSink, RequestStatus } from '@gulley/pipeline';
import { parseRetryAfterMs, SSEParser, type UsageExtractor } from '@gulley/providers';
import { type RateLimit, type RateLimiter, rateLimitHeaders } from '@gulley/ratelimit';
import {
  type CircuitBreaker,
  hasShaping,
  isFailoverStatus,
  type LoadScoreboard,
  type ModelRouter,
  type RequestShaping,
  type RouteTarget,
  type RoutingStrategy,
  selectCandidates,
  shapeRequestBody,
} from '@gulley/routing';
import type { Telemetry } from '@gulley/telemetry';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

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
  /** Request shaping (defaults/overrides/system enrichment) applied before forward. */
  shaping?: RequestShaping;
  /** Opt in to hold-then-flush enforcement of the OUTPUT policy on streamed
   *  responses (buffers the stream, then blocks/withholds). Trades streaming. */
  holdStreamedOutput?: boolean;
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
  /** RPM/TPM rate limiter; absent = no rate limiting. */
  rateLimiter?: RateLimiter;
  /** Prometheus instruments; absent = metrics disabled. */
  metrics?: GatewayMetrics;
  /** Flush any buffered request logs (called on the SIGTERM drain). */
  flushLogs?: () => Promise<void>;
  /** Model-based routing / aliasing; absent = route by path only. */
  modelRouter?: ModelRouter;
  /** Static model catalog surfaced by GET /v1/models (merged with router models). */
  models?: string[];
  /** Pricing override source (models.dev catalog); absent = seed tables only. */
  rateResolver?: RateResolver;
  /** Max same-target attempts (pre-first-byte) before failover. 1 = no retry. */
  retryMaxAttempts?: number;
  /** Base exponential backoff between same-target retries (ms). */
  retryBackoffMs?: number;
  /** CEL authorization rules; absent = scope-based authz only. */
  authorizer?: CelAuthorizer;
  /** CEL request/response transformation; absent = no transform. */
  transformer?: CelTransformer;
  /** Inbound JWT/JWKS auth mode; absent = virtual keys only. */
  jwtAuth?: JwtAuthConfig;
  /** Inbound HTTP Basic auth (htpasswd-backed); absent = Basic disabled. */
  basicAuth?: BasicAuthConfig;
  /** In-flight load scoreboard for power-of-two-choices least-load balancing. */
  scoreboard?: LoadScoreboard;
  /** Request header whose value pins a session to one target (HRW affinity);
   *  falls back to the principal id. Absent = no affinity (P2C / weighted). */
  sessionAffinityHeader?: string;
}

const JSON_PARSE_CAP = 8 * 1024 * 1024;
/** Abort a proxied stream after this long with no upstream activity — provider
 *  adapters disable undici's bodyTimeout for long SSE, so this is the only guard
 *  against a half-open upstream that would otherwise pin a budget reservation. */
const STREAM_INACTIVITY_MS = Number(process.env['STREAM_INACTIVITY_MS']) || 120_000;
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
  // Model discovery (OpenAI-shaped list), filtered to the caller's allowed models.
  const modelsHandler = (req: FastifyRequest, reply: FastifyReply): Promise<void> =>
    handleModels(ctx, req, reply);
  for (const path of ['/v1/models', '/openai/v1/models']) app.get(path, modelsHandler);
}

/** GET /v1/models — the models this principal may use, as an OpenAI model list. */
async function handleModels(
  ctx: GatewayContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
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
  const ids = new Set<string>([...(ctx.models ?? []), ...(ctx.modelRouter?.knownModels() ?? [])]);
  const data = [...ids]
    .filter((id) => scopeAllowsModel(principal.scope, id))
    .sort()
    .map((id) => ({ id, object: 'model', owned_by: 'gulley' }));
  await reply.send({ object: 'list', data });
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
  let parseOk = true;
  try {
    parsed = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    parseOk = false; /* malformed body still gets forwarded verbatim */
  }
  let requestedModel = typeof parsed['model'] === 'string' ? parsed['model'] : 'unknown';

  // --- model routing + request shaping (only when the body parsed cleanly) ---
  // Resolve the requested model through the router (alias/pin the upstream model,
  // and optionally override the strategy for a "virtual model"), then apply any
  // route shaping. Both rewrite the outbound body BEFORE authz/guardrails/cache
  // so scope checks, the cache key, and detection all see the effective request.
  let strategy = route.strategy;
  if (parseOk) {
    if (ctx.modelRouter) {
      const m = ctx.modelRouter.resolve(requestedModel);
      if (m) {
        if (m.strategy) strategy = m.strategy;
        if (m.resolved !== requestedModel) {
          requestedModel = m.resolved;
          parsed['model'] = m.resolved;
          body = Buffer.from(JSON.stringify(parsed), 'utf8');
        }
      }
    }
    if (route.shaping && hasShaping(route.shaping)) {
      parsed = shapeRequestBody(parsed, route.shaping);
      body = Buffer.from(JSON.stringify(parsed), 'utf8');
    }
  }

  // --- authn: Basic (if enabled) OR inbound JWT (bearer is a JWT) OR virtual key ---
  // Deterministic mode selection by credential channel — no fall-through: the
  // `Basic ` scheme, a JWT-shaped bearer, and the `gk_` virtual-key prefix are
  // mutually exclusive.
  const authHeader = headerValue(request, 'authorization');
  const bearer = bearerToken(request);
  let principal: Principal;
  if (ctx.basicAuth && authHeader && /^basic\s/i.test(authHeader)) {
    const basic = resolveBasicPrincipal(authHeader, ctx.basicAuth);
    if (isErr(basic)) {
      request.log.info({ reason: basic.error.reason }, 'basic auth rejected');
      await reply.code(401).send({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid credentials' },
      });
      return;
    }
    principal = basic.value;
  } else if (ctx.jwtAuth && bearer && looksLikeJwt(bearer)) {
    const jwtPrincipal = await resolveJwtPrincipal(bearer, ctx.jwtAuth);
    if (!jwtPrincipal) {
      request.log.info('jwt auth rejected');
      await reply.code(401).send({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid credentials' },
      });
      return;
    }
    principal = jwtPrincipal;
  } else {
    const auth = await resolveVirtualKey(
      { apiKey: headerValue(request, 'x-api-key'), bearer },
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
    principal = auth.value;
  }

  // --- authz: model + provider scope (candidates filtered to allowed providers) ---
  if (!scopeAllowsModel(principal.scope, requestedModel)) {
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'model not permitted' } });
    return;
  }
  const sessionKey = ctx.sessionAffinityHeader
    ? (headerValue(request, ctx.sessionAffinityHeader) ?? principal.id)
    : undefined;
  const candidates = selectCandidates(strategy, ctx.breaker, {
    sessionKey,
    scoreboard: ctx.scoreboard,
  }).filter((t) => scopeAllowsProvider(principal.scope, t.provider));
  if (candidates.length === 0) {
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'not permitted' } });
    return;
  }
  const provider0 = candidates[0]?.provider ?? 'unknown';

  // Build the CEL activation once, shared by authorization and transformation.
  const transformActive = ctx.transformer?.active === true;
  const activation =
    ctx.authorizer || transformActive
      ? buildAuthzActivation(request, principal, requestedModel, provider0, parsed)
      : undefined;

  // --- CEL authorization: operator-defined allow/deny rules over the request ---
  if (ctx.authorizer && activation) {
    const decision = ctx.authorizer.authorize(activation);
    if (!decision.allowed) {
      await ctx.audit.append({
        orgId: principal.scope.orgId,
        actor: principal.id,
        action: 'authz.denied',
        target: provider0,
        payload: { model: requestedModel, reason: decision.reason },
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
      });
      await reply.code(403).send({
        type: 'error',
        error: { type: 'permission_error', message: 'not permitted by policy' },
      });
      return;
    }
  }

  // --- CEL transformation: mutate request headers/body (before guardrails/cache) ---
  let forwardHeaders: Record<string, string | string[] | undefined> = request.headers;
  let respHeaderChanges: HeaderChanges | undefined;
  if (transformActive && ctx.transformer && activation) {
    const reqCh = ctx.transformer.requestHeaderChanges(activation);
    if (Object.keys(reqCh.set).length > 0 || reqCh.remove.length > 0) {
      forwardHeaders = { ...request.headers };
      for (const [k, v] of Object.entries(reqCh.set)) forwardHeaders[k] = v;
      for (const k of reqCh.remove) delete forwardHeaders[k];
    }
    const patch = ctx.transformer.requestBodyPatch(activation);
    if (Object.keys(patch).length > 0) {
      parsed = { ...parsed, ...patch };
      body = Buffer.from(JSON.stringify(parsed), 'utf8');
    }
    respHeaderChanges = ctx.transformer.responseHeaderChanges(activation);
  }

  // --- rate limit: RPM/TPM admission control (before guardrails/cache/budget) ---
  // Requests are charged now (known at admission); token spend is trued up in the
  // teardown / cache-hit path once the response is metered. Rejections carry the
  // standard x-ratelimit-* + retry-after headers.
  let rlRules: RateLimit[] = [];
  let rlHeaders: Record<string, string> = {};
  if (ctx.rateLimiter) {
    const { outcome, rules } = await ctx.rateLimiter.check(principal.scope.workspaceId, requestId);
    rlRules = rules;
    rlHeaders = rateLimitHeaders(outcome);
    if (!outcome.allowed) {
      await ctx.audit.append({
        orgId: principal.scope.orgId,
        actor: principal.id,
        action: 'ratelimit.rejected',
        target: provider0,
        payload: {
          model: requestedModel,
          rule: outcome.limiting?.rule.id,
          unit: outcome.limiting?.rule.unit,
          limit: outcome.limiting?.rule.limit,
        },
      });
      ctx.telemetry.recordRequest({
        provider: provider0,
        requestModel: requestedModel,
        responseModel: requestedModel,
        route: candidates[0]?.upstreamPath ?? '',
        statusCode: 429,
        status: 'error',
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        streamed: false,
        startedAtMs: started,
      });
      await reply
        .code(429)
        .headers(rlHeaders)
        .send({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'rate limit exceeded' },
        });
      return;
    }
  }

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
    try {
      cacheLookup = await ctx.cache.lookup(cacheReq);
    } catch (err) {
      // The cache is best-effort: an embeddings/vector outage must degrade to a
      // plain proxy, never fail the request.
      request.log.warn({ err }, 'cache lookup failed — bypassing');
      cacheLookup = undefined;
    }
    if (cacheLookup?.response) {
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
        rlRules,
        rlHeaders,
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

  // --- pre-first-byte failover + bounded same-target retry ---
  // The request body is fully buffered, so replaying it to the same target on a
  // transient error is safe (nothing has streamed yet). We retry the same target
  // up to retryMaxAttempts, then fail over to the next candidate.
  const maxAttempts = Math.max(1, ctx.retryMaxAttempts ?? 1);
  const retryBackoffMs = ctx.retryBackoffMs ?? 250;
  let upstream: Awaited<ReturnType<RouteTarget['adapter']['forward']>> | undefined;
  let served: RouteTarget | undefined;
  let scoreboardHeld = false;
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i] as RouteTarget;
    const isLast = i === candidates.length - 1;
    let resp: Awaited<ReturnType<RouteTarget['adapter']['forward']>> | undefined;
    let retryAfterMs: number | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (controller.signal.aborted) break;
      if (attempt > 0) {
        const backoff = Math.min(retryBackoffMs * 2 ** (attempt - 1), 2000);
        await abortableSleep(Math.max(backoff, retryAfterMs ?? 0), controller.signal);
        if (controller.signal.aborted) break;
      }
      try {
        const r = await target.adapter.forward({
          path: target.upstreamPath,
          body,
          headers: forwardHeaders,
          credential: target.credential,
          signal: controller.signal,
        });
        retryAfterMs = parseRetryAfterMs(r.headers);
        // A transient status with attempts left → discard and retry the SAME target.
        if (
          r.statusCode >= 400 &&
          isFailoverStatus(strategy, r.statusCode) &&
          attempt < maxAttempts - 1
        ) {
          ctx.breaker.recordFailure(target.name, retryAfterMs);
          r.body.resume();
          request.log.warn({ target: target.name, status: r.statusCode, attempt }, 'retrying');
          continue;
        }
        resp = r;
        break;
      } catch (err) {
        request.log.warn({ target: target.name, err, attempt }, 'target attempt error');
        if (controller.signal.aborted) break;
        if (attempt < maxAttempts - 1) {
          ctx.breaker.recordFailure(target.name); // connection error → retry same target
          continue;
        }
      }
    }

    if (!resp) {
      // All attempts on this target hard-failed (connection errors) or aborted.
      ctx.breaker.recordFailure(target.name);
      if (controller.signal.aborted) break; // client gone — stop trying
      continue; // fail over to the next candidate
    }

    if (!isLast && resp.statusCode >= 400 && isFailoverStatus(strategy, resp.statusCode)) {
      ctx.breaker.recordFailure(target.name, retryAfterMs);
      ctx.metrics?.recordFailover(target.name);
      resp.body.resume(); // discard the failed body, then try the next target
      request.log.warn({ target: target.name, status: resp.statusCode }, 'failing over');
      continue;
    }
    upstream = resp;
    served = target;
    // Mark this target in-flight for power-of-two-choices least-load; released
    // in teardown (guarded so a double teardown can't double-decrement).
    if (ctx.scoreboard) {
      ctx.scoreboard.begin(target.name);
      scoreboardHeld = true;
    }
    // The breaker should track UPSTREAM faults, not client mistakes: a terminal
    // 4xx (400/401/403/404/422) is the caller's error and must not trip the
    // breaker for every other tenant sharing this target.
    if (resp.statusCode < 400) ctx.breaker.recordSuccess(target.name);
    else if (isFailoverStatus(strategy, resp.statusCode)) {
      ctx.breaker.recordFailure(target.name, retryAfterMs);
    }
    break;
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
  // Opt-in hold-then-flush: buffer a streamed response so the output policy can
  // truly enforce (block/withhold) on the whole body — trading streaming for
  // enforcement on the routes that ask for it.
  const holdStreamed =
    streamed && outputEnforcing && route.holdStreamedOutput === true && statusCode < 400;
  const bufferOutput = (outputEnforcing && !streamed && statusCode < 400) || holdStreamed;

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
    if (scoreboardHeld && served) {
      scoreboardHeld = false;
      ctx.scoreboard?.end(served.name);
    }

    const n = usage.normalized();
    const meteredModel = n.model ?? requestedModel;
    const cost = computeCost(provider, meteredModel, n, ctx.rateResolver);
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

    // Release the reservation FIRST and independently of the best-effort durable
    // sinks below — a failed ledger/requestLog/audit write must never leak the
    // reservation (which would accumulate and DoS the workspace budget).
    if (reserved) {
      try {
        await ctx.budgets.commit(principal.scope.workspaceId, requestId, costMicroUsd);
      } catch (err) {
        request.log.error({ err }, 'budget commit failed');
      }
    }

    // True up the token-rate windows with actual usage (best-effort; the limiter
    // swallows its own errors so a lost true-up under-counts but never blocks).
    if (ctx.rateLimiter && rlRules.length > 0) {
      await ctx.rateLimiter.commit(
        principal.scope.workspaceId,
        rlRules,
        requestId,
        cost.totalInputTokens + cost.outputTokens,
      );
    }

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
        attributes: {
          cache: cacheLookup?.status ?? 'bypass',
          target: served?.name ?? provider,
          ...(guardrailAction ? { guardrailAction } : {}),
          ...(outFindings.length > 0 ? { guardrailOutputFindings: outFindings.length } : {}),
        },
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

  // Decompress a content-encoded upstream so guardrails, usage extraction, and the
  // cache all see real bytes (not gzip), and the client receives plain bytes with
  // the encoding header dropped (filterResponseHeaders strips it). An encoding we
  // can't decode is passed through raw with its header preserved so the client can.
  const rawEncoding = String(upstream.headers['content-encoding'] ?? '')
    .toLowerCase()
    .trim();
  const decompressor =
    rawEncoding && rawEncoding !== 'identity' ? decompressorFor(rawEncoding) : undefined;
  let upstreamBody: Readable = upstream.body;
  if (decompressor) {
    const source = upstream.body;
    // pipe() doesn't forward source errors — bridge them so a broken upstream
    // tears the decompressor (and thus the response) down instead of hanging.
    source.on('error', (e: Error) => decompressor.destroy(e));
    upstreamBody = source.pipe(decompressor);
  }
  const passthroughEncoding =
    rawEncoding && rawEncoding !== 'identity' && !decompressor ? rawEncoding : undefined;

  // Take over the raw socket: raw byte fidelity + guaranteed teardown.
  reply.hijack();
  if (!bufferOutput) {
    const responseHeaders: Record<string, string | string[]> = {
      ...filterResponseHeaders(upstream.headers),
      ...rlHeaders,
      ...(passthroughEncoding ? { 'content-encoding': passthroughEncoding } : {}),
      'x-gulley-request-id': requestId,
      'x-gulley-target': served.name,
      'x-gulley-cache': cacheLookup?.status ?? 'bypass',
    };
    if (respHeaderChanges) {
      for (const [k, v] of Object.entries(respHeaderChanges.set)) responseHeaders[k] = v;
      for (const k of respHeaderChanges.remove) delete responseHeaders[k];
    }
    reply.raw.writeHead(statusCode, responseHeaders);
  }

  const servedTarget = served;
  const upstreamHeaders = upstream.headers;

  // Inactivity watchdog: a stalled upstream (half-open TCP / provider hang) emits
  // neither 'end' nor 'error', so without this teardown never runs and the
  // reservation leaks. Aborting drives the 'error' path → teardown → release.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const resetWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      request.log.warn('upstream stream idle — aborting');
      controller.abort();
    }, STREAM_INACTIVITY_MS);
    watchdog.unref();
  };
  const clearWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };
  resetWatchdog();

  upstreamBody.on('data', (chunk: Buffer) => {
    resetWatchdog();
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
      if (!reply.raw.writableEnded) {
        // Honor backpressure: if the client-bound socket buffer is full, pause
        // the upstream until it drains. Without this a slow reader makes the
        // (bodyTimeout-disabled) upstream fill memory unbounded — an OOM vector.
        const flushed = reply.raw.write(outBuf);
        if (!flushed) {
          upstreamBody.pause();
          reply.raw.once('drain', () => upstreamBody.resume());
        }
      }
    } catch {
      controller.abort();
    }
  });

  upstreamBody.on('end', () => {
    clearWatchdog();
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

    if (bufferOutput && engine && holdStreamed) {
      // Streamed hold-then-flush: enforce on the whole SSE body. Because we can't
      // re-encode a redaction into SSE frames, any enforcing verdict (block OR
      // would-redact) WITHHOLDS the response (a terminal error frame); otherwise
      // flush the buffered SSE, detokenized.
      const text = Buffer.concat(fullChunks).toString('utf8');
      const out = engine.inspectOutputText(text);
      outputEnforced = out;
      const withhold = out.blocked || out.transformedText !== undefined;
      const bodyOut = withhold
        ? providerErrorFrame(provider, 'response withheld by guardrail')
        : detok
          ? detok.push(text) + detok.flush()
          : text;
      if (!reply.raw.writableEnded) {
        reply.raw.writeHead(statusCode, {
          ...filterResponseHeaders(upstreamHeaders),
          ...rlHeaders,
          'content-type': 'text/event-stream',
          'x-gulley-request-id': requestId,
          'x-gulley-target': servedTarget.name,
          'x-gulley-cache': 'bypass',
          'x-gulley-guardrail': withhold ? 'output-blocked' : 'audit',
        });
        reply.raw.write(bodyOut);
        reply.raw.end();
      }
    } else if (bufferOutput && engine) {
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
          ...rlHeaders,
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
    clearWatchdog();
    status = controller.signal.aborted ? 'aborted' : 'error';
    request.log.error({ err }, 'upstream stream error');
    if (!reply.raw.writableEnded) {
      // A raw pipe that just ends mid-stream leaves the client with a truncated,
      // unparseable response. If we're streaming and the client is still here,
      // emit a clean provider-shaped terminal error event before closing.
      if (streamed && !controller.signal.aborted) {
        try {
          reply.raw.write(providerErrorFrame(provider, 'upstream stream error'));
        } catch {
          /* client already gone */
        }
      }
      reply.raw.end();
    }
    void teardown();
  });
}

/** A terminal SSE error event in the served provider's streaming dialect, so a
 *  mid-stream failure surfaces to the client as a parseable error rather than a
 *  dropped connection. Anthropic-canonical by default; OpenAI/Azure use the
 *  `data: {error}` shape their SDKs expect. */
function providerErrorFrame(provider: string, message: string): string {
  if (provider === 'openai' || provider === 'azure') {
    return `data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`;
  }
  return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`;
}

/** Sleep that resolves early if the request is aborted (client gone / timeout),
 *  so a retry backoff never outlives the request it is backing off for. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** A decompression transform for a Content-Encoding, or undefined for an encoding
 *  we don't handle (caller then passes the bytes through raw). */
function decompressorFor(encoding: string): Transform | undefined {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return undefined;
  }
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
  rlRules: RateLimit[],
  rlHeaders: Record<string, string>,
): Promise<void> {
  const cached = lookup.response;
  if (!cached) return;
  const requestId = request.id;

  reply.hijack();
  reply.raw.writeHead(cached.statusCode, {
    ...filterResponseHeaders(cached.headers),
    ...rlHeaders,
    'x-gulley-request-id': requestId,
    'x-gulley-target': `cache:${lookup.status}`,
    'x-gulley-cache': lookup.status,
    'cache-status': `Gulley; hit`,
  });
  if (!reply.raw.writableEnded) {
    reply.raw.write(cached.body);
    reply.raw.end();
  }

  // A cache hit is still a request for rate-limit purposes; true up its tokens.
  if (ctx.rateLimiter && rlRules.length > 0) {
    await ctx.rateLimiter.commit(
      principal.scope.workspaceId,
      rlRules,
      requestId,
      cached.inputTokens + cached.outputTokens,
    );
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
      attributes: { cache: lookup.status, target: `cache:${lookup.status}` },
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

/** The LLM-aware attribute surface CEL policies evaluate against. */
function buildAuthzActivation(
  request: FastifyRequest,
  principal: Principal,
  model: string,
  provider: string,
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (v === undefined) continue;
    headers[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? '') : v;
  }
  return {
    request: {
      method: request.method,
      path: (request.url ?? '').split('?')[0],
      model,
      provider,
      stream: parsed['stream'] === true,
      source_ip: request.ip ?? '',
      headers,
      body: parsed,
    },
    principal: {
      id: principal.id,
      orgId: principal.scope.orgId,
      workspaceId: principal.scope.workspaceId,
    },
  };
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
