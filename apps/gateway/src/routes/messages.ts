import {
  type BasicAuthConfig,
  type KeyStore,
  type Principal,
  resolveBasicPrincipal,
  resolveVirtualKey,
  scopeAllowsModel,
  scopeAllowsProvider,
  scopeGroups,
} from '@gulley/auth';
import { type BudgetStore, estimateWorstCaseMicroUsd } from '@gulley/budget';
import {
  type CacheableRequest,
  type CacheEngine,
  type CacheLookup,
  semanticText,
} from '@gulley/cache';
import { computeCost, rankPrice, type RateResolver, toMicroUsd } from '@gulley/cost';
import { isErr } from '@gulley/core';
import {
  filterByPolicy,
  type GuardrailEngine,
  type OutputInspection,
  StreamingRedactor,
  StreamingReplacer,
  StreamingScanner,
  type TokenVault,
} from '@gulley/guardrails';
import type { CelAuthorizer, CelTransformer, ExternalAuthorizer, HeaderChanges } from '@gulley/cel';
import { applyHeaderRules, type HeaderModifierConfig, type RequestMirror } from '@gulley/http-edge';
import type { GatewayMetrics } from '@gulley/metrics';
import { type JwtAuthConfig, looksLikeJwt, resolveJwtPrincipal } from '../jwt-auth';
import type { RequestTracer } from '../tracer';
import { meterClassifierSpend } from '../smart-classifier-meter';
import type { SmartRouter } from '../smart-router';
import type { TenantCredentialResolver } from '../tenant';
import type { TenantRouteResolver } from '../tenant-routes';
import type { AuditSink, Ledger, RequestLogSink, RequestStatus } from '@gulley/pipeline';
import {
  AnthropicSseRewriter,
  OpenAiSseRewriter,
  parseRetryAfterMs,
  SSEParser,
  type TextTransform,
  type UsageExtractor,
} from '@gulley/providers';
import { type RateLimit, type RateLimiter, rateLimitHeaders } from '@gulley/ratelimit';
import {
  allTargets,
  type CircuitBreaker,
  type AdaptiveLimiter,
  type BreakerSync,
  type ClassifierUsage,
  hasShaping,
  isFailoverStatus,
  type LoadScoreboard,
  type ModelRouter,
  type OutlierDetector,
  type RequestShaping,
  type RouteTarget,
  type RoutingStrategy,
  selectCandidates,
  shapeRequestBody,
} from '@gulley/routing';
import {
  type AccessLogFieldEngine,
  type AccessLogSink,
  nextTraceContext,
  type Telemetry,
  type TraceContext,
} from '@gulley/telemetry';
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
  /** Request hedging: if the primary candidate hasn't returned response headers
   *  within this many ms, dispatch the next candidate in parallel and serve
   *  whichever answers first (pre-first-byte only). Overrides the ctx default;
   *  0/undefined = use ctx.hedgeDelayMs. */
  hedgeDelayMs?: number;
}

export interface GatewayContext {
  routes: ProviderRoute[];
  keyStore: KeyStore;
  pepper: string;
  ledger: Ledger;
  requestLog: RequestLogSink;
  audit: AuditSink;
  breaker: CircuitBreaker;
  /** Cross-replica breaker sharing (its refresh timer is stopped on drain). */
  breakerSync?: BreakerSync & { stop(): void };
  /** Per-target adaptive concurrency limiter; absent = no admission ceiling. */
  limiter?: AdaptiveLimiter;
  /** Default request-hedging delay (ms) applied to multi-target routes; a route's
   *  own `hedgeDelayMs` overrides it. Absent/0 = hedging off. */
  hedgeDelayMs?: number;
  /** Per-tenant routing overrides (workspace may reroute a client path). */
  tenantRoutes?: TenantRouteResolver;
  /** Classification-driven smart routing (M15); absent = disabled. Consulted
   *  after authn and only when no per-tenant override pins the request. */
  smartRouter?: SmartRouter;
  budgets: BudgetStore;
  /** Soft-threshold budget alerter (metric + webhook); absent = no alerts. */
  budgetAlerter?: { check(workspaceId: string, usedMicroUsd: number, capMicroUsd: number): void };
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
  /** External policy-service authorization hook (cached); absent = none. */
  externalAuthorizer?: ExternalAuthorizer;
  /** Include the request body in the payload sent to the external policy service.
   *  Default false — the prompt never leaves to a third party unless opted in. */
  externalAuthzSendBody?: boolean;
  /** CEL request/response transformation; absent = no transform. */
  transformer?: CelTransformer;
  /** Inbound JWT/JWKS auth mode; absent = virtual keys only. */
  jwtAuth?: JwtAuthConfig;
  /** Inbound HTTP Basic auth (htpasswd-backed); absent = Basic disabled. */
  basicAuth?: BasicAuthConfig;
  /** In-flight load scoreboard for power-of-two-choices least-load balancing. */
  scoreboard?: LoadScoreboard;
  /** Passive latency-outlier detector (peer-relative slow-target ejection). */
  outlier?: OutlierDetector;
  /** Operator-configurable access-log field engine; absent = no access log. */
  accessLog?: AccessLogFieldEngine;
  /** OTLP logs sink for the access-log record; absent = stdout only. */
  accessLogSink?: AccessLogSink;
  /** W3C trace-context propagation; absent = disabled. */
  tracePropagation?: { sampleRatio: number };
  /** Max bytes buffered for non-streamed metering / output enforcement. */
  responseBufferLimit?: number;
  /** When a buffered-enforcement body exceeds the limit, withhold (true) rather
   *  than forward it unenforced+truncated (false). Default true. */
  bufferFailClosed?: boolean;
  /** Charge the worst-case reservation when a 2xx response emits no provider usage
   *  (rather than billing $0 + refunding), so budgets stay enforced on backends that
   *  omit stream usage. Default false. */
  chargeOnMissingUsage?: boolean;
  /** M17: windowed in-stream output enforcement (redact/block) on Anthropic-
   *  canonical streamed responses; absent/false = streamed output stays audit-only. */
  streamEnforce?: boolean;
  /** Hold-back window (chars) for streaming enforcement. Covers bounded matches;
   *  effectively-unbounded secrets (PEM keys, long JWTs) are start-anchored by the
   *  redactor regardless of window size. Default 512. */
  streamEnforceWindowChars?: number;
  /** Request header whose value pins a session to one target (HRW affinity);
   *  falls back to the principal id. Absent = no affinity (P2C / weighted). */
  sessionAffinityHeader?: string;
  /** Static request/response header set/remove applied to every proxied request
   *  (the non-CEL sibling of the transformer). */
  headerModifier?: HeaderModifierConfig;
  /** Shadow-traffic mirror; fires a sampled copy of the effective request. */
  mirror?: RequestMirror;
  /** Live request tracer feeding the /debug/trace SSE endpoint; absent = off. */
  tracer?: RequestTracer;
  /** Bearer token guarding /debug/trace; the endpoint is only served when set. */
  debugTraceToken?: string;
  /** Multi-tenant upstream credentials — resolves a tenant's own provider key by
   *  workspace; absent = every tenant uses the gateway's default credential. */
  tenantCredentials?: TenantCredentialResolver;
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

/**
 * Holds the live GatewayContext + a path→route index, both swappable at runtime
 * (M13 config hot-reload). Long-lived state (breaker, scoreboard, outlier,
 * budgets, counters, telemetry, connections) stays on the SAME ctx object across
 * a swap — only `routes` (and other config-derived fields) are replaced — so a
 * reconcile never resets it. The request handler reads the holder exactly once at
 * entry, so an in-flight stream + its single teardown finish on the ctx they
 * started with.
 */
export class RouteHolder {
  private index = new Map<string, ProviderRoute>();
  constructor(public ctx: GatewayContext) {
    this.reindex();
  }
  private reindex(): void {
    this.index = new Map();
    for (const route of this.ctx.routes) {
      for (const path of route.clientPaths) this.index.set(path, route);
    }
  }
  routeFor(path: string): ProviderRoute | undefined {
    return this.index.get(path);
  }
  /** Swap the route table (preserving the ctx object + all its live state). */
  swapRoutes(routes: ProviderRoute[]): void {
    this.ctx.routes = routes;
    this.reindex();
  }
  /** Swap the smart router (config-derived, rebuilt with the routes on reconcile). */
  swapSmartRouter(smartRouter: SmartRouter | undefined): void {
    this.ctx.smartRouter = smartRouter;
  }
  /** Swap the model router (config-derived model aliases/pins) on reconcile. */
  swapModelRouter(modelRouter: ModelRouter | undefined): void {
    this.ctx.modelRouter = modelRouter;
  }
  /** Distinct provider names across the current routes (for /ready). */
  providers(): string[] {
    return [
      ...new Set(this.ctx.routes.flatMap((r) => allTargets(r.strategy).map((t) => t.provider))),
    ];
  }
}

export function registerRoutes(app: FastifyInstance, holder: RouteHolder): void {
  // One dispatcher for every proxy path: the route is looked up per request from
  // the swappable holder, so a reconcile that adds/removes/changes routes takes
  // effect for new requests with NO Fastify re-registration. handleProxy resolves
  // holder.ctx ONCE here; it never re-reads it mid-request.
  app.post('/*', (req: FastifyRequest, reply: FastifyReply): Promise<void> | void => {
    const path = (req.url.split('?')[0] ?? req.url) || '/';
    const route = holder.routeFor(path);
    if (!route) {
      return reply.code(404).send({
        type: 'error',
        error: { type: 'not_found', message: 'no route for path' },
      }) as unknown as void;
    }
    return handleProxy(holder.ctx, route, req, reply);
  });
  // Model discovery (OpenAI-shaped list), filtered to the caller's allowed models.
  const modelsHandler = (req: FastifyRequest, reply: FastifyReply): Promise<void> =>
    handleModels(holder.ctx, req, reply);
  for (const path of ['/v1/models', '/openai/v1/models']) app.get(path, modelsHandler);

  // Live request tracer over SSE — only when enabled + token-guarded.
  if (holder.ctx.tracer && holder.ctx.debugTraceToken) {
    app.get('/debug/trace', (req, reply) => handleDebugTrace(holder.ctx, req, reply));
  }
}

/** GET /debug/trace — an SSE stream of recent + live request summaries for an
 *  operator. Bearer-guarded; the payload is credential-free (never content). */
function handleDebugTrace(ctx: GatewayContext, request: FastifyRequest, reply: FastifyReply): void {
  if (bearerToken(request) !== ctx.debugTraceToken) {
    void reply.code(401).send({ type: 'error', error: { type: 'authentication_error' } });
    return;
  }
  const tracer = ctx.tracer;
  if (!tracer) {
    void reply.code(404).send({ type: 'error', error: { type: 'not_found' } });
    return;
  }
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Respect socket backpressure: a slow consumer that stops draining would
  // otherwise buffer every event unbounded (OOM). The tracer is lossy by design,
  // so we DROP events while the socket is backed up and resume on 'drain'.
  let backpressured = false;
  reply.raw.on('drain', () => {
    backpressured = false;
  });
  const writeRaw = (chunk: string): void => {
    if (reply.raw.writableEnded || backpressured) return;
    if (!reply.raw.write(chunk)) backpressured = true;
  };
  const write = (e: unknown): void => writeRaw(`data: ${JSON.stringify(e)}\n\n`);
  for (const e of tracer.recent()) write(e); // replay the ring
  const unsubscribe = tracer.subscribe(write); // then stream live
  // Heartbeat so an idle stream + dead peer is detected and cleaned up.
  const heartbeat = setInterval(() => writeRaw(': ping\n\n'), 15_000);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  reply.raw.on('close', cleanup);
  request.raw.on('close', cleanup);
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
  let createExtractor = route.createExtractor;
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

  // --- per-tenant routing override (most specific: wins over the shared route
  // and the model router) ---
  // A workspace may reroute this client path to its own strategy/provider. Applied
  // after authn (workspace is now known) and before candidate selection. An
  // override that changes provider family carries its own extractor so metering
  // stays correct. Resolve by the route's FULL alias set (route.clientPaths), not
  // the concrete request path — a route is indexed under every alias, so an
  // override keyed under one alias must apply to all of them (else a client could
  // hit a sibling alias to escape the override — a residency/isolation bypass).
  const tenantRoute = ctx.tenantRoutes?.resolve(principal.scope.workspaceId, route.clientPaths);
  if (tenantRoute) {
    strategy = tenantRoute.strategy;
    if (tenantRoute.createExtractor) createExtractor = tenantRoute.createExtractor;
  } else if (ctx.smartRouter && parseOk) {
    // --- smart routing (M15): classify the prompt, reroute by category ---
    // Runs ONLY when no residency pin applies (the tenant override wins outright,
    // per the residency-first rule), and before candidate selection so the cache
    // key, budget, authz, and telemetry all see the effective target/model. It is
    // fail-open: a policy miss, an abstention, or a classifier timeout/error
    // returns no decision, leaving the model-router/route strategy in place.
    // The classifier reports its sub-call usage here ONLY for a `meterClassifier`
    // policy; we meter it independently of the served request's reserve/commit.
    let classifierSpend: ClassifierUsage | undefined;
    const decision = await ctx.smartRouter.route(
      {
        userId: principal.id,
        groups: scopeGroups(principal.scope),
        orgId: principal.scope.orgId,
        workspaceId: principal.scope.workspaceId,
        clientPaths: route.clientPaths,
      },
      semanticText(body),
      {
        onSpend: (u) => {
          classifierSpend = u;
        },
      },
    );
    if (classifierSpend) {
      // Fire-and-forget: the sub-meter is fully self-contained and fail-open (it
      // swallows every error and returns void), so it must NOT gate first byte on
      // durable writes — mirroring the served path, which defers ledger/audit to
      // teardown. Note (data-handling): for an `llm-router`/`embedding` policy the
      // classifier makes a bounded upstream call to the OPERATOR'S OWN provider
      // BEFORE authz/rate-limit/input-guardrails run — so a masking guardrail does
      // not cover the classifier sub-call, and it is not rate-limited. Use
      // `rules-then-llm` with local rules (no egress) where that matters. See
      // docs/M15_SMART_ROUTING.md.
      void meterClassifierSpend(
        ctx,
        {
          id: principal.id,
          orgId: principal.scope.orgId,
          workspaceId: principal.scope.workspaceId,
        },
        requestId,
        classifierSpend,
      );
    }
    if (decision) {
      if (decision.strategy) strategy = decision.strategy;
      if (decision.createExtractor) createExtractor = decision.createExtractor;
      if (decision.model && decision.model !== requestedModel) {
        requestedModel = decision.model;
        parsed['model'] = decision.model;
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
      }
    }
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
    outlier: ctx.outlier,
    // Cost-aware primary pick (loadbalance select:'cheapest'): rank each target by
    // the catalog price of the resolved model for its provider.
    costOf: (t) => rankPrice(t.provider, requestedModel, ctx.rateResolver),
  }).filter((t) => scopeAllowsProvider(principal.scope, t.provider));
  if (candidates.length === 0) {
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'not permitted' } });
    return;
  }
  const provider0 = candidates[0]?.provider ?? 'unknown';

  // Build the CEL activation once, shared by authorization, transformation, and
  // the external policy hook.
  const transformActive = ctx.transformer?.active === true;
  const activation =
    ctx.authorizer || transformActive || ctx.externalAuthorizer
      ? buildAuthzActivation(request, principal, requestedModel, provider0, parsed)
      : undefined;

  const denyByPolicy = async (reason: string | undefined): Promise<void> => {
    await ctx.audit.append({
      orgId: principal.scope.orgId,
      actor: principal.id,
      action: 'authz.denied',
      target: provider0,
      payload: { model: requestedModel, reason },
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
  };

  // --- CEL authorization: operator-defined allow/deny rules over the request ---
  if (ctx.authorizer && activation) {
    const decision = ctx.authorizer.authorize(activation);
    if (!decision.allowed) {
      await denyByPolicy(decision.reason);
      return;
    }
  }

  // --- External authorization hook: delegate to an operator policy service
  // (cached + single-flight). Runs after the cheap local rules. The activation
  // is SANITIZED first: never ship the caller's credential headers, and omit the
  // prompt body unless explicitly opted in — the policy endpoint is a third party
  // whose logs must not become a credential/prompt exfiltration channel. ---
  if (ctx.externalAuthorizer && activation) {
    const req = activation.request as Record<string, unknown>;
    const safeRequest: Record<string, unknown> = {
      method: req['method'],
      path: req['path'],
      model: req['model'],
      provider: req['provider'],
      stream: req['stream'],
      source_ip: req['source_ip'],
    };
    if (ctx.externalAuthzSendBody) safeRequest['body'] = req['body'];
    const decision = await ctx.externalAuthorizer.authorize({
      request: safeRequest,
      principal: activation.principal,
    });
    if (!decision.allowed) {
      await denyByPolicy(decision.reason);
      return;
    }
  }

  // --- distributed-trace propagation: continue/start a W3C trace context ---
  const trace: TraceContext | undefined = ctx.tracePropagation
    ? nextTraceContext(headerValue(request, 'traceparent'), ctx.tracePropagation.sampleRatio)
    : undefined;

  // --- CEL transformation: mutate request headers/body (before guardrails/cache) ---
  let forwardHeaders: Record<string, string | string[] | undefined> = request.headers;
  let respHeaderChanges: HeaderChanges | undefined;
  if (trace || ctx.headerModifier?.request) {
    forwardHeaders = { ...request.headers };
    if (trace) forwardHeaders['traceparent'] = trace.traceparent;
    // Static request header rules (CEL can still override below).
    applyHeaderRules(forwardHeaders, ctx.headerModifier?.request);
  }
  if (transformActive && ctx.transformer && activation) {
    const reqCh = ctx.transformer.requestHeaderChanges(activation);
    if (Object.keys(reqCh.set).length > 0 || reqCh.remove.length > 0) {
      forwardHeaders = { ...forwardHeaders }; // preserve any earlier injection (traceparent)
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

  // Apply static + CEL response-header changes to every response writeHead site
  // (the hijacked paths bypass Fastify onSend, and the buffered/hold-then-flush
  // paths previously missed the CEL response transform — this closes that gap).
  const finalizeResp = <T extends Record<string, string | string[]>>(h: T): T => {
    applyHeaderRules(h, ctx.headerModifier?.response);
    if (respHeaderChanges) {
      for (const [k, v] of Object.entries(respHeaderChanges.set)) h[k as keyof T] = v as T[keyof T];
      for (const k of respHeaderChanges.remove) delete h[k];
    }
    return h;
  };

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
  const worstCase = estimateWorstCaseMicroUsd(
    provider0,
    requestedModel,
    body.length,
    maxOutput,
    ctx.rateResolver, // price admission identically to commit (no reserve/commit disagreement)
  );
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
    // Soft-threshold alert on the admitted utilization (fire-and-forget, off the
    // hot path; the alerter dedups so this is once per level per period).
    if (decision) {
      try {
        ctx.budgetAlerter?.check(
          principal.scope.workspaceId,
          decision.usedMicroUsd,
          decision.capMicroUsd,
        );
      } catch {
        /* never let an alert affect a request */
      }
    }
  }

  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded && !controller.signal.aborted) controller.abort();
  });

  // Shadow traffic: fire-and-forget a sampled copy of the EFFECTIVE (masked/
  // shaped/transformed) request to the mirror target. Fully detached — never
  // awaited, never metered, errors swallowed; can't affect the real request.
  ctx.mirror?.fire(body);

  // --- pre-first-byte failover + bounded same-target retry ---
  // The request body is fully buffered, so replaying it to the same target on a
  // transient error is safe (nothing has streamed yet). We retry the same target
  // up to retryMaxAttempts, then fail over to the next candidate.
  const maxAttempts = Math.max(1, ctx.retryMaxAttempts ?? 1);
  const retryBackoffMs = ctx.retryBackoffMs ?? 250;
  let upstream: Awaited<ReturnType<RouteTarget['adapter']['forward']>> | undefined;
  let served: RouteTarget | undefined;
  let scoreboardHeld = false;
  let limiterHeld = false; // the served target's adaptive-concurrency slot
  let anySaturation = false; // a candidate was skipped because it was at capacity
  let anyRealAttempt = false; // we actually forwarded to at least one upstream
  let dispatchMs: number | undefined; // when we dispatched to the serving target
  let firstByteMs: number | undefined; // when its response headers arrived

  type UpstreamResp = Awaited<ReturnType<RouteTarget['adapter']['forward']>>;

  // Commit a chosen (pre-first-byte) upstream response as the one we serve: record
  // its TTFB to the outlier detector, hold the scoreboard + limiter slots, and
  // update the breaker. Shared by the sequential failover loop and the hedge race
  // so both commit identically.
  const commitServed = (
    target: RouteTarget,
    resp: UpstreamResp,
    fwdStart: number,
    limiterAcquired: boolean,
  ): void => {
    upstream = resp;
    served = target;
    dispatchMs = fwdStart;
    firstByteMs = Date.now();
    ctx.outlier?.recordLatency(
      target.name,
      firstByteMs - fwdStart,
      candidates.map((c) => c.name),
    );
    if (ctx.scoreboard) {
      ctx.scoreboard.begin(target.name);
      scoreboardHeld = true;
    }
    if (limiterAcquired) limiterHeld = true;
    if (resp.statusCode < 400) ctx.breaker.recordSuccess(target.name);
    else if (isFailoverStatus(strategy, resp.statusCode)) {
      ctx.breaker.recordFailure(target.name, parseRetryAfterMs(resp.headers));
    }
  };

  const credentialFor = async (target: RouteTarget): Promise<typeof target.credential> =>
    (await ctx.tenantCredentials?.resolve(principal.scope.workspaceId, target.provider)) ??
    target.credential;

  // --- request hedging (opt-in, pre-first-byte only) ---
  // One hedge branch = a SINGLE forward (no same-target retry — hedging is a
  // cross-target concern) with its own breaker/limiter accounting.
  type BranchResult =
    | {
        kind: 'usable';
        target: RouteTarget;
        resp: UpstreamResp;
        forwardStart: number;
        limiterAcquired: boolean;
      }
    | { kind: 'failed'; target: RouteTarget }
    | { kind: 'saturated'; target: RouteTarget }
    | { kind: 'aborted'; target: RouteTarget };

  const hedgeBranch = async (target: RouteTarget, signal: AbortSignal): Promise<BranchResult> => {
    let limiterAcquired = false;
    if (ctx.limiter) {
      if (!ctx.limiter.tryAcquire(target.name)) {
        anySaturation = true;
        return { kind: 'saturated', target };
      }
      limiterAcquired = true;
    }
    anyRealAttempt = true;
    const forwardStart = Date.now();
    try {
      const resp = await target.adapter.forward({
        path: target.upstreamPath,
        body,
        headers: forwardHeaders,
        credential: await credentialFor(target),
        signal,
      });
      if (resp.statusCode >= 400 && isFailoverStatus(strategy, resp.statusCode)) {
        ctx.breaker.recordFailure(target.name, parseRetryAfterMs(resp.headers));
        if (limiterAcquired) ctx.limiter?.record(target.name, Date.now() - forwardStart, true);
        resp.body.resume();
        return { kind: 'failed', target };
      }
      return { kind: 'usable', target, resp, forwardStart, limiterAcquired };
    } catch (err) {
      if (signal.aborted) {
        // We (or the client) cancelled this branch — not a fault: free the slot
        // without adapting the limit, and don't blame the breaker.
        if (limiterAcquired) ctx.limiter?.release(target.name);
        return { kind: 'aborted', target };
      }
      request.log.warn({ target: target.name, err }, 'hedge branch error');
      ctx.breaker.recordFailure(target.name);
      if (limiterAcquired) ctx.limiter?.record(target.name, Date.now() - forwardStart, true);
      return { kind: 'failed', target };
    }
  };

  const linkChild = (): AbortController => {
    const child = new AbortController();
    if (controller.signal.aborted) child.abort();
    else controller.signal.addEventListener('abort', () => child.abort(), { once: true });
    return child;
  };

  // A branch that lost the race but had already returned headers: drain its body
  // and free its slot (it succeeded; we simply discard it).
  const drainLoser = async (p: Promise<BranchResult>): Promise<void> => {
    const r = await p;
    if (r.kind === 'usable') {
      r.resp.body.resume();
      if (r.limiterAcquired) ctx.limiter?.release(r.target.name);
    }
  };

  type Winner = {
    target: RouteTarget;
    resp: UpstreamResp;
    forwardStart: number;
    limiterAcquired: boolean;
  };

  // Resolve to the first branch that returns a USABLE response, aborting + draining
  // the losers. Non-usable branches (failover/error/saturated) are awaited out; if
  // none is usable, resolve undefined so outer failover continues.
  const firstUsable = async (
    branches: { p: Promise<BranchResult>; ctrl: AbortController }[],
  ): Promise<Winner | undefined> => {
    let pool = branches.map((b, i) => ({ i, tagged: b.p.then((r) => ({ i, r })) }));
    while (pool.length > 0) {
      const { i, r } = await Promise.race(pool.map((x) => x.tagged));
      pool = pool.filter((x) => x.i !== i);
      if (r.kind === 'usable') {
        for (const [j, b] of branches.entries()) if (j !== i) b.ctrl.abort();
        await Promise.all(branches.map((b, j) => (j === i ? Promise.resolve() : drainLoser(b.p))));
        return {
          target: r.target,
          resp: r.resp,
          forwardStart: r.forwardStart,
          limiterAcquired: r.limiterAcquired,
        };
      }
    }
    return undefined;
  };

  // Run the primary; if it hasn't answered within `delayMs`, launch the hedge and
  // race both. Returns the winner (to commit) or the index the sequential loop
  // should resume from (so already-attempted candidates aren't re-forwarded).
  const runHedge = async (
    a: RouteTarget,
    b: RouteTarget,
    delayMs: number,
  ): Promise<{ winner?: Winner; nextIndex: number }> => {
    const ctrlA = linkChild();
    const pA = hedgeBranch(a, ctrlA.signal);
    const raced = await Promise.race([
      pA.then((r) => ({ tag: 'a' as const, r })),
      abortableSleep(delayMs, controller.signal).then(() => ({ tag: 'timer' as const })),
    ]);
    if (raced.tag === 'a') {
      if (raced.r.kind === 'usable') return { winner: raced.r, nextIndex: 2 };
      if (raced.r.kind === 'aborted') return { nextIndex: candidates.length }; // client gone
      return { nextIndex: 1 }; // A failed/saturated fast → failover to B normally
    }
    if (controller.signal.aborted) {
      await drainLoser(pA);
      return { nextIndex: candidates.length };
    }
    const ctrlB = linkChild();
    const pB = hedgeBranch(b, ctrlB.signal);
    const winner = await firstUsable([
      { p: pA, ctrl: ctrlA },
      { p: pB, ctrl: ctrlB },
    ]);
    return { winner, nextIndex: 2 };
  };

  let startIndex = 0;
  const hedgeDelay = route.hedgeDelayMs ?? ctx.hedgeDelayMs ?? 0;
  if (hedgeDelay > 0 && candidates.length >= 2 && !controller.signal.aborted) {
    const hr = await runHedge(
      candidates[0] as RouteTarget,
      candidates[1] as RouteTarget,
      hedgeDelay,
    );
    if (hr.winner)
      commitServed(
        hr.winner.target,
        hr.winner.resp,
        hr.winner.forwardStart,
        hr.winner.limiterAcquired,
      );
    else if (hr.nextIndex >= candidates.length && !controller.signal.aborted)
      // The hedge exhausted the whole candidate list with no usable response and
      // discarded the (drained) failover-status bodies. Re-run the LAST candidate
      // through the sequential path so its genuine failover-status response
      // (provider status + body + Retry-After) is relayed as the last resort —
      // matching the non-hedge failover behavior — instead of a synthetic 502.
      startIndex = candidates.length - 1;
    else startIndex = hr.nextIndex;
  }

  if (!upstream)
    for (let i = startIndex; i < candidates.length; i++) {
      const target = candidates[i] as RouteTarget;
      const isLast = i === candidates.length - 1;
      let resp: Awaited<ReturnType<RouteTarget['adapter']['forward']>> | undefined;
      let retryAfterMs: number | undefined;
      let forwardStart = 0;

      // Adaptive concurrency: a target at its dynamic in-flight ceiling is skipped
      // (a load-shed, NOT a fault — the breaker must not trip). The slot is held for
      // the whole request and released with the observed RTT in teardown / on failover.
      let limiterAcquired = false;
      if (ctx.limiter) {
        if (!ctx.limiter.tryAcquire(target.name)) {
          anySaturation = true;
          request.log.warn({ target: target.name }, 'target at capacity — skipping');
          continue;
        }
        limiterAcquired = true;
      }
      anyRealAttempt = true;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (controller.signal.aborted) break;
        if (attempt > 0) {
          const backoff = Math.min(retryBackoffMs * 2 ** (attempt - 1), 2000);
          await abortableSleep(Math.max(backoff, retryAfterMs ?? 0), controller.signal);
          if (controller.signal.aborted) break;
        }
        try {
          // Multi-tenant isolation: forward with THIS tenant's own provider key
          // when it has one, else the gateway's default (route/env) credential.
          const credential = await credentialFor(target);
          forwardStart = Date.now();
          const r = await target.adapter.forward({
            path: target.upstreamPath,
            body,
            headers: forwardHeaders,
            credential,
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
        if (limiterAcquired)
          ctx.limiter?.record(target.name, forwardStart ? Date.now() - forwardStart : 0, true);
        if (controller.signal.aborted) break; // client gone — stop trying
        continue; // fail over to the next candidate
      }

      if (!isLast && resp.statusCode >= 400 && isFailoverStatus(strategy, resp.statusCode)) {
        ctx.breaker.recordFailure(target.name, retryAfterMs);
        if (limiterAcquired) ctx.limiter?.record(target.name, Date.now() - forwardStart, true);
        ctx.metrics?.recordFailover(target.name);
        resp.body.resume(); // discard the failed body, then try the next target
        request.log.warn({ target: target.name, status: resp.statusCode }, 'failing over');
        continue;
      }
      // Commit this (pre-first-byte) response: outlier TTFB, scoreboard + limiter
      // holds, and the breaker success/terminal-4xx handling — see commitServed.
      commitServed(target, resp, forwardStart, limiterAcquired);
      break;
    }

  const streamed = served?.alwaysStream === true || parsed['stream'] === true;
  const provider = served?.provider ?? provider0;

  const parserSse = new SSEParser();
  const usage = createExtractor();
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

  // M17: windowed in-stream output enforcement (opt-in) — redacts matched spans,
  // reversibly masks, or blocks on the first violation via a delayed-emit window,
  // trading raw-byte-fidelity + a bounded delay for enforcement. Enabled for the two
  // text-stream shapes we can re-frame — the Anthropic Messages stream
  // (content_block_delta) and the OpenAI chat.completions stream (choices[].delta.
  // content). Skipped for a hold-then-flush route (it buffers-and-withholds) and for
  // any other client dialect (e.g. /v1/responses, /v1/embeddings — left audit-only).
  const anthropicClient = route.clientPaths.some((p) => p.endsWith('/v1/messages'));
  const openaiChatClient = route.clientPaths.some((p) => p.endsWith('/v1/chat/completions'));
  // Terminal error frames are client-bound, so their SSE shape follows the client's
  // dialect, not the upstream provider (an OpenAI-compatible backend may not be
  // literally "openai").
  const clientDialect: 'openai' | 'anthropic' = anthropicClient ? 'anthropic' : 'openai';
  const streamEnforce =
    streamed &&
    outputEnforcing &&
    ctx.streamEnforce === true &&
    !holdStreamed &&
    statusCode < 400 &&
    (anthropicClient || openaiChatClient);
  const redactor =
    streamEnforce && engine
      ? new StreamingRedactor(
          engine.combinedDetector(),
          engine.outputPolicy,
          ctx.streamEnforceWindowChars ?? 512,
        )
      : undefined;
  // The client-bound transform: detokenize masked-input values (in logical-text
  // space) BEFORE enforcing, so the enforcer sees the real values. The SSE rewriter
  // is chosen by client dialect — both apply the same text transform.
  const enforceTransform: TextTransform | undefined =
    redactor === undefined
      ? undefined
      : detok
        ? {
            push: (t) => redactor.push(detok.push(t)),
            flush: () => redactor.push(detok.flush()) + redactor.flush(),
          }
        : redactor;
  const enforcer =
    enforceTransform === undefined
      ? undefined
      : openaiChatClient
        ? new OpenAiSseRewriter(enforceTransform)
        : new AnthropicSseRewriter(enforceTransform);

  // Capture the full response when we need it whole: non-streamed metering,
  // buffered enforcement, or a cacheable miss we intend to store.
  const storeCache =
    cacheOn && cacheLookup?.status === 'miss' && !outputEnforcing && statusCode < 400;
  const captureFull = !streamed || bufferOutput || storeCache;
  const bufferLimit = ctx.responseBufferLimit ?? JSON_PARSE_CAP;
  const bufferFailClosed = ctx.bufferFailClosed !== false;
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
    if (limiterHeld && served) {
      limiterHeld = false;
      // RTT for concurrency = full request duration; drop = fault (5xx) or abort.
      const dropped = status === 'aborted' || statusCode >= 500;
      ctx.limiter?.record(served.name, Date.now() - (dispatchMs ?? started), dropped);
    }

    const n = usage.normalized();
    const meteredModel = n.model ?? requestedModel;
    const cost = computeCost(provider, meteredModel, n, ctx.rateResolver);
    // A buffered-enforcement body that overflowed the cap can't be metered (the
    // usage was never parsed), but the provider still generated and billed it.
    // Charge the worst-case reservation rather than $0, so a withheld over-cap
    // response can't be used to drive real provider spend past the budget.
    const meteringFailed = captureOverflow && bufferOutput && !n.seen;
    // A successful response that emitted no usage would bill $0 and fully refund its
    // reservation — opt-in, charge the worst-case reserve instead so a usage-less
    // backend can't slip the budget (mirrors the buffered-overflow charge).
    const usageMissing =
      !n.seen && !meteringFailed && ctx.chargeOnMissingUsage === true && statusCode < 400;
    const chargedWorstCase = meteringFailed || usageMissing;
    const costMicroUsd = chargedWorstCase ? worstCase : toMicroUsd(cost.totalUsd);
    const createdAt = new Date();

    // Output guardrail findings: from the buffered enforcement pass, or the
    // streaming audit scanner, filtered to what the output policy cares about.
    const outFindings = bufferOutput
      ? (outputEnforced?.findings ?? [])
      : redactor
        ? redactor.findings() // already policy-filtered; the windowed enforcer's set
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
      if (n.seen || chargedWorstCase) {
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
      // Operator-configurable access log (credential-free record → CEL field
      // engine → structured log line). Fail-open; never carries headers/content.
      if (ctx.accessLog) {
        const record = ctx.accessLog.build({
          requestId,
          principal: {
            id: principal.id,
            orgId: principal.scope.orgId,
            workspaceId: principal.scope.workspaceId,
          },
          provider,
          target: served?.name ?? provider,
          requestModel: requestedModel,
          responseModel: meteredModel,
          route: served?.upstreamPath ?? route.clientPaths[0] ?? '',
          statusCode,
          status,
          streamed,
          inputTokens: cost.totalInputTokens,
          outputTokens: cost.outputTokens,
          costMicroUsd,
          latencyMs: Date.now() - started,
          cache: cacheLookup?.status ?? 'bypass',
          guardrailAction: guardrailAction ?? null,
          guardrailInputFindings: inputFindings,
          guardrailOutputFindings: outFindings.length,
          ...(trace ? { traceId: trace.traceId } : {}),
        });
        if (record) {
          request.log.info({ access: record }, 'access');
          ctx.accessLogSink?.emit(record); // also ship to the OTLP logs backend
        }
      }
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
      cacheSavedMicroUsd: cost.cacheSavedUsd > 0 ? toMicroUsd(cost.cacheSavedUsd) : undefined,
      streamed,
      stopReason: n.stopReason,
      startedAtMs: started,
      cacheStatus: cacheLookup?.status ?? 'bypass',
      guardrailInputFindings: engine ? inputFindings : undefined,
      guardrailOutputFindings: engine ? outFindings.length : undefined,
      guardrailAction: guardrailAction ?? (outputEnforced?.blocked ? 'block' : undefined),
      traceId: trace?.traceId,
      stages:
        dispatchMs !== undefined && firstByteMs !== undefined
          ? [
              { name: 'admission', startMs: started, endMs: dispatchMs },
              { name: 'upstream.ttfb', startMs: dispatchMs, endMs: firstByteMs },
              { name: 'stream', startMs: firstByteMs, endMs: Date.now() },
            ]
          : undefined,
    });

    // Feed the live request tracer (credential-free summary; per-replica, lossy).
    ctx.tracer?.record({
      requestId,
      traceId: trace?.traceId,
      principalId: principal.id,
      provider,
      model: meteredModel,
      status,
      statusCode,
      streamed,
      latencyMs: Date.now() - started,
      costMicroUsd,
      cache: cacheLookup?.status ?? 'bypass',
      guardrailAction: guardrailAction ?? (outputEnforced?.blocked ? 'block' : undefined),
      ts: Date.now(),
    });
  };

  // No response served. If EVERY candidate was skipped purely for saturation (no
  // real upstream attempt failed), this is backpressure — shed with 503 +
  // Retry-After so the caller backs off, rather than a misleading 502.
  if (!upstream || !served) {
    const shed = anySaturation && !anyRealAttempt;
    status = controller.signal.aborted ? 'aborted' : 'error';
    statusCode = shed ? 503 : 502;
    await teardown();
    if (!reply.sent) {
      if (shed) {
        await reply
          .code(503)
          .header('retry-after', '1')
          .send({
            type: 'error',
            error: { type: 'overloaded_error', message: 'all upstreams at capacity' },
          });
      } else {
        await reply
          .code(502)
          .send({ type: 'error', error: { type: 'api_error', message: 'no upstream available' } });
      }
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
      // Advertise the enforcement MODE up front (the outcome — redacted spans or a
      // terminal error — is signalled in-band, since headers are already flushed).
      ...(streamEnforce ? { 'x-gulley-guardrail': 'stream-enforce' } : {}),
    };
    reply.raw.writeHead(statusCode, finalizeResp(responseHeaders));
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
      if (fullBytes + chunk.length <= bufferLimit) {
        fullChunks.push(chunk);
        fullBytes += chunk.length;
      } else {
        captureOverflow = true;
      }
    }

    let text: string | undefined;
    if (decoder) {
      text = decoder.write(chunk);
      // The windowed enforcer (redactor) supersedes the raw audit scanner: it
      // detects on logical text and its findings() feed the audit trail.
      if (outScanner && text && !redactor) outScanner.push(text);
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
    if (enforcer && text !== undefined) {
      outBuf = Buffer.from(enforcer.push(text), 'utf8'); // windowed redact/block
    } else if (detok && text !== undefined) {
      outBuf = Buffer.from(detok.push(text), 'utf8');
    }
    try {
      if (!reply.raw.writableEnded) {
        // Honor backpressure: if the client-bound socket buffer is full, pause
        // the upstream until it drains. Without this a slow reader makes the
        // (bodyTimeout-disabled) upstream fill memory unbounded — an OOM vector.
        if (outBuf.length > 0) {
          const flushed = reply.raw.write(outBuf);
          if (!flushed) {
            upstreamBody.pause();
            reply.raw.once('drain', () => upstreamBody.resume());
          }
        }
        // M17: a block or fail-closed verdict terminates the stream AFTER the safe
        // prefix was emitted — a terminal SSE error, then abort → single teardown.
        // `enforcer.failClosed` covers the OpenAI rewriter refusing an n>1 stream.
        if (redactor && (redactor.blocked || redactor.failClosed || enforcer?.failClosed)) {
          reply.raw.write(
            providerErrorFrame(
              clientDialect,
              redactor.blocked ? 'response blocked by guardrail' : 'response withheld by guardrail',
            ),
          );
          reply.raw.end();
          clearWatchdog();
          controller.abort();
        }
      }
    } catch {
      controller.abort();
    }
  });

  upstreamBody.on('end', () => {
    // The buffered-output branch consults the async output plugin, so the whole
    // handler runs in an async IIFE with teardown guaranteed in `finally`.
    void (async () => {
      try {
        await onUpstreamEnd();
      } catch (err) {
        request.log.error({ err }, 'output finalization failed');
        if (!reply.raw.writableEnded) reply.raw.end();
      } finally {
        await teardown();
      }
    })();
  });

  async function onUpstreamEnd(): Promise<void> {
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

    if (bufferOutput && engine && captureOverflow) {
      // The response outgrew the buffer limit, so the guardrail could not inspect
      // the whole body (and the raw bytes were not streamed through). Fail closed:
      // withhold rather than forward a truncated, unenforced response.
      const sse = holdStreamed;
      outputEnforced = {
        findings: [],
        summary: { total: 0, categories: {}, maxConfidence: 0 },
        blocked: bufferFailClosed,
      };
      const bodyOut = bufferFailClosed
        ? sse
          ? providerErrorFrame(clientDialect, 'response too large to enforce guardrail')
          : Buffer.from(
              JSON.stringify({
                type: 'error',
                error: { type: 'guardrail_blocked', message: 'response too large to enforce' },
              }),
            )
        : Buffer.concat(fullChunks); // fail-open: forward the truncated prefix
      if (!reply.raw.writableEnded) {
        reply.raw.writeHead(
          statusCode,
          finalizeResp({
            ...filterResponseHeaders(upstreamHeaders),
            ...rlHeaders,
            'content-type': sse ? 'text/event-stream' : 'application/json',
            'x-gulley-request-id': requestId,
            'x-gulley-target': servedTarget.name,
            'x-gulley-cache': 'bypass',
            'x-gulley-guardrail': bufferFailClosed
              ? 'output-blocked-overflow'
              : 'overflow-unenforced',
          }),
        );
        reply.raw.write(bodyOut);
        reply.raw.end();
      }
    } else if (bufferOutput && engine && holdStreamed) {
      // Streamed hold-then-flush: enforce on the whole SSE body. Because we can't
      // re-encode a redaction into SSE frames, any enforcing verdict (block OR
      // would-redact) WITHHOLDS the response (a terminal error frame); otherwise
      // flush the buffered SSE, detokenized.
      const text = Buffer.concat(fullChunks).toString('utf8');
      const out = await engine.inspectOutput(text);
      outputEnforced = out;
      const withhold = out.blocked || out.transformedText !== undefined;
      const bodyOut = withhold
        ? providerErrorFrame(clientDialect, 'response withheld by guardrail')
        : detok
          ? detok.push(text) + detok.flush()
          : text;
      if (!reply.raw.writableEnded) {
        reply.raw.writeHead(
          statusCode,
          finalizeResp({
            ...filterResponseHeaders(upstreamHeaders),
            ...rlHeaders,
            'content-type': 'text/event-stream',
            'x-gulley-request-id': requestId,
            'x-gulley-target': servedTarget.name,
            'x-gulley-cache': 'bypass',
            'x-gulley-guardrail': withhold ? 'output-blocked' : 'audit',
          }),
        );
        reply.raw.write(bodyOut);
        reply.raw.end();
      }
    } else if (bufferOutput && engine) {
      // Enforce the output policy on the whole (non-streamed) body, then write.
      const text = Buffer.concat(fullChunks).toString('utf8');
      const out = await engine.inspectOutput(text);
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
        reply.raw.writeHead(
          statusCode,
          finalizeResp({
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
          }),
        );
        reply.raw.write(bodyOut);
        reply.raw.end();
      }
    } else {
      // Flush the streaming transform's held tail (the windowed enforcer, else the
      // detokenizer) so no bytes are lost at stream end.
      const rest = enforcer ? enforcer.flush() : detok ? detok.flush() : '';
      if (rest && !reply.raw.writableEnded) reply.raw.write(Buffer.from(rest, 'utf8'));
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  }

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
          reply.raw.write(providerErrorFrame(clientDialect, 'upstream stream error'));
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
 *  dropped connection. Keyed on the CLIENT dialect (not the upstream provider),
 *  since the frame is client-bound: Anthropic-canonical by default; the OpenAI
 *  family uses the `data: {error}` shape their SDKs expect. */
function providerErrorFrame(dialect: string, message: string): string {
  if (dialect === 'openai' || dialect === 'azure') {
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
  // Apply the static response header modifier here too — the cache-hit path is a
  // fifth hijacked writeHead site, and skipping it would let a cached header the
  // operator meant to strip (or a header they meant to add, e.g. HSTS) diverge
  // from the miss path. (CEL response transforms don't run on cache hits by
  // design — the CEL activation is request-specific and hits skip that stage.)
  const cacheHeaders = applyHeaderRules(
    {
      ...filterResponseHeaders(cached.headers),
      ...rlHeaders,
      'x-gulley-request-id': requestId,
      'x-gulley-target': `cache:${lookup.status}`,
      'x-gulley-cache': lookup.status,
      'cache-status': `Gulley; hit`,
    },
    ctx.headerModifier?.response,
  );
  reply.raw.writeHead(cached.statusCode, cacheHeaders);
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
