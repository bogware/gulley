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
import { type BudgetDecision, type BudgetStore, estimateWorstCaseMicroUsd } from '@gulley/budget';
import {
  type CacheableRequest,
  type CacheEngine,
  type CacheLookup,
  semanticText,
} from '@gulley/cache';
import { computeCost, emptyUsage, rankPrice, type RateResolver, toMicroUsd } from '@gulley/cost';
import { isErr } from '@gulley/core';
import {
  filterByPolicy,
  type GuardrailEngine,
  type OutputInspection,
  spotlightUntrusted,
  StreamingRedactor,
  StreamingReplacer,
  StreamingScanner,
  type TokenVault,
} from '@gulley/guardrails';
import type { CelAuthorizer, CelTransformer, ExternalAuthorizer, HeaderChanges } from '@gulley/cel';
import {
  extractToolCalls,
  extractToolCallsFromSse,
  governToolCalls,
  type ToolCall,
} from '../tool-governance';
import { type ModelPolicy, modelAllowedByPolicy } from '../model-policy';
import {
  isEmptyResidencyPolicy,
  type ResidencyPolicy,
  residencyAllowedRegions,
} from '../residency-policy';
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
  ResponsesSseRewriter,
  SSEParser,
  type TextTransform,
  type UsageExtractor,
} from '@gulley/providers';
import type { Encryptor } from '@gulley/crypto';
import type { MaskDirection, MaskVaultStore } from '@gulley/storage';
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
  residencyCompliant,
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
import { handlePlaygroundVerify } from './playground';
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
  /** Opt in to M17 windowed in-stream OUTPUT enforcement for THIS route (redact /
   *  reversible-mask / block on a delayed-emit window), independent of the global
   *  `ctx.streamEnforce`. Set per-workspace so a DLP policy enforces on streamed
   *  responses instead of silently degrading to audit-only. */
  streamEnforce?: boolean;
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
  /** Central model allow/deny policy (deployment-wide in single-tenant v1), enforced
   *  at authz on the RESOLVED model; absent = no model-access policy. Hot-swapped on
   *  reconcile (config document ∪ envModelPolicy). */
  modelPolicy?: ModelPolicy;
  /** The env-configured model policy (MODEL_ALLOW/MODEL_DENY), a stable floor that
   *  reconcile unions with the config document so a DB config never drops it. */
  envModelPolicy?: ModelPolicy;
  /** Data-residency / ZDR policy (deployment-wide in single-tenant v1), enforced at
   *  candidate selection on each upstream's declared region/ZDR posture; absent = no
   *  residency restriction. Fail-closed: no compliant upstream ⇒ the request is
   *  refused, never served from a non-compliant region. */
  residencyPolicy?: ResidencyPolicy;
  budgets: BudgetStore;
  /** Soft-threshold budget alerter (metric + webhook); absent = no alerts. */
  budgetAlerter?: { check(workspaceId: string, usedMicroUsd: number, capMicroUsd: number): void };
  /** Budget-aware downshift: at/above `threshold` utilization, rewrite the request
   *  model to the cheaper `model` (must be servable by the route's candidates). */
  budgetDownshift?: { threshold: number; model: string };
  /** Models that carry their own budget cap (multi-level enforcement). When the
   *  requested model is in this set, its `model:<model>` scope is reserved too. */
  budgetModelCaps?: ReadonlySet<string>;
  /** Attribution keys (session/dev/repo/…) that carry their own budget cap — the
   *  runaway-agent control. When the request's attribution has one of these keys, an
   *  `attr:<key>:<value>` scope is reserved too, so a looping session or heavy
   *  developer hits its own cap independent of the workspace. */
  budgetAttrCaps?: ReadonlySet<string>;
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
  /** LLM-leg tool-call intent governance (CEL over the model's tool calls); absent =
   *  tool calls are not governed. Deny withholds the response (non-streamed only). */
  toolPolicy?: CelAuthorizer;
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
  /** Charge the worst-case reservation when a served 2xx model is absent from the
   *  price catalog (priced:false, so it would otherwise meter $0 and slip the
   *  budget). Off-catalog requests are always observed; this makes them fail closed.
   *  Default false. */
  meterFailClosedOnUnpriced?: boolean;
  /** Total pre-first-byte deadline (ms), measured from request entry. Bounds the
   *  dispatch/failover/retry phase; on breach the request aborts with a 504. Absent
   *  = off (only the post-first-byte inactivity watchdog applies). */
  requestDeadlineMs?: number;
  /** Request header names whose values are captured as cost-attribution tags on the
   *  ledger/request-log/audit (already lowercased). Empty/absent = no attribution. */
  attributionHeaders?: string[];
  /** Indirect-injection spotlighting: wrap untrusted request spans (tool_result /
   *  role:"tool" output) in trust-tag delimiters before forwarding. Absent = off. */
  spotlightUntrusted?: boolean;
  /** When spotlighting, also prepend a system directive explaining the delimiters
   *  (higher efficacy; shifts Anthropic prompt-cache breakpoints). Absent = off. */
  spotlightDirective?: boolean;
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
  /** Serve the POST /v1/playground/verify preflight (no upstream call, no spend).
   *  Off leaves the endpoint 404 so it can be disabled in locked-down deployments. */
  playgroundEnabled?: boolean;
  /** Durable mask-reversal store (M22 D): when set (with an encryptor), the mask
   *  token↔original map is envelope-encrypted and persisted in teardown so an
   *  authorized admin can de-tokenize a masked response later. */
  maskVault?: MaskVaultStore;
  /** Envelope encryptor for the mask vault; REQUIRED whenever `maskVault` is set —
   *  the store never receives plaintext. */
  maskVaultEncryptor?: Encryptor;
  /** Retention for a persisted mask-vault record. */
  maskVaultTtlSeconds?: number;
}

const JSON_PARSE_CAP = 8 * 1024 * 1024;
/** Cap the best-effort mask-vault persist so a stalled KMS can't hang teardown. */
const MASK_VAULT_PERSIST_TIMEOUT_MS = 5_000;
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
  /** Swap the central model allow/deny policy (config-derived) on reconcile. */
  swapModelPolicy(modelPolicy: ModelPolicy | undefined): void {
    this.ctx.modelPolicy = modelPolicy;
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

  // Playground preflight — a static POST route, so it wins over the `/*` proxy
  // dispatcher. Reuses the real pipeline components but never proxies or spends.
  app.post('/v1/playground/verify', (req: FastifyRequest, reply: FastifyReply): Promise<void> =>
    handlePlaygroundVerify(holder, req, reply),
  );

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
    // Advertise an id only if a request for it would actually be permitted. Both the
    // per-key scope and the central policy are enforced on the RESOLVED model (after
    // alias/pin rewrite), so resolve the advertised id the same way here — otherwise
    // an alias whose target is denied would be advertised (then 403), or one whose
    // target is allowed would be hidden.
    .filter((id) => {
      const resolved = ctx.modelRouter?.resolve(id)?.resolved ?? id;
      return (
        scopeAllowsModel(principal.scope, resolved) &&
        (!ctx.modelPolicy || modelAllowedByPolicy(ctx.modelPolicy, resolved))
      );
    })
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
  // Cost-attribution tags from configured request headers (repo/branch/PR/session/
  // developer/…), captured once and threaded onto the ledger, request-log, and audit
  // so spend rolls up by any SDLC dimension for chargeback.
  const attribution = buildAttribution(request, ctx.attributionHeaders);
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
  // Central model allow/deny policy (deployment-wide) on the RESOLVED model — a
  // second, config-managed gate beyond the per-key scope, so an admin can deny a
  // model org-wide without touching every key. Audited so a denial is traceable.
  if (ctx.modelPolicy && !modelAllowedByPolicy(ctx.modelPolicy, requestedModel)) {
    await ctx.audit.append({
      orgId: principal.scope.orgId,
      actor: principal.id,
      action: 'policy.model_denied',
      target: requestedModel,
      payload: { model: requestedModel },
    });
    await reply.code(403).send({
      type: 'error',
      error: { type: 'permission_error', message: 'model denied by policy' },
    });
    return;
  }
  const sessionKey = ctx.sessionAffinityHeader
    ? (headerValue(request, ctx.sessionAffinityHeader) ?? principal.id)
    : undefined;
  // Data-residency / ZDR: drop any upstream that does not satisfy the deployment
  // policy BEFORE a target is chosen. Enforced inside selectCandidates so it gates the
  // single-mode return and the all-open pool fallback (never re-admitting an
  // out-of-region target); fail-closed when nothing qualifies.
  const residencyActive = !isEmptyResidencyPolicy(ctx.residencyPolicy);
  const allowedRegions = residencyAllowedRegions(ctx.residencyPolicy);
  const requireZdr = ctx.residencyPolicy?.requireZdr ?? false;
  const candidates = selectCandidates(strategy, ctx.breaker, {
    sessionKey,
    scoreboard: ctx.scoreboard,
    outlier: ctx.outlier,
    // Cost-aware primary pick (loadbalance select:'cheapest'): rank each target by
    // the catalog price of the resolved model for its provider.
    costOf: (t) => rankPrice(t.provider, requestedModel, ctx.rateResolver),
    allowedRegions,
    requireZdr,
  }).filter((t) => scopeAllowsProvider(principal.scope, t.provider));
  if (candidates.length === 0) {
    // Attribute the refusal: if a scope-allowed target existed but none satisfied the
    // residency policy, it is a distinct, auditable residency denial (not a generic
    // no-permitted-provider 403).
    if (residencyActive) {
      const scoped = allTargets(strategy).filter((t) =>
        scopeAllowsProvider(principal.scope, t.provider),
      );
      if (
        scoped.length > 0 &&
        !scoped.some((t) => residencyCompliant(t, allowedRegions, requireZdr))
      ) {
        await ctx.audit.append({
          orgId: principal.scope.orgId,
          actor: principal.id,
          action: 'policy.residency_denied',
          target: requestedModel,
          payload: {
            model: requestedModel,
            allowedRegions: ctx.residencyPolicy?.allowedRegions ?? [],
            requireZdr,
            candidateRegions: scoped.map((t) => t.region ?? null),
          },
        });
        await reply.code(403).send({
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'no upstream satisfies the data-residency policy',
          },
        });
        return;
      }
    }
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

  // The data-residency region of the upstream that actually served the request, set
  // in commitServed. Stamped on the response (x-gulley-served-region) as portable
  // proof of where the request was processed, and recorded in the durable sinks.
  let servedRegion: string | undefined;

  // Apply static + CEL response-header changes to every response writeHead site
  // (the hijacked paths bypass Fastify onSend, and the buffered/hold-then-flush
  // paths previously missed the CEL response transform — this closes that gap).
  // Also stamps the served region here so every proxy writeHead site inherits it.
  const finalizeResp = <T extends Record<string, string | string[]>>(h: T): T => {
    applyHeaderRules(h, ctx.headerModifier?.response);
    if (respHeaderChanges) {
      for (const [k, v] of Object.entries(respHeaderChanges.set)) h[k as keyof T] = v as T[keyof T];
      for (const k of respHeaderChanges.remove) delete h[k];
    }
    if (
      servedRegion &&
      (h as Record<string, string | string[]>)['x-gulley-served-region'] === undefined
    ) {
      (h as Record<string, string | string[]>)['x-gulley-served-region'] = servedRegion;
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

  // --- spotlighting: delimit UNTRUSTED spans (tool output) before anything else ---
  // Runs before the input guardrail (so a scan sees the delimited form) and before
  // the cache lookup (so the key reflects what is forwarded). It is deterministic +
  // structure-preserving, so cache hits are preserved — no `inputMasked` gate.
  if (parseOk && ctx.spotlightUntrusted) {
    const sl = spotlightUntrusted(parsed, { directive: ctx.spotlightDirective });
    if (sl.marked > 0) {
      parsed = sl.body as Record<string, unknown>;
      body = Buffer.from(JSON.stringify(parsed), 'utf8');
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
        attribution,
        candidates[0]?.region,
      );
      return;
    }
  }

  // --- budget: reserve worst-case at admission (hard cap, TOCTOU-safe) ---
  const maxOutput =
    numField(parsed['max_tokens']) ??
    numField(parsed['max_output_tokens']) ??
    DEFAULT_MAX_OUTPUT_TOKENS;
  let worstCase = estimateWorstCaseMicroUsd(
    provider0,
    requestedModel,
    body.length,
    maxOutput,
    ctx.rateResolver, // price admission identically to commit (no reserve/commit disagreement)
  );
  // Every budget scope reserved for THIS request (workspace + any per-model cap),
  // so teardown commits the actual spend to each and a rejection rolls the rest back.
  const reservedScopes: string[] = [];
  let admittedUtilization = 0; // used/cap from the workspace reserve (drives downshift)

  // Reject: release any scopes already reserved for this request, then 402.
  const rejectBudget = async (scope: string, decision: BudgetDecision): Promise<void> => {
    for (const s of reservedScopes) {
      try {
        await ctx.budgets.commit(s, requestId, 0); // release the reservation (spend 0)
      } catch {
        /* best-effort rollback */
      }
    }
    reservedScopes.length = 0;
    request.log.info(
      { scope, cap: decision.capMicroUsd, used: decision.usedMicroUsd },
      'budget exceeded',
    );
    await ctx.audit.append({
      orgId: principal.scope.orgId,
      actor: principal.id,
      action: 'budget.rejected',
      target: provider0,
      payload: {
        scope,
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
  };

  // Workspace budget: reserve worst-case at admission (hard cap, TOCTOU-safe).
  if (worstCase > 0) {
    const decision = await ctx.budgets.reserve(principal.scope.workspaceId, requestId, worstCase);
    if (decision && !decision.allowed) {
      await rejectBudget(principal.scope.workspaceId, decision);
      return;
    }
    if (decision?.allowed) reservedScopes.push(principal.scope.workspaceId);
    if (decision && decision.capMicroUsd > 0) {
      admittedUtilization = decision.usedMicroUsd / decision.capMicroUsd;
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

  // Budget-aware downshift: near the cap, switch to the cheaper configured model
  // (must be servable by this route's candidates). Done BEFORE the per-model reserve
  // so the model budget is charged for the model actually used.
  const downshift = ctx.budgetDownshift;
  if (
    downshift &&
    admittedUtilization >= downshift.threshold &&
    requestedModel !== downshift.model &&
    // Never downshift TO a model the central policy denies — the downshift reassigns
    // the model AFTER the authz gate, so an unchecked target would bypass the policy.
    // If the cheaper model is denied, skip the downshift (keep the allowed model,
    // subject to the budget it was about to breach).
    (!ctx.modelPolicy || modelAllowedByPolicy(ctx.modelPolicy, downshift.model))
  ) {
    request.log.info(
      { from: requestedModel, to: downshift.model, utilization: admittedUtilization },
      'budget-aware model downshift',
    );
    requestedModel = downshift.model;
    parsed['model'] = downshift.model;
    body = Buffer.from(JSON.stringify(parsed), 'utf8');
    // Reprice the worst-case for the CHEAPER model before the per-model reserve below.
    // worstCase was computed for the original (expensive) model; reserving THAT against
    // the downshifted model's own cap spuriously 402s the exact traffic the downshift
    // exists to keep flowing. Teardown's usage-missing charge also now bills the model
    // actually served. The workspace reservation above stays worst-case-conservative
    // (it admits before the downshift decision) and is corrected to actual at commit.
    worstCase = estimateWorstCaseMicroUsd(
      provider0,
      requestedModel,
      body.length,
      maxOutput,
      ctx.rateResolver,
    );
  }

  // Per-model budget (multi-level): the model's own cap must also admit. On
  // rejection the workspace reservation is rolled back so no scope is left holding a
  // reservation for a request that won't run.
  if (worstCase > 0 && ctx.budgetModelCaps?.has(requestedModel)) {
    const modelScope = `model:${requestedModel}`;
    const md = await ctx.budgets.reserve(modelScope, requestId, worstCase);
    if (md && !md.allowed) {
      await rejectBudget(modelScope, md);
      return;
    }
    if (md?.allowed) reservedScopes.push(modelScope);
  }

  // Per-attribution caps (runaway-agent control): reserve an `attr:<key>:<value>`
  // scope for each configured attribution key the request carries — so a looping
  // session or heavy developer hits its OWN cap and is 402'd, independent of the
  // workspace. Every applicable cap must admit; a rejection rolls back all reserved
  // scopes (rejectBudget). Deterministic order so the rejected scope is stable.
  if (worstCase > 0 && ctx.budgetAttrCaps && attribution) {
    for (const key of ctx.budgetAttrCaps) {
      const value = attribution[key];
      if (!value) continue;
      const attrScope = `attr:${key}:${value}`;
      const ad = await ctx.budgets.reserve(attrScope, requestId, worstCase);
      if (ad && !ad.allowed) {
        await rejectBudget(attrScope, ad);
        return;
      }
      if (ad?.allowed) reservedScopes.push(attrScope);
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

  // Total pre-first-byte deadline: abort the dispatch/failover/retry phase if the
  // first byte hasn't arrived within REQUEST_DEADLINE_MS of request entry, so a slow
  // or serially-failing candidate set can't pin the request for N x the per-attempt
  // header timeout. The abort propagates through the abort-aware forward/backoff; the
  // guard on firstByteMs means a fire after first byte is a no-op (the watchdog owns
  // the post-first-byte phase). Relative to `started`, so it is a total budget even
  // though the timer arms here (pre-dispatch stages carry their own timeouts).
  let deadlineExceeded = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (ctx.requestDeadlineMs && ctx.requestDeadlineMs > 0) {
    const remaining = Math.max(0, ctx.requestDeadlineMs - (Date.now() - started));
    deadlineTimer = setTimeout(() => {
      if (firstByteMs === undefined && !controller.signal.aborted) {
        deadlineExceeded = true;
        controller.abort();
      }
    }, remaining);
    deadlineTimer.unref?.();
  }

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
    servedRegion = target.region;
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
        // An abort — client disconnect OR the pre-first-byte deadline — is NOT an
        // upstream fault: free the limiter slot without adapting the limit and do
        // not blame the breaker (mirrors the hedge path). Attributing a gateway/
        // client-side abort to the target would open its circuit and shrink its
        // concurrency ceiling on a healthy upstream. Only a genuine hard failure
        // (connection error, no abort) records a fault + a concurrency drop.
        if (controller.signal.aborted) {
          if (limiterAcquired) ctx.limiter?.release(target.name);
          break;
        }
        ctx.breaker.recordFailure(target.name);
        if (limiterAcquired)
          ctx.limiter?.record(target.name, forwardStart ? Date.now() - forwardStart : 0, true);
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
  // A pre-first-byte deadline breach (no upstream served, we aborted) is a 504
  // Gateway Timeout, distinct from a generic 502 no-usable-upstream.
  let statusCode = upstream?.statusCode ?? (deadlineExceeded ? 504 : 502);
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
  // LLM-leg tool-call governance: evaluate the model's tool calls against the CEL
  // policy — on BOTH streamed and non-streamed responses (a streamed response is
  // buffered and its tool calls reassembled from the SSE, so `stream:true` can't
  // bypass governance). Buffering is required so a denied call withholds the whole
  // response fail-closed before any byte reaches the client's executor.
  const toolGovern = ctx.toolPolicy !== undefined && statusCode < 400;
  const bufferOutput =
    (outputEnforcing && !streamed && statusCode < 400) || holdStreamed || toolGovern;

  // M17: windowed in-stream output enforcement (opt-in) — redacts matched spans,
  // reversibly masks, or blocks on the first violation via a delayed-emit window,
  // trading raw-byte-fidelity + a bounded delay for enforcement. Enabled for the two
  // text-stream shapes we can re-frame — the Anthropic Messages stream
  // (content_block_delta), the OpenAI chat.completions stream (choices[].delta.
  // content), and the OpenAI Responses stream (response.output_text.delta + its
  // echoes, M22 B). Skipped for a hold-then-flush route (it buffers-and-withholds)
  // and for any other client dialect (e.g. /v1/embeddings — left audit-only).
  const anthropicClient = route.clientPaths.some((p) => p.endsWith('/v1/messages'));
  const openaiChatClient = route.clientPaths.some((p) => p.endsWith('/v1/chat/completions'));
  const responsesClient = route.clientPaths.some((p) => p.endsWith('/v1/responses'));
  // Terminal error frames are client-bound, so their SSE shape follows the client's
  // dialect, not the upstream provider (an OpenAI-compatible backend may not be
  // literally "openai").
  const clientDialect: 'openai' | 'anthropic' | 'responses' = anthropicClient
    ? 'anthropic'
    : responsesClient
      ? 'responses'
      : 'openai';
  const streamEnforce =
    streamed &&
    outputEnforcing &&
    // Global toggle (M17) OR a per-route/per-workspace opt-in (DLP default-on).
    (ctx.streamEnforce === true || route.streamEnforce === true) &&
    // Windowed in-stream enforcement is impossible once the body is buffered (its
    // bytes are held, not streamed), so it is OFF whenever the response is buffered
    // — hold-then-flush (holdStreamed) OR a tool policy forcing a buffer. In those
    // cases the buffered-streamed branch enforces the output policy on the whole
    // body instead (see onUpstreamEnd), so enforcement is preserved, not dropped.
    !bufferOutput &&
    statusCode < 400 &&
    (anthropicClient || openaiChatClient || responsesClient);
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
      : responsesClient
        ? new ResponsesSseRewriter(enforceTransform)
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
  // Tool-call governance state (set in onUpstreamEnd, read in teardown for the
  // cache-store gate + telemetry): whether the response carried any tool call, and
  // the first policy-denied call if governance withheld the response.
  let responseHasToolCalls = false;
  let toolBlocked: { call: ToolCall; reason: string } | undefined;

  const teardown = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
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
    // A served model absent from the price catalog meters $0 by definition
    // (priced:false), silently bypassing the budget. Always observe it (metric +
    // durable attribute); optionally fail closed by charging the worst-case reserve
    // so an off-catalog model can't be used to drive real spend past the cap.
    const unpriced = n.seen && !cost.priced && statusCode < 400;
    const chargeUnpriced = unpriced && ctx.meterFailClosedOnUnpriced === true;
    if (unpriced) {
      request.log.warn(
        { provider, model: meteredModel, failClosed: chargeUnpriced },
        'served a model with no catalog price — metering $0 unless fail-closed',
      );
    }
    const chargedWorstCase = meteringFailed || usageMissing || chargeUnpriced;
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

    // Cache ↔ output-enforcement coexistence. Enforcement normally disables caching
    // (storeCache requires !outputEnforcing) because fullChunks holds the RAW upstream
    // bytes and serveFromCache neither re-enforces nor detokenizes on replay — so
    // caching them would serve un-enforced (or masked-token) content. But when the
    // BUFFERED enforcement pass applied NO transform (nothing masked/redacted, not
    // blocked), the raw body IS the enforced body, so it is safe to cache and replay.
    // Masked, redacted, or blocked bodies are still never cached (and streamed
    // enforcement, which doesn't buffer, stays uncached). This lets DLP-enforced routes
    // keep the cache-savings win on the common clean-response case.
    const cacheableMiss = cacheOn && cacheLookup?.status === 'miss' && statusCode < 400;
    // The precise "raw body IS the enforced body" condition is that enforcement
    // produced NO transform: transformedText === undefined. (outFindings.length is a
    // proxy that holds for native detectors but NOT for an output guardrail plugin,
    // which can mask with an empty findings array — so gate on transformedText too,
    // or a plugin-masked body could be cached as raw un-sanitized bytes.)
    const enforcementCacheSafe =
      !outputEnforcing ||
      (bufferOutput &&
        outFindings.length === 0 &&
        outputEnforced?.transformedText === undefined &&
        outputEnforced?.blocked !== true);

    // Release the reservation FIRST and independently of the best-effort durable
    // sinks below — a failed ledger/requestLog/audit write must never leak the
    // reservation (which would accumulate and DoS the budget). Commit the actual
    // spend to EVERY scope reserved at admission (workspace + any per-model cap).
    for (const scope of reservedScopes) {
      try {
        await ctx.budgets.commit(scope, requestId, costMicroUsd);
      } catch (err) {
        request.log.error({ err, scope }, 'budget commit failed');
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
          attributes: attribution,
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
        ...(served?.region ? { servedRegion: served.region } : {}),
        attributes: {
          // Attribution tags FIRST so the authoritative built-in facets below always
          // win a key collision — a tag value is client-supplied and must never
          // shadow the real routing target / cache status.
          ...(attribution ?? {}),
          cache: cacheLookup?.status ?? 'bypass',
          target: served?.name ?? provider,
          ...(guardrailAction ? { guardrailAction } : {}),
          ...(outFindings.length > 0 ? { guardrailOutputFindings: outFindings.length } : {}),
          ...(unpriced ? { unpriced: true } : {}),
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
      // Isolate the audit append: it shares this teardown block with the cache
      // store and mask-vault persist below, so a failure here (a DB blip, or the
      // now-serialized chain contending) must NOT cascade to skip those durable
      // sinks. Log and continue; the reservation was already released above.
      try {
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
            ...(served?.region ? { servedRegion: served.region } : {}),
            ...(unpriced ? { unpriced: true } : {}),
            ...(attribution ? { attribution } : {}),
          },
        });
      } catch (err) {
        request.log.error({ err }, 'audit append failed');
      }
      // Persist to cache — only clean, non-sensitive, non-truncated 2xx bodies.
      if (
        cacheableMiss &&
        enforcementCacheSafe &&
        // Never cache a governed response that carries a tool call: a cache HIT is
        // served without re-running tool-call governance, so caching it would let a
        // later request replay an ungoverned (or now-out-of-policy) tool call.
        !(toolGovern && responseHasToolCalls) &&
        // Never cache a WITHHELD body (guardrail block, tool-policy block, or an
        // ungovernable/undecodable response arm A withheld). enforcementCacheSafe
        // short-circuits to true when no output engine enforces, so this independent
        // guard is what stops a withheld tool-govern response from being cached and
        // then replayed to a byte-identical request that the direct path would deny.
        outputEnforced?.blocked !== true &&
        ctx.cache &&
        cacheReq &&
        cacheLookup &&
        status === 'ok' &&
        statusCode < 400 &&
        // A refusal is HTTP 200 with empty/partial content (stop_reason 'refusal');
        // caching it would serve the refusal to every semantic-cache paraphrase.
        n.stopReason !== 'refusal' &&
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

      // Durable mask-reversal store (M22 D): persist each non-empty mask vault's
      // token↔original map, envelope-encrypted (AAD-bound to request+workspace+
      // direction), so an authorized admin can de-tokenize a masked response later.
      // Encrypt-at-rest only — the store never sees plaintext. Best-effort; the
      // reservation was already released, so a failure here can't leak it.
      const maskStore = ctx.maskVault;
      const maskEncryptor = ctx.maskVaultEncryptor;
      if (maskStore && maskEncryptor) {
        const persistVault = async (
          v: TokenVault | undefined,
          direction: MaskDirection,
        ): Promise<void> => {
          if (!v || v.size === 0) return;
          const ct = await maskEncryptor.encrypt(Buffer.from(JSON.stringify(v.entries()), 'utf8'), {
            keyClass: 'mask-vault',
            aad: `${requestId}:${principal.scope.workspaceId}:${direction}`,
          });
          await maskStore.put({
            requestId,
            direction,
            workspaceId: principal.scope.workspaceId,
            orgId: principal.scope.orgId,
            ciphertext: ct,
            tokenCount: v.size,
            ttlSeconds: ctx.maskVaultTtlSeconds ?? 604_800,
          });
        };
        // Bound the whole persist: a stalled KMS `encrypt` has no request deadline,
        // and teardown is fire-and-forget, so an unbounded hang would leave the
        // teardown promise pending forever (retaining buffers, skipping the
        // telemetry/tracer emit below). The timeout REJECTS so the outer catch runs
        // and teardown always settles; the abandoned encrypt is harmless best-effort.
        await withTimeout(
          (async () => {
            await persistVault(vault, 'input');
            // The buffered-output vault and the stream-output vault are mutually
            // exclusive (a response either buffers or streams enforcement).
            await persistVault(outputEnforced?.vault ?? redactor?.vault, 'output');
          })(),
          MASK_VAULT_PERSIST_TIMEOUT_MS,
          'mask-vault persist',
        );
      }
    } catch (err) {
      request.log.error({ err }, 'metering/audit teardown failed');
    }

    ctx.telemetry.recordRequest({
      provider,
      requestModel: requestedModel,
      responseModel: meteredModel,
      route: served?.upstreamPath ?? route.clientPaths[0] ?? '',
      servedRegion: served?.region,
      statusCode,
      status,
      inputTokens: cost.totalInputTokens,
      outputTokens: cost.outputTokens,
      costMicroUsd,
      cacheSavedMicroUsd: cost.cacheSavedUsd > 0 ? toMicroUsd(cost.cacheSavedUsd) : undefined,
      cacheSavedSource: cost.cacheSavedUsd > 0 ? 'prompt_cache' : undefined,
      unpriced: unpriced || undefined,
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
    statusCode = shed ? 503 : deadlineExceeded ? 504 : 502;
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
      } else if (deadlineExceeded) {
        await reply.code(504).send({
          type: 'error',
          error: { type: 'timeout_error', message: 'request deadline exceeded before first byte' },
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
        // Output finalization threw (e.g. an output-guardrail plugin or a tool-policy
        // CEL eval rejected). In BUFFERED mode no arm reached its writeHead, so a bare
        // end() here would flush Node's default 200 with an empty body — a fail-OPEN
        // that hides a dropped enforcement AND records the request as a success. Fail
        // CLOSED: emit an error status + provider-shaped body, and mark the request an
        // error so teardown does not log it as 'ok'.
        request.log.error({ err }, 'output finalization failed');
        if (!reply.raw.writableEnded) {
          if (!reply.raw.headersSent) {
            status = 'error';
            statusCode = 502;
            try {
              reply.raw.writeHead(
                502,
                finalizeResp({
                  ...rlHeaders,
                  'content-type': streamed ? 'text/event-stream' : 'application/json',
                  'x-gulley-request-id': requestId,
                  'x-gulley-target': servedTarget.name,
                  'x-gulley-cache': 'bypass',
                }),
              );
              reply.raw.write(
                streamed
                  ? providerErrorFrame(clientDialect, 'output finalization failed')
                  : Buffer.from(
                      JSON.stringify({
                        type: 'error',
                        error: { type: 'api_error', message: 'output finalization failed' },
                      }),
                    ),
              );
            } catch {
              /* client already gone */
            }
          }
          reply.raw.end();
        }
      } finally {
        await teardown();
      }
    })();
  });

  async function onUpstreamEnd(): Promise<void> {
    clearWatchdog();
    const tail = decoder ? decoder.end() : '';
    if (tail && outScanner) outScanner.push(tail);

    // Reassemble the model's tool calls for governance: from the buffered SSE on a
    // streamed response, or from the parsed JSON on a non-streamed one. Either way
    // the response is still metered below (the provider generated + billed it).
    let toolCalls: ToolCall[] | undefined;
    if (streamed) {
      try {
        if (tail) usage.ingestSse(parserSse.push(tail));
        usage.ingestSse(parserSse.push('\n\n'));
      } catch {
        /* best-effort */
      }
      if (toolGovern && !captureOverflow && fullBytes > 0) {
        toolCalls = extractToolCallsFromSse(
          Buffer.concat(fullChunks).toString('utf8'),
          clientDialect,
        );
      }
    } else if (fullBytes > 0 && !captureOverflow) {
      try {
        const parsedResp = JSON.parse(Buffer.concat(fullChunks).toString('utf8')) as Record<
          string,
          unknown
        >;
        usage.ingestJson(parsedResp);
        if (toolGovern) toolCalls = extractToolCalls(parsedResp);
      } catch {
        /* unparseable body — still forwarded verbatim */
      }
    }

    // Govern the reassembled/parsed tool calls (streamed + non-streamed share this).
    if (toolGovern && ctx.toolPolicy && toolCalls) {
      responseHasToolCalls = toolCalls.length > 0;
      if (responseHasToolCalls) {
        const gov = governToolCalls(ctx.toolPolicy, toolCalls, {
          model: usage.normalized().model ?? requestedModel,
          provider,
          principal: {
            id: principal.id,
            orgId: principal.scope.orgId,
            workspaceId: principal.scope.workspaceId,
          },
        });
        if (gov.denied) toolBlocked = gov.denied;
      }
    }
    // Fail CLOSED whenever a tool-governed response could NOT be governed: it
    // overflowed the buffer (never fully captured), or it carries an undecodable
    // content-encoding (fullChunks holds compressed bytes, so tool-call extraction
    // sees garbage and finds nothing). Either way a tool_use could reach the executor
    // ungoverned, so withhold rather than forward it.
    const toolGovernUngovernable =
      toolGovern && (captureOverflow || passthroughEncoding !== undefined);

    if (toolBlocked || toolGovernUngovernable) {
      // Withhold the WHOLE response fail-closed (a partial-strip could still leak an
      // unsafe call), audit it, and return a provider-shaped error in the CLIENT's
      // dialect (SSE frame for a streamed request, JSON otherwise). Headers were
      // deferred (bufferOutput), so we write them here exactly once.
      outputEnforced = {
        findings: [],
        summary: { total: 0, categories: {}, maxConfidence: 0 },
        blocked: true,
      };
      const ungovernableReason = captureOverflow ? 'buffer-overflow' : 'undecodable-encoding';
      const message = toolBlocked
        ? `tool call '${toolBlocked.call.name}' denied by policy`
        : 'response could not be governed for tool calls';
      try {
        await ctx.audit.append({
          orgId: principal.scope.orgId,
          actor: principal.id,
          action: 'tool_policy.blocked',
          target: servedTarget.name,
          payload: toolBlocked
            ? { tool: toolBlocked.call.name, reason: toolBlocked.reason }
            : { reason: ungovernableReason },
        });
      } catch (err) {
        request.log.error({ err }, 'tool_policy audit append failed');
      }
      const bodyOut = streamed
        ? Buffer.from(providerErrorFrame(clientDialect, message), 'utf8')
        : Buffer.from(
            JSON.stringify({ type: 'error', error: { type: 'tool_policy_blocked', message } }),
          );
      if (!reply.raw.writableEnded) {
        reply.raw.writeHead(
          statusCode,
          finalizeResp({
            ...filterResponseHeaders(upstreamHeaders),
            ...rlHeaders,
            'content-type': streamed ? 'text/event-stream' : 'application/json',
            'x-gulley-request-id': requestId,
            'x-gulley-target': servedTarget.name,
            'x-gulley-cache': 'bypass',
            'x-gulley-tool-policy': 'blocked',
          }),
        );
        reply.raw.write(bodyOut);
        reply.raw.end();
      }
    } else if (bufferOutput && engine && captureOverflow) {
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
    } else if (bufferOutput && engine && streamed) {
      // Buffered STREAMED response with a guardrail engine — hold-then-flush enforce
      // on the whole SSE body. Reached by an opt-in hold-then-flush route AND by a
      // tool policy forcing a buffer while STREAMING_ENFORCE was configured (windowed
      // in-stream enforcement is impossible once buffered, so the output policy is
      // enforced here instead, never silently dropped). Because we can't re-encode a
      // redaction into SSE frames, any enforcing verdict (block OR would-redact)
      // WITHHOLDS the response (a terminal error frame); an audit-only policy records
      // findings and flushes the buffered SSE, detokenized.
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
    } else if (bufferOutput && engine && !streamed) {
      // Reverse the input mask FIRST (restore the client's own values the model
      // echoed back), THEN enforce the output policy on the real text — mirroring the
      // streaming-enforce transform's order (detok → enforce). Detokenizing AFTER an
      // output mask would be unsafe: input and output vaults mint tokens from the
      // same `<<GULLEY_CAT_n>>` namespace + counter, so a post-mask detok could
      // rewrite an OUTPUT placeholder to an INPUT original (defeating the output mask
      // and leaking cross-direction). Detok-before makes inspectOutput mask the real
      // values with its own fresh tokens, with no collision.
      const raw = Buffer.concat(fullChunks).toString('utf8');
      const text = detok ? detok.push(raw) + detok.flush() : raw;
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
    } else if (bufferOutput) {
      // Buffered with NO guardrail engine — the buffer was forced by tool-call
      // governance and the calls were allowed. (Any engine-bearing buffered response,
      // streamed or not, is handled by the enforcing branches above.) The bytes were
      // held (bufferOutput short-circuits the raw pipe), so write the whole body
      // through now — detokenizing a masked-input stream. Headers were deferred;
      // preserve an undecodable passthrough encoding.
      const buffered = Buffer.concat(fullChunks);
      const bodyOut = detok
        ? Buffer.from(detok.push(buffered.toString('utf8')) + detok.flush(), 'utf8')
        : buffered;
      if (!reply.raw.writableEnded) {
        reply.raw.writeHead(
          statusCode,
          finalizeResp({
            ...filterResponseHeaders(upstreamHeaders),
            ...rlHeaders,
            ...(passthroughEncoding ? { 'content-encoding': passthroughEncoding } : {}),
            'x-gulley-request-id': requestId,
            'x-gulley-target': servedTarget.name,
            'x-gulley-cache': cacheLookup?.status ?? 'bypass',
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
      if (!reply.raw.headersSent) {
        // Buffered mode (headers were NOT flushed eagerly, and onUpstreamEnd never
        // runs on the error path): a mid-stream upstream failure must not surface as
        // an implicit 200. Send an error status + a provider-shaped error body — no
        // bytes reached the client yet, so this cannot corrupt a partial response.
        const code = statusCode >= 400 ? statusCode : 502;
        try {
          reply.raw.writeHead(
            code,
            finalizeResp({
              ...rlHeaders,
              'content-type': streamed ? 'text/event-stream' : 'application/json',
              'x-gulley-request-id': requestId,
              'x-gulley-target': servedTarget.name,
              'x-gulley-cache': 'bypass',
            }),
          );
          reply.raw.write(
            streamed
              ? providerErrorFrame(clientDialect, 'upstream stream error')
              : Buffer.from(
                  JSON.stringify({
                    type: 'error',
                    error: { type: 'api_error', message: 'upstream stream error' },
                  }),
                ),
          );
        } catch {
          /* client already gone */
        }
      } else if (streamed && !controller.signal.aborted) {
        // Non-buffered stream: headers (200) already flushed and bytes may have been
        // sent, so we can only append a clean terminal error frame before closing —
        // never a fresh body (that would corrupt the partial response).
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
  if (dialect === 'responses') {
    // The Responses stream's top-level error event (analogue of chat's data:{error}
    // and Anthropic's event: error).
    return `event: error\ndata: ${JSON.stringify({ type: 'error', code: null, message, param: null, sequence_number: 0 })}\n\n`;
  }
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
  attribution?: Record<string, string>,
  // The region the request would have been served from (the residency-compliant
  // primary candidate). A cached response is region-consistent under the
  // deployment-wide residency policy, so this is the region the bytes originated in.
  servedRegion?: string,
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
      ...(servedRegion ? { 'x-gulley-served-region': servedRegion } : {}),
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

  // Dollars this gateway cache hit avoided: what the cached response's tokens would
  // have cost at the model's full rate (a hit spends nothing upstream). This is the
  // product's headline "cost avoided" number for its own two-tier cache — it was
  // recorded as $0 before, making the savings invisible. Priced from the same
  // catalog resolver as live metering; 0 for an unpriced model.
  const savedUsd = computeCost(
    provider,
    cached.model,
    { ...emptyUsage(), inputTokens: cached.inputTokens, outputTokens: cached.outputTokens },
    ctx.rateResolver,
  ).totalUsd;
  const savedMicroUsd = savedUsd > 0 ? toMicroUsd(savedUsd) : undefined;

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
      ...(servedRegion ? { servedRegion } : {}),
      attributes: {
        // Attribution tags FIRST so built-in facets below win a key collision.
        ...(attribution ?? {}),
        cache: lookup.status,
        target: `cache:${lookup.status}`,
        ...(savedMicroUsd ? { cacheSavedMicroUsd: savedMicroUsd } : {}),
      },
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
        ...(servedRegion ? { servedRegion } : {}),
        ...(savedMicroUsd ? { cacheSavedMicroUsd: savedMicroUsd } : {}),
        ...(attribution ? { attribution } : {}),
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
    servedRegion,
    statusCode: cached.statusCode,
    status: 'ok',
    inputTokens: cached.inputTokens,
    outputTokens: cached.outputTokens,
    costMicroUsd: 0,
    cacheSavedMicroUsd: savedMicroUsd,
    cacheSavedSource: savedMicroUsd ? 'response_cache' : undefined,
    streamed: cached.streamed,
    startedAtMs: started,
    cacheStatus: lookup.status,
  });
}

/** Max characters for an attribution value. The value flows into the durable
 *  ledger/audit AND becomes a budget counter-key segment (`attr:<key>:<value>`),
 *  so an oversized client header must not be able to bloat a row or a Redis key. */
const ATTRIBUTION_VALUE_MAX_LEN = 128;
/** Reject a value that would corrupt the Redis hash-tag (`{`/`}` delimit the slot
 *  tag) or carries ASCII control bytes — a client header must never be able to mint
 *  pathological / slot-colliding counter keys on the noeviction counters store. */
const ATTRIBUTION_VALUE_UNSAFE_RE = /[{}\p{Cc}]/u;

/** Capture configured request headers as cost-attribution tags. The key is the
 *  header name with a leading `x-gulley-` (then `x-`) stripped and lowercased, so
 *  `X-Gulley-Repo: acme/api` becomes `{ repo: 'acme/api' }`. A value is captured
 *  only when it is a non-empty string within the length bound and free of
 *  key-unsafe bytes (see the constants above) — an over-long or hostile value is
 *  dropped rather than attributed, since it also keys a budget counter. Returns
 *  undefined when nothing matched. */
function buildAttribution(
  request: FastifyRequest,
  headerNames: string[] | undefined,
): Record<string, string> | undefined {
  if (!headerNames || headerNames.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const name of headerNames) {
    const raw = request.headers[name];
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (
      typeof val === 'string' &&
      val.length > 0 &&
      val.length <= ATTRIBUTION_VALUE_MAX_LEN &&
      !ATTRIBUTION_VALUE_UNSAFE_RE.test(val)
    ) {
      const key = name.replace(/^x-gulley-/, '').replace(/^x-/, '');
      if (key) out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

/** Reject after `ms` if `p` hasn't settled — bounds a best-effort teardown sink so
 *  a stalled dependency can never leave the fire-and-forget teardown promise
 *  pending. The abandoned `p` runs on harmlessly; only the wait is bounded. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
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
