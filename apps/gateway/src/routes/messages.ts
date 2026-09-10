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
import {
  type BudgetDecision,
  type BudgetStore,
  estimateInputTokens,
  estimateWorstCaseMicroUsd,
} from '@gulley/budget';
import {
  type CacheableRequest,
  type CacheEngine,
  type CacheLookup,
  semanticText,
} from '@gulley/cache';
import { computeCost, emptyUsage, rankPrice, type RateResolver, toMicroUsd } from '@gulley/cost';
import { isErr, type Result } from '@gulley/core';
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
import { type CascadePolicy, matchCascade, shouldEscalate } from '../cascade';
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
import { Readable } from 'node:stream';
import type { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
} from 'node:zlib';

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
  /** Per-route override of the semantic (fuzzy) cache tier: `false` disables it for this
   *  route even when the deployment enables semantic caching (for routes where an
   *  approximate near-neighbor answer is unacceptable). undefined = deployment default. */
  semantic?: boolean;
  /** Partition this route's cache by PRINCIPAL, not just workspace — no cross-principal
   *  reuse within a workspace (stricter isolation, lower hit rate). Default off
   *  (workspace-scoped: one trust domain in the single-tenant model). */
  cachePerPrincipal?: boolean;
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
  /** Cascade routing policies (deployment-wide in single-tenant v1). When the resolved
   *  model matches a policy, tier-0 is buffered and — on an inadequate stop_reason —
   *  the request is re-dispatched once to the stronger `escalateTo` model before any
   *  client byte. Empty/absent = no cascade. */
  cascade?: CascadePolicy[];
  budgets: BudgetStore;
  /** Behavior when the budget counter store is unreachable at admission: true/undefined
   *  = fail-open (serve without a reservation + audit; the ledger self-heals the
   *  counter), false = fail-closed (503 + Retry-After). */
  budgetFailOpen?: boolean;
  /** Interval (ms) at which a live stream's worst-case reservation is refreshed so the
   *  orphan-sweep can't reap it mid-flight. Absent = no refresh (in-memory store, or a
   *  store without an expiry sweep). */
  budgetReserveRefreshMs?: number;
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
  /** Gateway-brokered OAuth resolver: verifies an opaque `gko_at_` access token (minted
   *  by the control-plane broker) read-only against the shared grant store and returns a
   *  data-plane Principal. Absent = brokered inference auth disabled. Fail-closed. */
  brokerResolver?: (token: string) => Promise<Result<Principal, { reason: string }>>;
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
  /** Post-first-byte inactivity watchdog (ms): a stalled upstream (headers sent, then no
   *  bytes and no end/error) is aborted after this idle gap so it can't pin the client
   *  socket + the budget reservation indefinitely. Also bounds a buffered cascade leg's
   *  idle. Zod-validated in production; absent (tests/smoke scripts) ⇒
   *  DEFAULT_STREAM_INACTIVITY_MS. */
  streamInactivityMs?: number;
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
// The post-first-byte inactivity watchdog budget lives on the (Zod-validated)
// GatewayContext as `streamInactivityMs`, threaded through so it isn't captured from raw
// process.env at module-load time. This is only the fallback for a context that omits it
// (tests / smoke scripts); production always sets it from config.STREAM_INACTIVITY_MS.
const DEFAULT_STREAM_INACTIVITY_MS = 120_000;
/** Responses over this size are streamed through but never cached. */
const CACHE_BODY_CAP = 2 * 1024 * 1024;
/** Hard deadline for the whole cache lookup (exact read + embed + vector query). The
 *  cache is best-effort, so a hung store must degrade to a plain proxy, not stall the
 *  request forever before budget/dispatch. */
const CACHE_LOOKUP_TIMEOUT_MS = Number(process.env['CACHE_LOOKUP_TIMEOUT_MS']) || 2_000;
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

/** Drain a Readable fully into buffered chunks, capped at `limit` bytes. On overflow it
 *  KEEPS draining to the end (so the socket is freed) but stops capturing and reports
 *  overflow=true. Rejects if `signal` aborts. Used by cascade routing to buffer a
 *  response leg so it can be evaluated + replayed. */
async function readFully(
  body: Readable,
  limit: number,
  signal: AbortSignal,
  inactivityMs: number,
): Promise<{ chunks: Buffer[]; bytes: number; overflow: boolean }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      body.off('data', onData);
      body.off('end', onEnd);
      body.off('error', onError);
    };
    const fail = (err: Error): void => {
      cleanup();
      body.destroy();
      reject(err);
    };
    // Inactivity guard: a half-open upstream (2xx headers, then no bytes, no end/error)
    // must NOT pin the budget reservation — mirror the streaming watchdog so a stall
    // rejects and the caller fails closed. (The pre-first-byte deadline is already inert
    // here, and undici's bodyTimeout is disabled for SSE.)
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('cascade leg idle')), inactivityMs);
      timer.unref?.();
    };
    const onData = (chunk: Buffer): void => {
      arm();
      if (overflow) return; // still draining the tail; no longer capturing
      if (bytes + chunk.length <= limit) {
        chunks.push(chunk);
        bytes += chunk.length;
      } else {
        overflow = true;
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve({ chunks, bytes, overflow });
    };
    const onError = (err: Error): void => fail(err);
    const onAbort = (): void => fail(new Error('aborted while buffering a cascade leg'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    body.on('data', onData);
    body.once('end', onEnd);
    body.once('error', onError);
    arm();
  });
}

/** Decompress a buffered body per its content-encoding, for cascade signal evaluation
 *  ONLY — the raw bytes are replayed to the client unchanged, so this never has to be
 *  byte-exact. Best-effort: an unknown or failing codec yields the raw bytes. */
function decodeForEval(buf: Buffer, encoding: string | string[] | undefined): Buffer {
  const enc = (Array.isArray(encoding) ? encoding[0] : encoding)?.toLowerCase();
  try {
    if (enc === 'gzip') return gunzipSync(buf);
    if (enc === 'deflate') return inflateSync(buf);
    if (enc === 'br') return brotliDecompressSync(buf);
  } catch {
    /* fall through to the raw bytes */
  }
  return buf;
}

/** Emit a request metric without ever letting a telemetry fault escape into the
 *  request/teardown path (a throw here must not turn a clean 4xx into a 500, nor
 *  reject the fire-and-forget teardown promise and skip the tracer/span close). */
function safeRecord(
  ctx: GatewayContext,
  log: { error: (obj: object, msg?: string) => void },
  args: Parameters<Telemetry['recordRequest']>[0],
): void {
  try {
    ctx.telemetry.recordRequest(args);
  } catch (err) {
    log.error({ err }, 'telemetry recordRequest failed');
  }
}

async function handleProxy(
  ctx: GatewayContext,
  route: ProviderRoute,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Append an audit row without letting a sink fault escape the request path: a
  // pre-stream denial (401/402/403/429) awaits its audit BEFORE the reply is sent,
  // so a throwing audit.append would turn a clean 4xx into a 500 with the denial
  // unlogged. Log and continue — the denial (and its status) still reaches the client.
  const auditSafe = async (entry: Parameters<AuditSink['append']>[0]): Promise<void> => {
    try {
      await ctx.audit.append(entry);
    } catch (err) {
      request.log.error({ err, action: entry.action }, 'audit append failed');
    }
  };
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

  // Emit a metric + span for a pre-dispatch DENIAL (401/403) so auth-failure rate and
  // policy/residency refusals are observable — a credential-stuffing burst of 401s would
  // otherwise be invisible on /metrics and in traces. The model label is bucketed to
  // '__unmetered__' on non-2xx (it's the unverified client model), so this adds no
  // cardinality. Kept minimal (no principal/route needed).
  const recordDenied = (statusCode: number, provider = 'unknown'): void =>
    safeRecord(ctx, request.log, {
      provider,
      requestModel: requestedModel,
      responseModel: requestedModel,
      route: '',
      statusCode,
      status: 'error',
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      streamed: false,
      startedAtMs: started,
    });

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
      recordDenied(401);
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
      recordDenied(401);
      await reply.code(401).send({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid credentials' },
      });
      return;
    }
    principal = jwtPrincipal;
  } else if (ctx.brokerResolver && bearer && bearer.startsWith('gko_at_')) {
    // Gateway-brokered OAuth: an opaque `gko_at_` access token is its own credential
    // channel (distinct prefix), so this is deterministic and FAILS CLOSED with no
    // fall-through to the virtual-key path. Read-only verify (lookup + secret + expiry).
    const brokered = await ctx.brokerResolver(bearer);
    if (isErr(brokered)) {
      request.log.info({ reason: brokered.error.reason }, 'broker token rejected');
      recordDenied(401);
      await reply.code(401).send({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid credentials' },
      });
      return;
    }
    principal = brokered.value;
  } else {
    const auth = await resolveVirtualKey(
      { apiKey: headerValue(request, 'x-api-key'), bearer },
      { keyStore: ctx.keyStore, pepper: ctx.pepper },
    );
    if (isErr(auth)) {
      request.log.info({ reason: auth.error.reason }, 'auth rejected');
      recordDenied(401);
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
      const reroutedModel = decision.model;
      // A successful classification can reroute to a model the caller's key is NOT scoped
      // for (or that the model policy denies) — which would turn a valid request into a
      // spurious 403 (fail-CLOSED from a fail-open feature). Guard it: compute whether the
      // rerouted model is denied by the caller's scope or the model policy.
      const reroutedModelDenied =
        reroutedModel !== undefined &&
        reroutedModel !== requestedModel &&
        (!scopeAllowsModel(principal.scope, reroutedModel) ||
          (ctx.modelPolicy !== undefined && !modelAllowedByPolicy(ctx.modelPolicy, reroutedModel)));
      if (reroutedModelDenied && decision.downgradeOnScopeDenied) {
        // Opt-in availability downgrade: keep the ORIGINAL model/strategy and audit the
        // downgrade, rather than applying a reroute the authz gate would 403. Never a
        // silent default — a downgrade could otherwise defeat a security/residency reroute.
        await auditSafe({
          orgId: principal.scope.orgId,
          actor: principal.id,
          action: 'policy.smart_route_downgraded',
          target: requestedModel,
          payload: { rerouted_to: reroutedModel, reason: 'scope_or_policy_denied' },
        });
      } else {
        // Default (prefer-deny) or an in-scope reroute: apply the decision. If the model
        // is out of scope and the policy did NOT opt into downgrade, the authz gate below
        // returns 403 — authz always runs on the RESOLVED model, never the original.
        if (decision.strategy) strategy = decision.strategy;
        if (decision.createExtractor) createExtractor = decision.createExtractor;
        if (reroutedModel !== undefined && reroutedModel !== requestedModel) {
          requestedModel = reroutedModel;
          parsed['model'] = reroutedModel;
          body = Buffer.from(JSON.stringify(parsed), 'utf8');
        }
      }
    }
  }

  // --- authz: model + provider scope (candidates filtered to allowed providers) ---
  if (!scopeAllowsModel(principal.scope, requestedModel)) {
    recordDenied(403);
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'model not permitted' } });
    return;
  }
  // Central model allow/deny policy (deployment-wide) on the RESOLVED model — a
  // second, config-managed gate beyond the per-key scope, so an admin can deny a
  // model org-wide without touching every key. Audited so a denial is traceable.
  if (ctx.modelPolicy && !modelAllowedByPolicy(ctx.modelPolicy, requestedModel)) {
    await auditSafe({
      orgId: principal.scope.orgId,
      actor: principal.id,
      action: 'policy.model_denied',
      target: requestedModel,
      payload: { model: requestedModel },
    });
    recordDenied(403);
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
  let candidates = selectCandidates(strategy, ctx.breaker, {
    sessionKey,
    scoreboard: ctx.scoreboard,
    outlier: ctx.outlier,
    // Cost-aware primary pick (loadbalance select:'cheapest'): rank each target by
    // the catalog price of the resolved model for its provider.
    costOf: (t) => rankPrice(t.provider, requestedModel, ctx.rateResolver),
    allowedRegions,
    requireZdr,
  }).filter((t) => scopeAllowsProvider(principal.scope, t.provider));
  // A stream-only upstream (alwaysStream, e.g. Bedrock) can't serve a NON-streamed
  // request without flipping the client-visible response to SSE. In a multi-target
  // (arbitrage/failover) group, drop such targets for a non-streamed request — but keep
  // them if they are the only option (serving streamed beats failing the request).
  if (parseOk && parsed['stream'] !== true && candidates.length > 1) {
    const nonStreaming = candidates.filter((t) => t.alwaysStream !== true);
    if (nonStreaming.length > 0) candidates = nonStreaming;
  }
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
        await auditSafe({
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
        recordDenied(403);
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
    recordDenied(403);
    await reply
      .code(403)
      .send({ type: 'error', error: { type: 'permission_error', message: 'not permitted' } });
    return;
  }
  const provider0 = candidates[0]?.provider ?? 'unknown';

  // --- cascade arming: if the resolved model matches a cascade policy, prepare the
  // tier-1 (escalation) candidates + a model-swapped body so an inadequate tier-0 can
  // be re-dispatched ONCE (post-buffer, pre-first-byte). Armed only when the escalation
  // target itself clears the same authz gates (scope + model policy) AND has a
  // residency/scope-compliant upstream — otherwise the cascade is disarmed and tier-0
  // is served as-is (a valid, if weaker, answer). Requires a parseable body (the model
  // field must be rewritable). ---
  let cascade:
    | {
        policy: CascadePolicy;
        candidates: RouteTarget[];
        strategy: RoutingStrategy;
        body: Buffer;
        createExtractor: () => UsageExtractor;
        model: string;
        provider: string;
      }
    | undefined;
  const cascadePolicy =
    parseOk && ctx.cascade && ctx.cascade.length > 0
      ? matchCascade(ctx.cascade, requestedModel)
      : undefined;
  if (cascadePolicy) {
    const t1res = ctx.modelRouter?.resolve(cascadePolicy.escalateTo);
    const t1Model = t1res?.resolved ?? cascadePolicy.escalateTo;
    const t1Strategy = t1res?.strategy ?? strategy;
    // Tier-1 shares the route's usage extractor (same clientPath) — matching how the
    // model-router alias path already binds the extractor per route, not per model.
    const t1Extractor = createExtractor;
    const t1Allowed =
      scopeAllowsModel(principal.scope, t1Model) &&
      (!ctx.modelPolicy || modelAllowedByPolicy(ctx.modelPolicy, t1Model));
    const t1Candidates = t1Allowed
      ? selectCandidates(t1Strategy, ctx.breaker, {
          sessionKey,
          scoreboard: ctx.scoreboard,
          outlier: ctx.outlier,
          costOf: (t) => rankPrice(t.provider, t1Model, ctx.rateResolver),
          allowedRegions,
          requireZdr,
        }).filter((t) => scopeAllowsProvider(principal.scope, t.provider))
      : [];
    const t1First = t1Candidates[0];
    if (t1First) {
      cascade = {
        policy: cascadePolicy,
        candidates: t1Candidates,
        strategy: t1Strategy,
        body: Buffer.from(JSON.stringify({ ...parsed, model: t1Model }), 'utf8'),
        createExtractor: t1Extractor,
        model: t1Model,
        provider: t1First.provider,
      };
    }
  }

  // Build the CEL activation once, shared by authorization, transformation, and
  // the external policy hook.
  const transformActive = ctx.transformer?.active === true;
  const activation =
    ctx.authorizer || transformActive || ctx.externalAuthorizer
      ? buildAuthzActivation(request, principal, requestedModel, provider0, parsed)
      : undefined;

  const denyByPolicy = async (reason: string | undefined): Promise<void> => {
    await auditSafe({
      orgId: principal.scope.orgId,
      actor: principal.id,
      action: 'authz.denied',
      target: provider0,
      payload: { model: requestedModel, reason },
    });
    safeRecord(ctx, request.log, {
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
      await auditSafe({
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
      safeRecord(ctx, request.log, {
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
      await auditSafe({
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
      safeRecord(ctx, request.log, {
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
      // Default partition = workspace (shared within the one trust domain). A route may
      // opt into a stricter per-PRINCIPAL partition so no cross-principal reuse occurs
      // (most relevant to the fuzzy semantic tier); it lowers the intra-workspace hit
      // rate, hence per-route opt-in rather than deployment-wide.
      scope: route.cachePerPrincipal
        ? `${principal.scope.workspaceId}~${principal.id}`
        : principal.scope.workspaceId,
      provider: provider0,
      model: requestedModel,
      path: route.clientPaths[0] ?? '',
      body,
      variant: headerValue(request, 'anthropic-beta'),
      semantic: route.semantic,
    };
    try {
      // Bound the whole lookup: exact-store read + embed + vector query. A hung cache
      // Redis / wedged Postgres would otherwise stall the request FOREVER here — before
      // budget and before any dispatch/failover deadline. On timeout, bypass to a plain
      // proxy exactly like the error path (the cache is best-effort).
      cacheLookup = await withTimeout(
        ctx.cache.lookup(cacheReq),
        CACHE_LOOKUP_TIMEOUT_MS,
        'cache lookup',
      );
    } catch (err) {
      // The cache is best-effort: an embeddings/vector outage (or a lookup timeout) must
      // degrade to a plain proxy, never fail or stall the request.
      request.log.warn({ err }, 'cache lookup failed/timed out — bypassing');
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
    // OpenAI reasoning / o-series / gpt-5-class models take `max_completion_tokens`
    // (and reject `max_tokens`); without this a request that sets only that field
    // reserves against the 8k default and can breach the hard cap at scale.
    numField(parsed['max_completion_tokens']) ??
    DEFAULT_MAX_OUTPUT_TOKENS;
  let worstCase = estimateWorstCaseMicroUsd(
    provider0,
    requestedModel,
    body.length,
    maxOutput,
    ctx.rateResolver, // price admission identically to commit (no reserve/commit disagreement)
  );
  // The worst-case of the SERVED leg alone (tier-0 initially; tier-1 after an
  // escalation) — the fail-closed teardown charge surrogate. Distinct from `worstCase`,
  // which a cascade inflates to cover BOTH legs for the RESERVATION only; charging the
  // combined figure as a single-leg surrogate would over-bill every scope.
  let servedWorstCase = worstCase;
  // A cascade may spend BOTH the cheap tier-0 attempt AND the escalated tier-1 call, so
  // reserve worst-case for both up front (TOCTOU-safe); teardown commits the actual sum
  // (and refunds the tier-1 portion when no escalation happens). Held separately so it
  // survives a budget-downshift reprice below (which replaces the tier-0 term).
  const cascadeReserveMicroUsd = cascade
    ? estimateWorstCaseMicroUsd(
        cascade.provider,
        cascade.model,
        cascade.body.length,
        maxOutput,
        ctx.rateResolver,
      )
    : 0;
  worstCase += cascadeReserveMicroUsd;
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
    await auditSafe({
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
    safeRecord(ctx, request.log, {
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

  // Reserve against a scope, tolerating a counter-STORE outage per BUDGET_FAIL_OPEN.
  // A store fault (counters-Redis down/failover) rejects out of ctx.budgets.reserve;
  // without this it would surface as an opaque 500 for every budgeted request. Returns
  // storeError=true (decision undefined) so the caller applies the fail-open/closed
  // policy. The loud alert (audit + log) fires once per request.
  let budgetStoreDown = false;
  const reserveSafe = async (
    scope: string,
  ): Promise<{ decision: BudgetDecision | null; storeError: boolean }> => {
    try {
      return {
        decision: await ctx.budgets.reserve(scope, requestId, worstCase),
        storeError: false,
      };
    } catch (err) {
      if (!budgetStoreDown) {
        budgetStoreDown = true;
        request.log.error({ err, scope }, 'budget store unavailable');
        await auditSafe({
          orgId: principal.scope.orgId,
          actor: principal.id,
          action: 'budget.store_unavailable',
          target: provider0,
          payload: { scope, model: requestedModel, failOpen: ctx.budgetFailOpen !== false },
        });
      }
      return { decision: null, storeError: true };
    }
  };

  // Fail CLOSED on a store outage: roll back any reservation already taken and 503.
  const failBudgetStore = async (): Promise<void> => {
    for (const s of reservedScopes) {
      try {
        await ctx.budgets.commit(s, requestId, 0);
      } catch {
        /* best-effort rollback */
      }
    }
    reservedScopes.length = 0;
    safeRecord(ctx, request.log, {
      provider: provider0,
      requestModel: requestedModel,
      responseModel: requestedModel,
      route: candidates[0]?.upstreamPath ?? '',
      statusCode: 503,
      status: 'error',
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      streamed: false,
      startedAtMs: started,
    });
    await reply
      .code(503)
      .headers({ 'retry-after': '2' })
      .send({
        type: 'error',
        error: { type: 'api_error', message: 'budget store unavailable' },
      });
  };

  // Workspace budget: reserve worst-case at admission (hard cap, TOCTOU-safe).
  if (worstCase > 0) {
    const { decision, storeError } = await reserveSafe(principal.scope.workspaceId);
    if (storeError && ctx.budgetFailOpen === false) {
      await failBudgetStore();
      return;
    }
    if (decision && !decision.allowed) {
      await rejectBudget(principal.scope.workspaceId, decision);
      return;
    }
    if (decision?.allowed) reservedScopes.push(principal.scope.workspaceId);
    if (decision && decision.capMicroUsd > 0) {
      admittedUtilization = decision.usedMicroUsd / decision.capMicroUsd;
      ctx.metrics?.recordBudgetUtilization(admittedUtilization); // headroom trend (bucketed)
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
    // Re-add the cascade tier-1 reserve — the reprice replaces only the tier-0 term, and
    // the per-model / per-attribution caps reserved below must still cover both tiers.
    servedWorstCase = estimateWorstCaseMicroUsd(
      provider0,
      requestedModel,
      body.length,
      maxOutput,
      ctx.rateResolver,
    );
    worstCase = servedWorstCase + cascadeReserveMicroUsd;
  }

  // Per-model budget (multi-level): the model's own cap must also admit. On
  // rejection the workspace reservation is rolled back so no scope is left holding a
  // reservation for a request that won't run.
  if (worstCase > 0 && ctx.budgetModelCaps?.has(requestedModel)) {
    const modelScope = `model:${requestedModel}`;
    const { decision: md, storeError } = await reserveSafe(modelScope);
    if (storeError && ctx.budgetFailOpen === false) {
      await failBudgetStore();
      return;
    }
    if (md && !md.allowed) {
      await rejectBudget(modelScope, md);
      return;
    }
    if (md?.allowed) reservedScopes.push(modelScope);
  }
  // The cascade escalation target has its OWN per-model cap (it will actually run on an
  // escalation) — reserve it too, or tier-1 spend would bypass its cap entirely. Skip
  // when it is the same model as tier-0 (already reserved above).
  if (
    cascade &&
    worstCase > 0 &&
    cascade.model !== requestedModel &&
    ctx.budgetModelCaps?.has(cascade.model)
  ) {
    const t1ModelScope = `model:${cascade.model}`;
    const { decision: t1md, storeError } = await reserveSafe(t1ModelScope);
    if (storeError && ctx.budgetFailOpen === false) {
      await failBudgetStore();
      return;
    }
    if (t1md && !t1md.allowed) {
      await rejectBudget(t1ModelScope, t1md);
      return;
    }
    if (t1md?.allowed) reservedScopes.push(t1ModelScope);
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
      const { decision: ad, storeError } = await reserveSafe(attrScope);
      if (storeError && ctx.budgetFailOpen === false) {
        await failBudgetStore();
        return;
      }
      if (ad && !ad.allowed) {
        await rejectBudget(attrScope, ad);
        return;
      }
      if (ad?.allowed) reservedScopes.push(attrScope);
    }
  }

  // Keep the worst-case reservation from being reaped by the orphan-sweep while a long
  // stream is still in flight: refresh its expiry on a throttled interval (well under
  // the reservation lifetime), fire-and-forget, never per-chunk. A fast request's
  // interval never fires (it's > the request duration).
  let reserveRefresh: ReturnType<typeof setInterval> | undefined;
  const stopReserveRefresh = (): void => {
    if (reserveRefresh) {
      clearInterval(reserveRefresh);
      reserveRefresh = undefined;
    }
  };
  if (ctx.budgets.refresh && ctx.budgetReserveRefreshMs && reservedScopes.length > 0) {
    const refreshFn = ctx.budgets.refresh.bind(ctx.budgets);
    reserveRefresh = setInterval(() => {
      for (const scope of reservedScopes) void refreshFn(scope, requestId).catch(() => {});
    }, ctx.budgetReserveRefreshMs);
    reserveRefresh.unref();
  }

  const controller = new AbortController();
  // CRITICAL: this 'close' handler is registered BEFORE the throwing stream setup
  // (rewriter/detector construction, reply.hijack, writeHead), so it is the reliable
  // cleanup even when teardown() is bypassed. If handleProxy throws after the refresh
  // interval is armed but before the stream 'end'/'error' handlers (which drive
  // teardown) are wired, the socket still closes → this fires → the interval is cleared.
  // Without it, an unref'd interval would refresh the reservation FOREVER, so the
  // orphan-sweep could never reclaim it (a permanent reservation leak → budget DoS).
  reply.raw.on('close', () => {
    stopReserveRefresh();
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
    // A committed response RESOLVES a half-open probe (if this dispatch won one), so the
    // breaker must always record an outcome here or the probe token strands until its
    // self-heal timeout — shedding a healthy upstream with 503 for that window. A
    // failover-status upstream fault re-opens (recordFailure); ANY other committed status
    // — 2xx OR a terminal 4xx (400/401/403/404) — means the upstream is reachable, so it
    // counts as a success (the breaker tracks UPSTREAM faults only; a client 4xx is not
    // one), which clears the probe and, on a half-open target, resets the ejection backoff.
    if (isFailoverStatus(strategy, resp.statusCode)) {
      ctx.breaker.recordFailure(target.name, parseRetryAfterMs(resp.headers));
    } else {
      ctx.breaker.recordSuccess(target.name);
    }
  };

  const credentialFor = async (target: RouteTarget): Promise<typeof target.credential> =>
    (await ctx.tenantCredentials?.resolve(principal.scope.workspaceId, target.provider)) ??
    target.credential;

  // Same-model arbitrage: rewrite the outbound body's model to the id THIS upstream
  // expects (target.modelMap), so one cross-provider group can serve providers whose
  // ids differ for the same logical model. Preserves every other body mutation
  // (guardrail masks, shaping, CEL) by re-parsing the current body. No map / unmapped
  // model / unparseable body ⇒ forwarded verbatim.
  const bodyForTarget = (target: RouteTarget, srcBody: Buffer, clientModel: string): Buffer => {
    const upstreamModel = target.modelMap?.[clientModel];
    if (!upstreamModel) return srcBody;
    try {
      const obj = JSON.parse(srcBody.toString('utf8')) as Record<string, unknown>;
      obj['model'] = upstreamModel;
      return Buffer.from(JSON.stringify(obj), 'utf8');
    } catch {
      return srcBody;
    }
  };

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
    // Half-open single-probe gate (see the sequential loop): shed a concurrent probe as
    // a saturated branch so the hedge falls over to its sibling / the next candidate.
    if (!ctx.breaker.tryProbe(target.name)) {
      if (limiterAcquired) ctx.limiter?.release(target.name);
      anySaturation = true;
      return { kind: 'saturated', target };
    }
    anyRealAttempt = true;
    const forwardStart = Date.now();
    try {
      const resp = await target.adapter.forward({
        path: target.upstreamPath,
        body: bodyForTarget(target, body, requestedModel),
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
      if (raced.r.kind === 'usable') {
        ctx.metrics?.recordHedge('primary_won'); // primary answered before the hedge delay
        return { winner: raced.r, nextIndex: 2 };
      }
      if (raced.r.kind === 'aborted') return { nextIndex: candidates.length }; // client gone
      return { nextIndex: 1 }; // A failed/saturated fast → failover to B normally
    }
    if (controller.signal.aborted) {
      await drainLoser(pA);
      return { nextIndex: candidates.length };
    }
    const ctrlB = linkChild();
    ctx.metrics?.recordHedge('fired'); // primary slow past the delay — race a second target
    const pB = hedgeBranch(b, ctrlB.signal);
    const winner = await firstUsable([
      { p: pA, ctrl: ctrlA },
      { p: pB, ctrl: ctrlB },
    ]);
    ctx.metrics?.recordHedge(winner?.target.name === b.name ? 'hedge_won' : 'primary_won');
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
      // Half-open single-probe gate: when this target's breaker cooldown has just
      // expired, admit only ONE probe per replica; concurrent callers shed here so the
      // fleet's accumulated load can't stampede (and immediately re-melt) the recovering
      // upstream. A denied probe is a load-shed (like saturation), NOT a fault — the
      // breaker is untouched and the request fails over to the next candidate, or, if
      // none, sheds with 503 + Retry-After (anySaturation && !anyRealAttempt below).
      // Checked at dispatch (not during ordering) so the recovering target still appears
      // healthy for selection but only one caller actually contacts it.
      if (!ctx.breaker.tryProbe(target.name)) {
        if (limiterAcquired) ctx.limiter?.release(target.name);
        anySaturation = true;
        request.log.warn({ target: target.name }, 'half-open probe in flight — shedding');
        continue;
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
            body: bodyForTarget(target, body, requestedModel),
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

  // --- cascade escalation (buffered, pre-first-byte) ---
  // If a cascade is armed and tier-0 returned a 2xx whose provider stop_reason marks it
  // inadequate, meter the tier-0 leg, dispatch the stronger tier-1 model ONCE, and make
  // tier-1 the served response — all before any client byte, so "failover is pre-first-
  // byte only" holds. The chosen leg's bytes are buffered and REPLAYED as the served
  // body, so the derivations + capture + teardown below run unchanged on the final tier.
  // Every billed leg is metered (discarded/over-cap legs at worst-case, never $0, and
  // committed to the reserved scopes). Degrades to serving tier-0 (a valid, weaker
  // answer) on a tier-1 failure/over-cap; a tier-0 stall/error/over-cap fails CLOSED
  // (its bytes can't be replayed byte-exact) but still charges its worst-case.
  let cascadeExtraMicroUsd = 0; // spend on billed cascade legs other than the served one
  const cascadeLedgerRows: Array<{
    suffix: string;
    provider: string;
    model: string;
    /** The model this leg was budget-RESERVED under (its `model:` cap scope), which can
     *  differ from the response's reported model. */
    capModel: string;
    cost: ReturnType<typeof computeCost>;
    micro: number;
  }> = [];
  let cascadeEscalatedFrom: string | undefined;
  if (cascade && upstream && served && upstream.statusCode < 400) {
    const capLimit = ctx.responseBufferLimit ?? JSON_PARSE_CAP;
    const tier0Streamed = served.alwaysStream === true || parsed['stream'] === true;
    // Charge a billed-but-discarded cascade leg at worst-case (never $0/refund) — the
    // provider generated + billed it, and (unlike the served leg) its bytes are NOT
    // replayed to the client, so nothing else meters it. Charged even on a client abort:
    // dropping it would refund real provider spend (violating "always meter on abort").
    const chargeDiscarded = (
      suffix: string,
      provider: string,
      model: string,
      bodyLen: number,
    ): void => {
      const micro = estimateWorstCaseMicroUsd(
        provider,
        model,
        bodyLen,
        maxOutput,
        ctx.rateResolver,
      );
      cascadeExtraMicroUsd += micro;
      cascadeLedgerRows.push({
        suffix,
        provider,
        model,
        capModel: model, // chargeDiscarded is always called with the reserved model
        cost: computeCost(provider, model, emptyUsage(), ctx.rateResolver),
        micro,
      });
    };
    let t0raw: Awaited<ReturnType<typeof readFully>> | undefined;
    try {
      t0raw = await readFully(
        upstream.body,
        capLimit,
        controller.signal,
        ctx.streamInactivityMs ?? DEFAULT_STREAM_INACTIVITY_MS,
      );
    } catch {
      t0raw = undefined; // read error / stall / abort → fail closed below
    }
    if (!t0raw || t0raw.overflow) {
      // Tier-0 could not be buffered (stall/error) or exceeded the cap → fail CLOSED (a
      // mid-body error must not surface as an implicit empty 200). It was billed, so
      // charge its worst-case rather than refunding the reservation.
      chargeDiscarded('cascade-tier0', served.provider, requestedModel, body.length);
      upstream = {
        statusCode: 502,
        headers: { 'content-type': 'application/json' },
        body: Readable.from([
          Buffer.from(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: 'cascade tier-0 response could not be buffered',
              },
            }),
            'utf8',
          ),
        ]),
      };
    } else {
      // Evaluate tier-0's stop_reason from a decoded COPY (the raw bytes replay as-is).
      const t0text = decodeForEval(
        Buffer.concat(t0raw.chunks),
        upstream.headers['content-encoding'],
      ).toString('utf8');
      const t0ex = createExtractor();
      try {
        if (tier0Streamed) {
          const p = new SSEParser({ onOverflow: 'reset' }); // metering: drop, never throw
          t0ex.ingestSse(p.push(t0text));
          t0ex.ingestSse(p.push('\n\n'));
        } else if (t0text.length > 0) {
          t0ex.ingestJson(JSON.parse(t0text) as Record<string, unknown>);
        }
      } catch {
        /* unparseable → no stop_reason → no escalation */
      }
      const t0n = t0ex.normalized();
      let finalStatus = upstream.statusCode;
      let finalHeaders = upstream.headers;
      let finalChunks = t0raw.chunks;
      if (shouldEscalate(cascade.policy, t0n.stopReason)) {
        const t1 = cascade.candidates[0]!;
        // Route the tier-1 escalation through the SAME admission/accounting as a normal
        // candidate (#40) so escalation traffic is not invisible to the resiliency
        // controls: honor the adaptive limiter's in-flight ceiling — a SATURATED strong
        // tier means DO NOT escalate (serve the valid, weaker tier-0 answer rather than
        // pushing the expensive model past its adaptive limit) — and the half-open probe
        // gate; on success feed the load scoreboard (P2C least-load) and the outlier
        // latency detector so both see the escalation target's real load and TTFB.
        let t1LimiterAcquired = false;
        let t1Admitted = true;
        if (ctx.limiter) {
          if (ctx.limiter.tryAcquire(t1.name)) t1LimiterAcquired = true;
          else t1Admitted = false;
        }
        if (t1Admitted && !ctx.breaker.tryProbe(t1.name)) {
          if (t1LimiterAcquired) ctx.limiter?.release(t1.name);
          t1Admitted = false; // half-open probe already in flight → don't escalate
        }
        let resp1: typeof upstream | undefined;
        const t1ForwardStart = Date.now();
        if (t1Admitted) {
          try {
            resp1 = await t1.adapter.forward({
              path: t1.upstreamPath,
              // cascade.body already carries the escalation model; a per-target arbitrage
              // map (keyed by that model) still rewrites it to the upstream's id.
              body: bodyForTarget(t1, cascade.body, cascade.model),
              headers: forwardHeaders,
              credential: await credentialFor(t1),
              signal: controller.signal,
            });
          } catch {
            resp1 = undefined;
            // A genuine connection fault (not an abort) is a breaker fault — mirror the
            // main failover loop, else tier-1's circuit never opens on a hard-down target.
            if (!controller.signal.aborted) ctx.breaker.recordFailure(t1.name);
            // Free the admission slot (fault → adapt the limit down), never leak it.
            if (t1LimiterAcquired) ctx.limiter?.record(t1.name, Date.now() - t1ForwardStart, true);
          }
        }
        if (resp1 && resp1.statusCode < 400) {
          ctx.breaker.recordSuccess(t1.name);
          // Feed the escalation target's real TTFB to the outlier detector, like any
          // served response, so peer-relative slow-target ejection sees tier-1's latency.
          ctx.outlier?.recordLatency(
            t1.name,
            Date.now() - t1ForwardStart,
            cascade.candidates.map((c) => c.name),
          );
          let t1raw: Awaited<ReturnType<typeof readFully>> | undefined;
          try {
            t1raw = await readFully(
              resp1.body,
              capLimit,
              controller.signal,
              ctx.streamInactivityMs ?? DEFAULT_STREAM_INACTIVITY_MS,
            );
          } catch {
            t1raw = undefined;
          }
          if (t1raw && !t1raw.overflow) {
            // Commit to escalation: meter tier-0, release its held slots, make tier-1
            // the served leg.
            const c0 = computeCost(
              served.provider,
              t0n.model ?? requestedModel,
              t0n,
              ctx.rateResolver,
            );
            const c0micro = toMicroUsd(c0.totalUsd);
            cascadeExtraMicroUsd += c0micro;
            cascadeLedgerRows.push({
              suffix: 'cascade-tier0',
              provider: served.provider,
              model: t0n.model ?? requestedModel,
              // requestedModel is still the tier-0 reserved model here (reassigned to
              // the escalation target only below).
              capModel: requestedModel,
              cost: c0,
              micro: c0micro,
            });
            cascadeEscalatedFrom = t0n.model ?? requestedModel;
            if (scoreboardHeld) {
              ctx.scoreboard?.end(served.name);
              scoreboardHeld = false;
            }
            if (limiterHeld) {
              ctx.limiter?.record(served.name, Date.now() - (dispatchMs ?? started), false);
              limiterHeld = false;
            }
            served = t1;
            servedRegion = t1.region;
            createExtractor = cascade.createExtractor;
            requestedModel = cascade.model;
            // The served leg is now tier-1 — its worst-case is the fail-closed surrogate.
            servedWorstCase = cascadeReserveMicroUsd;
            // Hold tier-1's scoreboard + limiter slots as the newly-served target so
            // teardown records ITS in-flight load and RTT (not the released tier-0's).
            // dispatchMs is re-pointed at the tier-1 forward so the limiter RTT is correct.
            if (ctx.scoreboard) {
              ctx.scoreboard.begin(t1.name);
              scoreboardHeld = true;
            }
            if (t1LimiterAcquired) limiterHeld = true;
            dispatchMs = t1ForwardStart;
            finalStatus = resp1.statusCode;
            finalHeaders = resp1.headers;
            finalChunks = t1raw.chunks;
          } else {
            // Tier-1 was a billed 2xx but couldn't be buffered (stall/error/over-cap) →
            // charge it at worst-case and fall back to serving tier-0. The upstream itself
            // was healthy (the cap is ours), so release the slot without a fault penalty.
            if (t1LimiterAcquired) ctx.limiter?.record(t1.name, Date.now() - t1ForwardStart, false);
            chargeDiscarded('cascade-tier1', cascade.provider, cascade.model, cascade.body.length);
          }
        } else if (resp1) {
          // Classify the status against TIER-1's own strategy (it selected this target).
          if (isFailoverStatus(cascade.strategy, resp1.statusCode)) {
            ctx.breaker.recordFailure(t1.name, parseRetryAfterMs(resp1.headers));
          } else {
            // A terminal (non-failover) 4xx means t1 is reachable — record a breaker
            // success so a half-open probe token claimed for t1 is released (else it
            // strands until probeTimeoutMs and sheds t1). Not an upstream fault.
            ctx.breaker.recordSuccess(t1.name);
          }
          // Free the admission slot — a failover-status response adapts the limit down.
          if (t1LimiterAcquired) ctx.limiter?.record(t1.name, Date.now() - t1ForwardStart, true);
          resp1.body.resume(); // tier-1 error → fall back to tier-0
        }
        // t1Admitted === false (saturated / probe-denied) OR resp1 threw: no escalation;
        // the tier-0 leg is served unchanged (its holds stay put for teardown).
      }
      // Replay the chosen leg's buffered bytes as the served body (raw; headers intact).
      upstream = {
        statusCode: finalStatus,
        headers: finalHeaders,
        body: Readable.from(finalChunks.length > 0 ? finalChunks : [Buffer.alloc(0)]),
      };
    }
  }

  const streamed = served?.alwaysStream === true || parsed['stream'] === true;
  const provider = served?.provider ?? provider0;

  // Metering parser: bound its internal buffer and DROP a pathological oversized event
  // (resyncing to the next boundary) rather than throw — metering is best-effort and
  // must never kill the client stream. (The M17/M18 enforcing rewriters keep the
  // default fail-closed policy so an un-inspectable event terminates the stream.)
  const parserSse = new SSEParser({ onOverflow: 'reset' });
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
  // Set when the M17 windowed enforcer terminates a stream in-band (block / withhold /
  // fail-closed). The abort it triggers would otherwise be indistinguishable from a
  // client disconnect ('aborted'), so this records the guardrail action on the ledger/
  // audit/telemetry rows AND stops the limiter from penalizing the target for a policy
  // decision that is not an upstream fault.
  let streamGuardrailAction: 'block' | 'redact' | undefined;
  // Set when the audit-only output scan threw on a chunk (and was swallowed to keep the
  // client stream alive). The scan is the SOLE input to the cache-sensitivity gate, so a
  // missed chunk must fail SAFE: treat the response as sensitive so a secret-bearing body
  // whose scan we couldn't complete is never cached + replayed.
  let outputScanFailed = false;

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
    stopReserveRefresh();
    if (scoreboardHeld && served) {
      scoreboardHeld = false;
      ctx.scoreboard?.end(served.name);
    }
    if (limiterHeld && served) {
      limiterHeld = false;
      // RTT for concurrency = full request duration; drop = fault (5xx) or abort.
      // An M17 guardrail block aborts the stream but is a POLICY decision, not an
      // upstream fault — don't penalize the target's concurrency/latency score for it.
      const dropped = (status === 'aborted' || statusCode >= 500) && !streamGuardrailAction;
      ctx.limiter?.record(served.name, Date.now() - (dispatchMs ?? started), dropped);
    }

    const n = usage.normalized();
    const meteredModel = n.model ?? requestedModel;
    const cost = computeCost(provider, meteredModel, n, ctx.rateResolver);
    // A buffered-enforcement body that overflowed the cap can't be metered (the
    // usage was never parsed), but the provider still generated and billed it.
    // Charge the worst-case reservation rather than $0, so a withheld over-cap
    // response can't be used to drive real provider spend past the budget.
    // A captured-but-overflowed response was never parsed (usage unseen), yet the
    // provider generated and billed it. Charge the worst-case reserve rather than $0 for
    // ANY such metered response — not only buffered-enforcement mode — so a large
    // (>bufferLimit) NON-STREAMED 2xx can't be served for free: otherwise it bills $0,
    // refunds its reservation, and writes NO ledger/audit row (cap bypass + a SOC 2
    // audit-completeness hole). Streamed usage is parsed from the SSE independently of
    // captureOverflow, so n.seen is normally true there and this won't fire spuriously.
    const meteringFailed = captureOverflow && captureFull && !n.seen && statusCode < 400;
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
    // Fail-closed charge is the SERVED leg's worst-case (not the combined cascade
    // reservation) — a cascade's other-leg spend is billed separately via
    // cascadeExtraMicroUsd, so charging the combined figure here would double-count it.
    const costMicroUsd = chargedWorstCase ? servedWorstCase : toMicroUsd(cost.totalUsd);
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
    // Fail SAFE: an incomplete audit scan (a swallowed throw) can't clear a response for
    // caching — a secret in an un-scanned chunk would otherwise be cached and replayed.
    const outputSensitive =
      outputScanFailed || outFindings.some((f) => f.confidence >= CACHE_SENSITIVE_CONFIDENCE);
    // The single guardrail-action label for the durable/telemetry rows: an input
    // mask/redact wins, else the M17 in-stream action, else a buffered-output block.
    const reportedGuardrailAction =
      guardrailAction ?? streamGuardrailAction ?? (outputEnforced?.blocked ? 'block' : undefined);

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
    // reservation (which would accumulate and DoS the budget).
    // Per-model caps get ONLY their own model's spend (a cascade bills two different
    // models — charging each model cap the combined total would drain the escalation
    // model's cap with cheap-tier spend, and vice-versa). Workspace + attribution caps
    // bound the whole request, so they get the full combined spend.
    const totalMicroUsd = costMicroUsd + cascadeExtraMicroUsd;
    const perModelSpend = new Map<string, number>();
    const addModelSpend = (m: string, micro: number): void => {
      perModelSpend.set(m, (perModelSpend.get(m) ?? 0) + micro);
    };
    // Key by the RESERVED model (what the `model:` scope was reserved under), not the
    // response's reported model. `requestedModel` here is the served leg's reserved
    // model (reassigned to the escalation target on an escalation); each discarded leg
    // carries the model it was reserved under (`capModel`).
    addModelSpend(requestedModel, costMicroUsd); // the served leg
    for (const r of cascadeLedgerRows) addModelSpend(r.capModel, r.micro); // discarded legs
    for (const scope of reservedScopes) {
      const amount = scope.startsWith('model:')
        ? (perModelSpend.get(scope.slice('model:'.length)) ?? 0)
        : totalMicroUsd;
      try {
        await ctx.budgets.commit(scope, requestId, amount);
      } catch (err) {
        request.log.error({ err, scope }, 'budget commit failed');
      }
    }

    // True up the token-rate windows with actual usage (best-effort; the limiter
    // swallows its own errors so a lost true-up under-counts but never blocks).
    if (ctx.rateLimiter && rlRules.length > 0) {
      // When the response was charged worst-case because usage was never observed
      // (usage-missing / buffered-overflow), commit the worst-case TOKEN estimate to the
      // TPM windows too — otherwise the request bills its worst-case dollars but adds 0
      // tokens, so TPM systematically under-counts on backends that omit stream usage.
      // Mirror the dollar worst-case inputs (body length + requested max output). Gated
      // on !n.seen so the unpriced case (real tokens already counted) is untouched.
      const tokens =
        chargedWorstCase && !n.seen
          ? estimateInputTokens(body.length) + maxOutput
          : cost.totalInputTokens + cost.outputTokens;
      await ctx.rateLimiter.commit(principal.scope.workspaceId, rlRules, requestId, tokens);
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
      // Discarded / over-cap cascade legs: each its own ledger row under a derived id so
      // per-tier spend stays attributable (the budget was already committed above).
      for (const r of cascadeLedgerRows) {
        await ctx.ledger.record({
          requestId: `${requestId}#${r.suffix}`,
          principalId: principal.id,
          orgId: principal.scope.orgId,
          workspaceId: principal.scope.workspaceId,
          provider: r.provider,
          model: r.model,
          cost: r.cost,
          costMicroUsd: r.micro,
          status: 'ok',
          attributes: { ...attribution, cascade: r.suffix },
          createdAt,
        });
      }
    } catch (err) {
      request.log.error({ err, sink: 'ledger' }, 'durable sink write failed');
    }
    // Each durable sink is isolated below: a failure in one (a DB blip, hash-chain
    // contention) must not skip the others. SOC 2 audit-completeness requires the
    // audit row to be written even when the ledger/request-log write fails. The
    // reservation was already released above, so none of these can leak it.
    try {
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
          ...(reportedGuardrailAction ? { guardrailAction: reportedGuardrailAction } : {}),
          ...(outFindings.length > 0 ? { guardrailOutputFindings: outFindings.length } : {}),
          ...(unpriced ? { unpriced: true } : {}),
        },
      });
    } catch (err) {
      request.log.error({ err, sink: 'request-log' }, 'durable sink write failed');
    }
    try {
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
          guardrailAction: reportedGuardrailAction ?? null,
          guardrailInputFindings: inputFindings,
          guardrailOutputFindings: outFindings.length,
          ...(trace ? { traceId: trace.traceId } : {}),
        });
        if (record) {
          request.log.info({ access: record }, 'access');
          ctx.accessLogSink?.emit(record); // also ship to the OTLP logs backend
        }
      }
    } catch (err) {
      request.log.error({ err, sink: 'access-log' }, 'durable sink write failed');
    }
    // The audit append keeps its own isolation so a chain-contention/DB failure
    // here does not skip the cache store + mask-vault persist that follow it.
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
          ...(cascadeEscalatedFrom ? { cascadeEscalatedFrom } : {}),
          ...(unpriced ? { unpriced: true } : {}),
          ...(attribution ? { attribution } : {}),
        },
      });
    } catch (err) {
      request.log.error({ err, sink: 'audit' }, 'audit append failed');
    }
    // Cache store + mask-vault persist run after the audit row is secured.
    try {
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
        // Never cache an ESCALATED cascade response: cacheReq is keyed by the tier-0
        // model/provider, but the body is the tier-1 model's output. Storing it under
        // the tier-0 partition would serve higher-model content to a key scoped only for
        // the tier-0 model on a later hit (a cross-authz-scope leak).
        cascadeEscalatedFrom === undefined &&
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
            // Crypto-shred subject = the principal (virtual key). With a ShreddableCipher
            // wired (CRYPTO_SHRED_ENABLED) this encrypts under the subject's own key so the
            // control plane can erase it irrecoverably; the base cipher ignores `subject`.
            subject: principal.id,
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
      request.log.error({ err, sink: 'cache/mask-vault' }, 'durable sink write failed');
    }

    // Telemetry emit is isolated (safeRecord) so a metrics fault can't reject this
    // fire-and-forget teardown and skip the tracer feed below.
    safeRecord(ctx, request.log, {
      provider,
      requestModel: requestedModel,
      responseModel: meteredModel,
      route: served?.upstreamPath ?? route.clientPaths[0] ?? '',
      servedRegion: served?.region,
      statusCode,
      status,
      inputTokens: cost.totalInputTokens,
      outputTokens: cost.outputTokens,
      cacheReadTokens: cost.cacheReadTokens,
      cacheWriteTokens: cost.cacheWriteTokens,
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
      guardrailAction: reportedGuardrailAction,
      traceId: trace?.traceId,
      traceParentId: trace?.spanId,
      sampled: trace?.sampled,
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
      guardrailAction: reportedGuardrailAction,
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
    // pipe() bridges neither direction's errors. Bridge BOTH so a fault on either
    // end tears down the whole chain instead of leaking a socket/fd:
    //   • a broken upstream (source) must destroy the decompressor (and thus the
    //     response), else the client hangs;
    //   • a decompressor fault (e.g. malformed gzip) must destroy the source, else
    //     the undici upstream socket is never released and leaks for the pool's life.
    source.on('error', (e: Error) => decompressor.destroy(e));
    decompressor.on('error', () => source.destroy());
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
    }, ctx.streamInactivityMs ?? DEFAULT_STREAM_INACTIVITY_MS);
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
      // The audit scanner does NOT shape client bytes, so a throw here is SWALLOWED
      // and streaming continues — a choking audit detector must not sever a live,
      // otherwise-valid response (unlike the enforce/detok transforms below).
      if (outScanner && text && !redactor) {
        try {
          outScanner.push(text);
        } catch (err) {
          // Keep streaming (don't sever a live response for a choking audit detector),
          // but mark the scan incomplete so the cache gate fails SAFE (see teardown).
          outputScanFailed = true;
          request.log.warn({ err }, 'output audit scan failed — continuing, will not cache');
        }
      }
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
    // These transforms SHAPE the bytes emitted to the client (windowed redact/block,
    // or detokenization). A throw here must FAIL CLOSED — abort rather than forward
    // unenforced/partial content. A synchronous throw in a stream 'data' listener is
    // NOT converted to a stream 'error'; it would escape as an uncaughtException (now
    // backstopped in main.ts, but aborting keeps THIS request's single teardown intact
    // without taking down peers).
    try {
      if (enforcer && text !== undefined) {
        outBuf = Buffer.from(enforcer.push(text), 'utf8'); // windowed redact/block
      } else if (detok && text !== undefined) {
        outBuf = Buffer.from(detok.push(text), 'utf8');
      }
    } catch (err) {
      request.log.error({ err }, 'stream output transform failed — withholding');
      controller.abort();
      return;
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
          // Record this as a guardrail action (not a bare client abort) so teardown
          // meters it with guardrailAction + status 'error' and the limiter doesn't
          // count the target as having dropped a request.
          streamGuardrailAction = redactor.blocked ? 'block' : 'redact';
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
    if (tail && outScanner) {
      // Audit-only scan of the final decoded tail — swallow a throw (best-effort);
      // it must not fail-close an otherwise-complete response.
      try {
        outScanner.push(tail);
      } catch (err) {
        outputScanFailed = true; // fail safe on the cache gate (see teardown)
        request.log.warn({ err }, 'output audit scan (tail) failed — continuing, will not cache');
      }
    }

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
    // An M17 in-stream guardrail block also aborts the controller, but it is a policy
    // outcome, not a client disconnect — record it as 'error', not 'aborted'.
    status = controller.signal.aborted && !streamGuardrailAction ? 'aborted' : 'error';
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

  safeRecord(ctx, request.log, {
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
