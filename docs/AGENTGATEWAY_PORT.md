# Gulley — agentgateway Port Roadmap (M7–M12)

Feature ideas mined from the **agentgateway** Rust codebase (~192k LOC) and mapped onto Gulley's
TypeScript architecture. A 13-agent extraction pass produced 298 raw findings → **121 deduped
features across 22 themes** (60 high-value, 59 net-new to Gulley). This document is the delivery
plan; the full browsable catalog (mechanism + source location per finding) is the _Gulley Port
Atlas_ artifact.

Same conventions as `ROADMAP.md`: each milestone is independently demoable and ends in a working,
tested slice. Every slice respects the hot-path invariants in `ARCHITECTURE.md` (raw-pipe +
centralized teardown, meter-from-raw-usage, secret-ARNs-only, cap-all-buffering) and passes
`typecheck` + `lint` + `test`; live `*-check` scripts validate anything that touches a real provider.

## Locked scope decisions

1. **Providers:** add custom/OpenAI-compatible (+preset registry), Google Gemini, Google Vertex AI, and GitHub Copilot.
2. **Policy:** build a full sandboxed **CEL-style expression engine** (`packages/cel`) with static attribute inference so the raw-pipe fast path survives unless a policy needs the body.
3. **MCP / A2A agent gateway:** **out of scope** — Gulley stays a pure LLM gateway.
4. **Logs/content:** queryable log store + usage analytics **with per-workspace opt-in content capture** (none/metadata/full), behind the content-off default + WORM/redact posture.
5. **Rate limiting + cross-replica config:** **Redis** for both global limits (INCR/Lua on the noeviction counters store) and config pub/sub.
6. **Inbound auth:** add inbound **JWT/JWKS**, browser **OIDC session** gate, and HTTP **Basic** (htpasswd bcrypt) alongside virtual keys.
7. **AWS Bedrock:** **SigV4 + STS** session-tag cost attribution; signed routes buffer the request body (late-signing seam).
8. **Cost catalog:** **models.dev**-backed catalog with **manual** admin-triggered refresh + pinned in-tree fallback.

---

## M7 — Hot-path foundations & governance table-stakes (P0) — ✅ DELIVERED

**Status:** all five workstreams landed and verified (full CI gate green — format + lint +
typecheck + test + build). Two thin follow-ups noted inline: the Postgres request-log query
adapter (rides the existing Postgres control-context seam) and DB-sourced model rules. The
opt-in prompt/completion content-capture side-table is the one deferred sub-item (schema +
gateway capture), carried into M8 alongside the cost/catalog work.

The gaps that make an enterprise gateway; mostly small/medium and self-contained.

- **`packages/ratelimit`** — local token-bucket (RPM **or** TPM) with post-response **token true-up** (mirrors reserve/commit), a **Redis-backed global** variant (INCR/Lua, epoch-aligned fixed windows), standard `x-ratelimit-*` response headers (most-constrained), and an explicit **fail-open/closed** knob. Wire into `handleProxy` beside budget; true-up in teardown.
- **`packages/metrics`** — Prometheus surface (counters + histograms: requests, tokens, cost, guardrail actions, cache status, failovers, TTFT, duration) with GenAI histogram buckets and a **cost-lookup-status** metric; exposed on a **separate management listener** (`/metrics`), split from `/health` + `/ready`.
- **Queryable log store & analytics** — `request_log` gains search/get/tail (keyset cursor) in `packages/pipeline` + `apps/control-api`; a **batched async writer** (backlog gauge, read-your-writes) in `packages/storage` keeps the hot path off the DB; a **time-bucketed usage analytics** API; a **JSONB attribute bag**; an **opt-in prompt/completion side-table** (none/metadata/full) gated by the content-off default.
- **Model routing & request shaping** — `packages/routing` gains a **ModelRoute resolver**, **model aliases** (exact + specificity-sorted wildcard) + backend model pinning, **virtual models** (weighted/failover/conditional), and requested-model extraction/normalization; a **prompt-enrichment + body-defaults/overrides** stage (runs before guardrails/cache-key); a **`/v1/models`** RBAC-filtered live list.
- **Security & correctness hardening** — model-path segment safety + SSRF-safe model-from-path (`packages/egress` + `providers`); AWS EventStream **frame-size guard** + prelude-split regression tests (`bedrock-eventstream`); multi-vendor **Retry-After** / `x-ratelimit-reset` parsing; streaming **compression/decompression** (gzip/br/zstd) with strict `Content-Encoding` parse; **terminal error-frame injection** on stream failure; constant-time-compare audit + debug-only TLS keylog + zero-width-mask filter.

**Done when:** a TPM burst is rejected with `x-ratelimit-*` headers and correct post-stream true-up; `/metrics` scrapes request/token/cost/guardrail/cache/failover series; the admin UI can browse and time-bucket request logs; a request routes purely by requested model through an alias; the hardening regression tests are green.

**Delivered (in progress):**

- **Security & correctness hardening — ✅ core wave done.** ✅ AWS EventStream **frame-size guard** (16 MiB cap) + header-bounds validation + destroy-on-corrupt-frame in `bedrock-eventstream.ts` (closes an unbounded-buffer OOM vector), 6 tests; ✅ **multi-vendor Retry-After parser** (`@gulley/providers` `retry-after.ts`) normalizing RFC7231 / Azure `retry-after-ms` / OpenAI Go-durations / Anthropic RFC3339 resets to backoff-ms, 8 tests; ✅ **model-path segment safety** (`@gulley/egress` `assertSafePathSegment`, wired into the Bedrock adapter), 4 tests; ✅ **terminal error-frame injection** — a mid-stream upstream failure now emits a clean provider-shaped SSE error event before closing (Anthropic/OpenAI dialects), integration-tested; ✅ **streaming decompression** — gzip/deflate/br upstreams are decoded before guardrails/usage/cache and the client gets plain bytes (undecodable encodings pass through with the header preserved), integration-tested. _Remaining polish: constant-time-compare audit, debug-only TLS keylog, zero-width-mask filter — folded into later auth/guardrail work._
- **`@gulley/metrics` — ✅ delivered & wired.** Dependency-free Prometheus registry (counters + histograms, text exposition v0.0.4) with gateway instruments (requests, tokens, cost, cache, guardrail actions, failovers, request-duration histogram); tees off the single telemetry `recordRequest` (zero new hot-path call sites) plus a `recordFailover` at the failover branch; served on a **separate management listener** (`/metrics` + `/health`, `METRICS_PORT` default 9090), started in `main.ts` and closed on the SIGTERM drain. 5 tests.
- **`@gulley/ratelimit` — ✅ delivered & wired.** Fixed-window RPM/TPM limiter: request check-and-increment at admission (all-or-nothing across rules) + token true-up at commit; `InMemoryRateLimitStore` + `RedisRateLimitStore` (atomic multi-rule Lua, `{scope}` hash-tag keys, shares the counters cluster with budgets); `x-ratelimit-*` header builder (most-constrained rule); `RateLimiter` with fail-open/closed. Wired into `handleProxy` as admission control (after authz, before guardrails/cache/budget) with a 429 + `retry-after` path, `x-ratelimit-*` on every response, token true-up in teardown **and** on cache hits; DB rule resolver (`createRateLimitResolver` over the `rate_limit` table); `RATELIMIT_ENABLED` / `RATELIMIT_FAIL_OPEN` config. 9 unit + 1 gateway integration test.
- **Queryable log store + usage analytics — ✅ delivered.** `@gulley/pipeline` gains an attribute bag on `RequestLogEntry`, a `RequestLogQuery` port (search with keyset cursor, get-by-requestId, time-bucketed `usage`), a `BatchingRequestLog` (buffer + size/interval flush + backlog gauge + `onError` drop count, falls back to per-entry) and a full in-memory query impl; `@gulley/storage` migration **0007** adds `attributes jsonb` + a keyset index, plus `PostgresRequestLog.writeBatch`; `apps/control-api` adds a RBAC-scoped log browser (`GET /admin/logs`, `/admin/logs/:id`) and analytics (`GET /admin/analytics/usage`) — never an unscoped query; the gateway wraps its request log in `BatchingRequestLog` (flushed on the SIGTERM drain via `flushLogs`) and populates the attribute bag (cache/target/guardrail). 7 pipeline + 2 control-api tests. _Follow-up: Postgres query adapter (lands with the Postgres control-context seam), opt-in prompt/completion side-table._
- **Model-based routing + aliases + shaping + `/v1/models` — ✅ delivered.** `@gulley/routing` gains a `ModelRouter` (exact + specificity-sorted glob rules; alias/pin the upstream model; per-model strategy override = virtual models; `knownModels()`) and `shapeRequestBody` (defaults / overrides / Anthropic system-prompt enrichment). Wired into `handleProxy` **before** authz/guardrails/cache so scope, cache key, and detection see the effective request; `GET /v1/models` returns an OpenAI-shaped list filtered to the caller's allowed models. 8 routing + 3 gateway integration tests. _Follow-up: load model rules from the `model_alias` table (needs async context init / config hot-reload)._

## M8 — Provider breadth, cost accuracy & translation depth (P1)

- **`packages/catalog`** — models.dev-backed catalog (manual refresh, pinned fallback, atomic hot-swap keeping last-valid) + a control-api refresh endpoint.
- **`cost`** — CacheTokenConvention normalization **by wire format** (fixes cross-served Bedrock/Vertex Anthropic mis-billing); context-length pricing tiers (whole-request reprice); reasoning/audio rate buckets; cost-lookup-status taxonomy + exact-decimal validation.
- **`providers`** — **custom/OpenAI-compatible** + preset registry (~13 backends); **Gemini** (native `generateContent` + OpenAI-compat, `?alt=sse`); **Vertex** (Claude-on-Vertex + Gemini + embeddings + rerank, region→host matrix); **Copilot** (per-model wire-format capability). Provider **prompt-cache breakpoint** translation (OpenAI↔Anthropic↔Bedrock cachePoint); **reasoning/thinking signature round-trip**; deeper **OpenAI Responses**; **embeddings / rerank / count_tokens** as first-class proxied endpoints; Bedrock tool-name sanitization + error-envelope normalization.
- **Streaming toolkit** — format-agnostic multi-path usage tables (meter unknown providers); a **TransformedBody** cross-format stream translator (serve any provider on any endpoint); a decode-while-forward tap; local **tiktoken** counting (`packages/tokenizer`) for pre-flight budgeting.

**Done when:** a request to a preset backend (e.g. Groq) meters and costs correctly; Gemini + Vertex + Copilot each run a streamed request end-to-end; prompt-cache breakpoints translate across providers; the catalog refreshes from models.dev on an admin action with a pinned fallback on failure.

**Delivered (in progress):**

- **Custom / OpenAI-compatible providers + local models — ✅ delivered.** `@gulley/providers` `presets.ts` ships a preset registry — hosted (Groq, Mistral, Together, OpenRouter, DeepSeek, Fireworks, Cerebras, xAI, Nvidia, DeepInfra, Perplexity, **Gemini**) **and local runtimes** (Ollama, Jan, LM Studio, vLLM, LocalAI, llama.cpp, KoboldCpp, text-generation-webui) — plus `resolveCustomProvider`. `PassthroughAdapter` gained **keyless mode** (empty credential → no auth header) so loopback runtimes work. The gateway reads `CUSTOM_PROVIDERS` (JSON), registers each at `/{provider}/v1/chat/completions`, builds a `ModelRouter` from declared models so a shared `/v1/chat/completions` request dispatches by model to the right backend (local or cloud), surfaces them in `GET /v1/models`, and — when only custom providers exist — registers the shared chat path itself. Local http/loopback base URLs are server-side config (not client-supplied), so they are exempt from the SSRF guard by construction.
- **models.dev cost catalog — ✅ delivered.** `computeCost` gains a pluggable `RateResolver` (external prices override/extend the seed; cache multipliers fall back seed → neutral). New `@gulley/catalog`: `ModelCatalog` (atomic replace, keep-last-valid, normalized lookup, `resolver()`), `parseModelsDev` (maps models.dev `api.json`, aliases google→gemini etc., converts absolute cache USD → input-rate multipliers), `fetchModelsDev` (timeout, throws so callers keep last-valid), and a file loader/writer. Gateway loads `MODELS_CATALOG_FILE` on boot → resolver into `computeCost`; `catalog:refresh` script fetches models.dev and writes the file (manual, per the manual-updates rule — no runtime auto-fetch).
- **Gemini + first-class embeddings — ✅ delivered.** `gemini` preset via Google's OpenAI-compatible surface (native `generateContent` + thoughtSignature round-trip is a later, higher-fidelity add). Opt-in embeddings (`embeddings`/`embeddingsPath`) register `/{provider}/v1/embeddings` for custom providers (many local runtimes serve embeddings), and `/v1/embeddings` for built-in OpenAI — metered via `OpenAIUsageExtractor`, not cached.

_Still open in M8: Vertex + Copilot native adapters, provider prompt-cache breakpoint translation, reasoning-signature round-trip, deeper OpenAI Responses, rerank/count_tokens, opt-in content capture._

## M9 — Backend auth & credential signing (P1)

- **AWS SigV4** (late-signing/buffer seam on signed routes) + **STS AssumeRole** session tags for per-tenant cost attribution; **GCP** token minting (ADC/SA/impersonation, per-audience cache); **Azure** DefaultAzureCredential chain + IMDS reachability probe.
- A **bounded single-flight token/credential cache** (5s fetch timeout, refuse near-expiry, never cache errors) — the shared primitive under every provider-side token fetch.
- **OAuth token exchange** (RFC 8693) + jwt-bearer (7523) + `private_key_jwt` client auth; backend-auth **location marker** + JWT passthrough + `jwtSign` + Copilot token discovery.
- **Backend transport & TLS** — per-backend TLS (SNI override, custom roots, mTLS, alt-SAN); multi-connection H2 pool sizing; HTTP **CONNECT** forward-proxy egress; a TTL-respecting async **DNS cache** shared with the SSRF guard.

**Done when:** Bedrock runs under an IAM role via SigV4 with STS session-tagged cost rows; a GCP/Azure token flows through the single-flight cache; a backend with a private CA + mTLS connects; the DNS cache honors TTLs and feeds the egress guard.

## M10 — CEL policy engine, authorization & transformation (P1) — ✅ DELIVERED

**Delivered & verified (full CI gate green):**

- **`@gulley/cel` engine — ✅** a sandboxed, side-effect-free CEL subset: lexer + Pratt parser (literals, member/index, unary/binary/ternary, lists/maps, `in`, function + method calls, `has()`, and comprehension macros `all`/`exists`/`exists_one`/`filter`/`map`); an evaluator with CEL value semantics, short-circuit `&&`/`||`, string methods, an expression stdlib (`size`/`type`/`matches`/`jsonField`/`base64`/`lowerAscii`/`ip()`/`cidr().containsIP()`), user-defined functions, a step cap, and an optional eval trace. **`compile()` does static attribute inference** (roots + second-level paths like `request.body` / `principal.scope`) so a policy that never reads the body keeps the raw-pipe fast path; strict mode rejects undeclared root variables. 18 tests.
- **Authorization — ✅** `CelAuthorizer` (deny-first + allow-list; an erroring rule is a non-match, so an allow-list fails closed) wired into `handleProxy` via `CEL_AUTHZ` (strict-compiled) — a deny → 403 + audit + telemetry before rate limit. LLM-aware activation: `request.{method,path,model,provider,stream,source_ip,headers,body}`, `principal.{id,orgId,workspaceId}`. 5 + 1 tests.
- **Transformation — ✅** `CelTransformer` (set/remove request & response headers, set request-body fields; each value a CEL expression; fail-open per mutation; `needsBody` inference) wired via `CEL_TRANSFORM` — request mutations applied before guardrails/cache (detection + cache key + budget see the effective request), response header mutations on the streamed writeHead. 4 + 1 tests.

**Done when:** ✅ an operator writes a CEL authz rule and a header/body transform; the fast path is untouched for policies that don't reference the body (via `needsBody`/`reads`). _Follow-up: a transform scratchpad (computed `vars`) and response-body transform on buffered responses._

## M11 — Resilience, inbound auth & guardrail depth (P1/P2)

- **Resilience** — passive **outlier detection** (EWMA health + timed ejection/uneviction, Retry-After-driven cooldown, multiplicative backoff, restore_health); **retry with request-body replay** (cap-aware, precondition/post-condition); deadline-bounded backoff + split request/backend timeouts + per-frame watchdog; **P2C least-load** selection (EWMA latency/health/pending); **session affinity** via weighted rendezvous (HRW); rejected-pool fallback + capacity=0 drain.
- **Inbound auth** — JWT/JWKS validation (cached keys, kid rotation, alg-confusion guard); browser **OIDC** login + session gate (auth-code/PKCE); API-key sha256-hash config form; **HTTP Basic** (htpasswd bcrypt); an `AuthorizationLocation` extract/insert abstraction; encrypted session cookies + safe-redirect normalization.
- **Guardrail depth** — a generic **Webhook** guardrail contract (bring-your-own DLP through the egress guard); **Azure Content Safety + OpenAI Moderation + Google Model Armor** plugins; **GuardedSseBody** hold-then-flush streaming enforcement; ContentScope-scoped guardrails; tool-call JSON string scanning; Bedrock BLOCKED-vs-ANONYMIZED; PII depth (libphonenumber, context-word boosting, URL/CA-SIN).

**Done when:** a flaky upstream is ejected and self-heals on its Retry-After; a transient error retries on the same target within the budget cap; a JWT/OIDC/Basic client authenticates; a webhook guardrail masks output; streamed output is truly blocked (not just audited) via hold-then-flush.

**Status: COMPLETE.** JWT/OIDC inbound auth, HTTP Basic (htpasswd), managed guardrails (OpenAI Moderation, Azure Content Safety, Bedrock, Model Armor), hold-then-flush, P2C + session affinity, graded breaker + passive outlier detection, retry-replay, PII depth. The tail slices were adversarially reviewed and seven confirmed defects fixed (see the fix commits).

**Delivered:**

- **Graded circuit breaker — ✅ delivered.** `@gulley/routing` breaker now opens on consecutive failures **or** a high EWMA error rate (after a min sample count) — catching a target failing ~half its calls without a streak; multiplicative backoff on repeated ejections (capped), reset by a half-open recovery; an upstream **Retry-After** floors the cooldown; `errorRate(key)` exposed. Gateway parses Retry-After from the failover response and feeds it to `recordFailure`. API backward-compatible. 3 tests.
- **Retry with request-body replay — ✅ delivered.** Bounded same-target retries (`RETRY_MAX_ATTEMPTS`, default 1 = off) on transient errors before failover, with exponential backoff floored by Retry-After and abort-aware; safe because the body is already buffered (pre-first-byte). 1 integration test.
- **Generic Webhook guardrail — ✅ delivered.** `WebhookGuardrailPlugin` (bring-your-own DLP) → the `GuardrailPlugin` seam; allow/block/mask verdicts, fail-open/closed, SSRF-guarded URL (or `allowInternal` for an internal DLP). Wired via `GUARDRAILS_WEBHOOK_URL`; a block/mask verdict is authoritative even under the audit-only default. 3 tests. _Follow-up: output-direction webhook (needs async output inspection), managed plugins (Azure/OpenAI-moderation/Model-Armor)._
- **Inbound JWT/JWKS auth — ✅ delivered.** `apps/gateway/src/jwt-auth.ts`: an OAuth-broker principal is minted from a validated bearer JWT (asymmetric algs only — RS/PS/ES; HS\*/none rejected to defeat key-confusion), scope drawn from workspace/org claims with optional allowed-models/providers claims; deterministic `looksLikeJwt` gate selects JWT vs virtual-key path. Enabled by `JWT_ISSUER`+`JWT_AUDIENCE`. 1 integration test.
- **Browser OIDC login + session gate — ✅ delivered.** New `@gulley/oidc` (JWKS verify, discovery, `OidcProvider` with kid-rotation refresh) + control-api `/auth/{config,login,callback,me,logout}` (auth-code + PKCE, HMAC-signed flow state with nonce correlation, `gses_` admin session cookie, role-map → memberships). Admin UI gates on `/auth/me`. 9 tests.
- **Managed guardrail plugins — ✅ delivered.** `OpenAIModerationPlugin`, `AzureContentSafetyPlugin` (severity threshold), plus the earlier `WebhookGuardrailPlugin` and a Bedrock plugin, composed via `composePlugins`/`CompositeGuardrailPlugin` (short-circuit on block, chained masks). Fail-open by default, per-plugin fail-closed. 7 tests.
- **Hold-then-flush streaming block — ✅ delivered.** A route may opt into `holdStreamedOutput`: the streamed SSE body is buffered, the output guardrail policy runs on the whole body, and any enforcing verdict (block, or a would-be redaction that can't be re-encoded into SSE frames) withholds the response with a terminal error frame; otherwise the buffered SSE is flushed (detokenized). Usage is still metered. 1 integration test.
- **P2C least-load + session affinity (HRW) — ✅ delivered.** `@gulley/routing` gains a `LoadScoreboard` (in-flight counts) driving power-of-two-choices least-load selection for the `loadbalance` primary pick (default via `LB_LEAST_LOAD`), and weighted rendezvous hashing (`hrwOrder`) that pins a session to one target when `LB_SESSION_AFFINITY_HEADER` is set (header value, else principal id). Gateway begins on the served target and releases in teardown. 5 routing tests + 1 gateway integration test.
- **HTTP Basic (htpasswd) inbound auth — ✅ delivered.** `@gulley/auth` htpasswd verifier (bcrypt via bcryptjs, Apache `$apr1$` verified against openssl vectors, `{SHA}`/`{SSHA}`, plaintext; DES/unknown formats fail closed). Deterministic scheme selection ahead of JWT/virtual-key. Deny-by-default per-user scope, timing-equalized on the miss path.
- **Google Model Armor — ✅ delivered.** `ModelArmorPlugin` (sanitizeUserPrompt/ModelResponse; block, or SDP-mask only when SDP is the sole matched filter). Runs on input AND (via `GuardrailEngine.inspectOutput`) the buffered output path.
- **Passive outlier detection — ✅ delivered.** A dedicated peer-relative `OutlierDetector` (separate from the fault breaker): ejects a target whose TTFB EWMA is ≥ factor × the peer baseline, with correct timed self-heal; `selectCandidates` unions it with the breaker filter. `OUTLIER_*` config, off by default.
- **PII depth — ✅ delivered.** NANP/E.164 phone validation, Canadian SIN (Luhn) + URL detectors, and context-word confidence boosting.
- **Hardening from adversarial review — ✅** seven confirmed defects across the tail slices fixed (Basic-auth plaintext-fallthrough / allow-all default / timing oracle; Model Armor output-not-scanned / SDP-downgrades-block; outlier shared-backoff / broken-self-heal), each with regression tests.

## M12 — Observability engine, config hot-reload & HTTP edge (P2/P3)

- **Config** — Postgres **LISTEN/NOTIFY** hot-reload (self-notification id) + Redis config pub/sub; **delta reconciliation** (upsert-then-prune, preserve live routing/breaker state); a resource manager (TTL remote-fetch cache + file-watch + commit/rollback); hybrid file+DB overlay + GitOps-lock + conflict detect + config-dump.
- **Observability** — a **config-driven access-log field engine** (add/remove/filter, value flattening — uses CEL); buffered per-stage **child spans** + outbound `traceparent` injection; trace sampling + span keep-filter + an OTLP access-log exporter.
- **HTTP edge** — **peekbody** (inspect N bytes then re-inject) + per-route BufferLimit + RecordedBody tee; buffer policy failClosed/failOpen; **CORS** (credentials-safe) for the admin UI; **CSRF** via Sec-Fetch-Site; HeaderModifier filter + RequestMirror (shadow traffic).
- **External policy hooks** — external authorization (simplified JSON contract, CEL-shaped request) + **decision caching** (expression key + TTL, single-flight refresh); configurable failure mode + external endpoint picker.
- **Admin DX** — runtime log-level control; redacted config dump; a live request tracer over SSE (`/debug/trace`); hardened draining.

**Done when:** a config change propagates across Fargate tasks without a redeploy and preserves live state; access-log fields are operator-configurable; external authz decisions are cached; the admin surface exposes runtime log control + a live tracer.

**Delivered:**

- **Config-change propagation bus — ✅ delivered.** New `@gulley/storage` pubsub: a transport-agnostic `ConfigNotifier`/`ConfigSubscriber` with `PostgresConfigBus` (sql.listen/notify on a dedicated max:1 connection + onListen reconnect-catchup), `RedisConfigBus` (dedicated subscriber), `CompositeConfigNotifier`, and a `SignalGate` (self-notification guard + monotonic version dedupe making the dual bus idempotent). Signals carry only `{v, hash, origin, ts}` — never the config body or a secret. `applyConfig` gains a post-commit `onApplied` hook; control-api `/config/apply` emits after a successful commit.
- **Access-log field engine — ✅ delivered.** `@gulley/telemetry` `AccessLogFieldEngine` (CEL-valued fields via `@gulley/cel`, remove/filter/flatten, fail-open) over a credential-free record; emitted as a structured `access` log line in gateway teardown. `ACCESS_LOG_FIELDS` config.
- **External authorization hook — ✅ delivered.** `@gulley/cel` `ExternalAuthorizer` — POSTs the `{request, principal}` activation to an operator policy service, `{allow, reason}` back; decision cache (key = a CEL expr or principal+model+provider) with TTL + single-flight; timeout/error → failMode, uncached. Gateway runs it after the local CEL rules; SSRF-guarded URL. `EXTERNAL_AUTHZ_*` config.
- **HTTP edge: CORS + CSRF — ✅ delivered.** New `@gulley/http-edge` (credentials-safe exact-origin CORS, Sec-Fetch-Site CSRF exempting allowlisted/bearer/same-origin), wired into the control-api as Fastify hooks. `ADMIN_CORS_ORIGINS` / `ADMIN_CSRF_ENABLED`.
- **Admin DX: runtime log-level + redacted config dump — ✅ delivered.** Admin-guarded `/admin/log-level` (runtime, audited) and `/admin/config-dump` (secret-bearing keys → set/unset marker, URL creds stripped).
- **W3C traceparent propagation — ✅ delivered.** `nextTraceContext` continues/starts a trace, injects `traceparent` upstream (preserved across the header transform), stamps the trace id on the span + access log. `TRACE_PROPAGATION` / `TRACE_SAMPLE_RATIO`.
- **Response BufferLimit + fail-closed — ✅ delivered.** Configurable `RESPONSE_BUFFER_LIMIT_BYTES`; on overflow in enforcing mode the response is withheld (`BUFFER_FAIL_CLOSED`) instead of leaking a truncated, unenforced body — closing a real gap.
- **HeaderModifier — ✅ delivered.** `@gulley/http-edge` static request/response header set/remove (`HEADER_MODIFIER`), applied at every response writeHead site (also fixing the CEL response-header transform being dropped on the buffered paths).
- **RequestMirror (shadow traffic) — ✅ delivered.** Sampled, fire-and-forget, egress-guarded copy of the effective (masked) request; never awaited, never metered. `REQUEST_MIRROR`.
- **Live request tracer — ✅ delivered.** Bounded in-memory ring streamed over SSE at `/debug/trace` (bearer-guarded, credential-free). `DEBUG_TRACE_TOKEN`.
- _peekbody: satisfied by design for the request path (the JSON body is a fully-buffered Buffer, so any policy peeks `body.subarray(0,N)` with no re-injection); a response-side peek was judged low-value / high raw-pipe risk and deferred._
- **Status: M12 COMPLETE** except the config **hot-reload reconcile** itself, promoted to its own milestone **M13** below (it needs a durable config store + a data-plane refactor — too large to be an M12 slice). The propagation bus, delivered here, is M13's transport.

## M13 — Config hot-reload (durable DB config + live reconcile) — ✅ DELIVERED

The last agentgateway-port capability: a config change applied through the control plane propagates to every running gateway replica **without a redeploy**, and each replica **reconciles live** — preserving in-flight requests and all in-memory routing state. Delivered in three layers (see `docs/M13_CONFIG_HOTRELOAD.md`):

- **L1 — durable config store.** A storage-agnostic `ConfigBackend` + a reconcile/export/authorize algorithm written once (upsert-then-prune; providers by kind, entities by name; virtual keys untouched) and **CI-tested** via `InMemoryConfigBackend`; `BackendConfigStore` implements `ConfigStore` over any backend. A thin `PostgresConfigBackend` (per-table Drizzle CRUD; budget special-cased for its typed columns; credentials as ARN refs) → `PostgresConfigStore`, plus `PostgresConfigVersionStore` (atomic `tryReserve` gate). `/config/apply` persists to the tables the gateway reads when `DATABASE_URL` is set; a `config:db:check` live script exercises the real SQL.
- **L2 — gateway builds from the document.** A pluggable `SecretResolver` (`MapSecretResolver` for dev/tests, `AwsSecretsManagerResolver` for prod) — the only place a secret value materializes. `buildRoutesFromDocument` maps each enabled provider (kind → adapter + paths + credential) with its resolved credential; an unresolvable ARN **rejects** so the reconcile aborts atomically.
- **L3 — live reconcile + full mutable dispatcher.** One `/*` dispatcher looks the route up per request from a swappable `RouteHolder` (ctx read once at entry → in-flight streams + their single teardown finish on their original ctx; path-set changes reload with no Fastify re-register). `GatewayReconciler` swaps the route table **preserving breaker/scoreboard/outlier/budgets/counters/telemetry/connections by reference**, single-flight + fail-safe (keeps the old config on any build/secret failure). `ConfigWatcher` subscribes to the Postgres LISTEN/NOTIFY bus with a `SignalGate`, reconciles on a foreign signal, resyncs on reconnect; wired in `main.ts` behind `CONFIG_SOURCE=db`, started after listen and stopped first on the drain.

**Original spec below (retained):** The M12 propagation bus (`@gulley/storage` pubsub) is the transport; this milestone builds the durable source of truth and the data-plane reconcile the bus drives.

Three layers (the shape the M12 research established):

1. **Durable config store.** `PostgresConfigStore` + `PostgresConfigVersionStore` over the existing `provider`/`route`/`route_policy`/`model_alias`/`rate_limit`/`guardrail`/`budget`/`config_version` tables — porting `ControlConfigStore`'s upsert-then-prune reconcile into ONE Drizzle transaction, with an append-only, atomically-bumped version that preserves the "exactly one concurrent apply wins" contract. Wire into `apps/control-api/context.ts` so `/config/apply` actually persists to the tables the gateway reads.
2. **Gateway-builds-from-DB.** A pure `document → { ProviderRoute[], ModelRouteRule[], GuardrailEngine }` builder that resolves each provider's `SecretRef` (ARN) via a new Secrets Manager resolver at reload time (env carried raw keys; the DB carries ARNs). A secret-resolution or validation failure aborts the reconcile atomically and keeps the old config.
3. **Live reconcile + mutable dispatch.** A `ConfigWatcher` subscribing to the bus (LISTEN + Redis, with a version-gated full-resync on every reconnect to cover missed events) drives a single-flight `reconcile(desiredDoc)`: build the new artifacts off-path, delta by `target.name`, then swap the route table via a **mutable ctx holder** the request handler reads once at entry — while `CircuitBreaker`, `OutlierDetector`, `LoadScoreboard`, budgets, rate-limit counters, request-log buffer, telemetry, and the DB/Redis connections are **preserved by reference** (never reset). In-flight hijacked streams and their single teardown finish on the ctx they started with. Fastify's static router is handled by registering the proxy surface as one dispatcher so path-set changes need no re-registration.

**Done when:** a `/config/apply` on one control-plane node propagates across gateway replicas without a redeploy; a reconcile swaps routes/guardrails/model-rules while an ejected upstream stays ejected and in-flight requests complete untouched; a bad/secret-unresolvable config is rejected atomically with the old config intact; budgets/rate-limits (already read per-request from Postgres) need only the persisted rows.

**Non-negotiables carried in:** raw-pipe + single centralized teardown; meter-from-raw-usage; secret-ARNs-only (no resolved secret ever crosses the bus or is cached on ctx); role-split Redis (counters untouched on reload); Postgres is the durable source of truth.

---

## M14 — Resilience & hardening — ✅ DELIVERED

Finishes the reliability story and closes remaining enterprise gaps (full detail
in `docs/M14_RESILIENCE_AND_HARDENING.md`). Each phase shipped verified + the
hot-path ones passed the adversarial-review gate:

- **A — resilience triad.** Per-target **adaptive concurrency** (gradient limiter;
  all-saturated ⇒ 503 + Retry-After, distinct from a 502 fault) + opt-in
  **pre-first-byte request hedging** (race a second candidate, meter only the
  winner; last-resort real-error relay preserved).
- **C — conformance & load harness.** `conformance.test.ts` replays captured
  provider SSE through the full gateway asserting raw-fidelity + meter-from-raw +
  single-teardown; `load:check` SLO gate (p99 < 10s, err < 0.005) + a k6 profile.
- **B — native Gemini/Vertex.** `contents`/`parts` translation that round-trips
  the `thoughtSignature` reasoning artifact; SA-JWT → Vertex OAuth token minting.
- **D — per-tenant routing.** A workspace may reroute a client path to its own
  strategy/provider (resolved against the route's full alias set).
- **E — supply chain.** cosign keyless signing of the pushed digest + DR/restore
  drill docs on top of the existing SBOM + SLSA provenance + Trivy.

## M15 — Smart routing (classification-driven) — ✅ DELIVERED

Classify each request after authn and reroute by category — cheap prompts to a
small model, code/hard to a specialized provider, sensitive to a guarded path —
across four objectives (cost-tier / domain-skill / safety-risk / operator
taxonomy), resolved per user > group > route > workspace > org. Off unless
`SMART_ROUTING_ENABLED=true` (DB config). Full detail in
`docs/M15_SMART_ROUTING.md`. Delivered A1→F, each verified; both hot-path phases
passed the adversarial-review gate (D: 2 findings fixed; E: 0 confirmed):

- **A1** groups as a claim/tag (`scope.groups`); **A2** declarative policy model +
  selector-precedence resolver; **B** `smartRoutingPolicies` GitOps config
  collection + `smart_routing_policy` table + Zod validation; **C** classifier
  engine (rules-then-llm / llm-router / embedding ports) with timeout + breaker,
  never-throws / always fail-open; **D** the hot-path classify stage (reroute by
  category; residency pin fully preempts); **E** classifier sub-metering
  (`${requestId}#classify`, `proxy.classify`, `meterClassifier`) + the real
  llm-router completer; **F** docs + `smart:check` smoke.
- **Live backends:** rules-then-llm + metered llm-router. **Follow-ons:** the
  embedding-nearest-label centroid store; classification memoization; a
  non-Anthropic classifier completer; the per-policy safety-overrides-residency
  flag.

## M16 — Embedding-nearest-label classifier backend — ✅ DELIVERED

Completes the smart-routing classifier trio. A policy's config `exemplars`
(example prompts per category) are embedded into per-category centroids at
reconcile (reusing the semantic-cache `OpenAIEmbeddingProvider`, memoized so an
unchanged policy is not re-embedded); a request routes to the category whose
exemplar is nearest (cosine) above `SMART_ROUTING_SIMILARITY_THRESHOLD`. The
reconciler now wires the embedder + a classifier breaker + the threshold; prompt
embedding is bounded and abort-aware. In-memory centroids (a persistent
`classifier_centroid` store followed in **M18**). See `docs/M15_SMART_ROUTING.md`.

## M17 — Streaming output-guardrail enforcement — ✅ DELIVERED

Closes the biggest pipeline gap: streamed output guardrails were audit-only.
M17 adds an opt-in windowed delayed-emit enforcer that **redacts** matched
PII/secret spans (or **blocks** on the first violation) in an Anthropic-canonical
streamed response — trading raw-byte fidelity + a bounded latency window, for
that mode only, for enforcement. Two composable primitives (`StreamingRedactor`
in `@gulley/guardrails`, `AnthropicSseRewriter` in `@gulley/providers`) wired at
the single byte-transform seam; single teardown, backpressure, watchdog, and
meter-from-raw-usage all preserved. See `docs/M17_STREAMING_ENFORCEMENT.md`.

## M18 — Streaming reach: non-Anthropic re-framing, reversible mask, persistent centroids — ✅ DELIVERED

Two Tier-1 follow-ons, completing M16/M17's asterisks.

- **Non-Anthropic streaming enforcement.** A new `OpenAiSseRewriter`
  (`@gulley/providers`) re-frames the OpenAI `chat.completions` stream
  (`choices[].delta.content`), so streaming redact/mask/block now covers the
  OpenAI-compatible surface, not just `/v1/messages`. The gateway selects the
  rewriter by client dialect and emits a **dialect-correct** terminal error frame
  on block/fail-closed. `/v1/responses` + `/v1/embeddings` stay audit-only.
- **Reversible streaming mask.** `StreamingRedactor` (and the buffered
  `inspectOutputText`) now implement `mask` as stable per-value tokenization via a
  `TokenVault` — coreference-preserving and gateway-reversible — instead of
  collapsing to irreversible redaction. `redact` is unchanged (irreversible).
- **Persistent classifier centroids.** A `classifier_centroid` table (jsonb
  embeddings) + `PostgresCentroidStore`; `buildPersistentCentroids` reuses
  persisted exemplar embeddings across replicas instead of re-embedding on boot,
  keyed by embedding model, fail-open at every layer
  (`SMART_ROUTING_PERSIST_CENTROIDS`).

## M19 — Wave 1 "Make it real" (from the killer-feature review) — 🚧 CORE LANDED

The Aug-2026 principal review found the engine is world-class but several headline
features are built-but-unwired. Wave 1 turns them on + clears the P0/P1 correctness
backlog. **Slices A–H are on `main`** (correctness, working analytics, cache/cost
durability, docs truth pass, multi-target routing overlay + hedging, durable
virtual-key list/revoke/rotate, DB model aliases, native input-guardrail + reversible
vault). The remaining follow-ons are infra-heavy (native Gemini/Vertex config-schema,
`request_log`/`spend_ledger` partitioning+rollups, budget self-heal, doc-native
routing/guardrail forms, TTFT metric). See `docs/M19_WAVE1.md` for the tracker.

- **M19 A — correctness (✅):** reserve/commit price parity (admission now uses the
  catalog resolver — no spurious 402s on Gemini/Vertex/Groq); Anthropic multi-block
  guard (fail-closed on a 2nd text block, mirroring the M18 OpenAI n>1 guard);
  opt-in no-usage charge knob (`METER_CHARGE_ON_MISSING_USAGE`).
- **M19 B — working analytics (✅):** `PostgresRequestLogQuery` (keyset search +
  date_trunc usage rollups with error-rate + p95), wired into control-api when a DB
  is present. The log browser + usage dashboards were **empty in production**; now
  functional. Real-SQL PGlite test.
- **M19 C — durability (✅):** Gemini/Vertex cost seeds (no more $0 billing); Postgres
  exact-cache sweeper (`CACHE_SWEEP_INTERVAL_SECONDS`) so the cache table + pgvector
  index don't grow unbounded.
- **M19 D — docs truth pass (✅):** README status (M0 → M18), provider list, package
  map; ARCHITECTURE pipeline-order diagram corrected to the shipped order (cache
  before budget); CLAUDE.md gate note.
- **Remaining (the substantive wiring — each its own carefully-reviewed slice):**
  multi-target routing config surface (both builders + doc/env schema + hedge
  wiring); native Gemini/Vertex adapter wiring; per-workspace guardrails + input
  vault (`GUARDRAILS_INPUT_ACTION`); durable `PostgresKeyAdminStore` (list/revoke/
  rotate on `virtual_key` — the admin key store is in-memory today); `request_log`/
  `spend_ledger` partitioning + rollups + retention (needs real-Postgres
  validation); budget counter self-heal from the ledger; DB `model_alias` →
  `ModelRouter`.

## M20 — Wave 2 "Extend the moat" — 🚧 CORE LANDED

Presses the ground competitors can't structurally follow. **Slices A–E on `main`**:
native prompt-injection / jailbreak classifier (local, no egress); price/latency-
aware routing (`select: cheapest|fastest`); prompt-cache savings analytics; budget
soft-threshold alerts + gauge; budget-aware routing downshift. That's all three
non-FinOps moat items + two of three FinOps pieces. The remaining piece — multi-level
budget caps (org/project/key/model) — is a hot-path budget-safety change reserved for
its own adversarially-reviewed slice (see `docs/M20_WAVE2.md`).

## Wave 3 — DX & adoption (next)

The moat is deep; Wave 3 lowers the barrier to adopting it. Candidates:

- **In-console playground** (deferred from Wave 2): send a test request, stream the
  response, surface the resulting log row (cost/tokens/guardrail) — the first-run
  "does my key/route work?" unlock, now that analytics (M19 B) work.
- **Prompt registry** — versioned, audited, hash-chained prompt templates on the
  existing GitOps/RBAC rails (governance-native, not a me-too studio).
- **Full admin CRUD + key-lifecycle UI** (revoke/rotate endpoints landed in M19 F).
- **Published OpenAPI + typed control-API client**; per-provider quickstarts; a
  Helm chart / one-command deploy.
- **Compliance-as-a-product**: the audit-verify CLI + auditor attestation export.

## Recommended next steps (candidate roadmap → world-class)

- **Tier 1 (differentiators).**
  1. **Native Gemini tool + image translation** — makes Vertex first-class (M14 B
     covered text + thinking only).
  2. **`/v1/responses` streaming enforcement + persisted-vault reversal path** —
     M18 covers Anthropic + OpenAI-chat streams; the Responses API stream and a
     durable (encrypted) reversal store for masked output are the remaining edges.
  3. **pgvector-backed centroid ANN** — M18 persists centroids as jsonb (load-all +
     in-JS cosine); a `vector`-typed column + ANN index scales large exemplar sets.
- **Tier 2 (completeness).** Classification memoization (per session/prompt-hash);
  per-tenant noisy-neighbor controls (per-tenant concurrency + priority); admin UI
  depth (surface smart-routing policies + `proxy.classify` spend, budgets/audit,
  key management).
- **Tier 3 (advanced).** Prompt-injection/jailbreak classifier in guardrails;
  multi-region active-active (shared counters); per-tenant data residency +
  BYO-KMS; the per-policy safety-overrides-residency knob.

---

## Explicitly out of scope (this effort)

MCP tool-federation / agent gateway, A2A agent gateway, Kubernetes Gateway-API controller + xDS,
HBONE/SPIFFE service-mesh transport, and inference-gateway (GPU/KV-cache/LoRA) routing. Captured in
the catalog for reference only.
