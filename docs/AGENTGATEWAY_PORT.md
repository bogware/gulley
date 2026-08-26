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

**Status: substantially delivered** (JWT/OIDC inbound auth, managed guardrails, hold-then-flush, P2C + session affinity, graded breaker, retry-replay). Deferred: HTTP Basic, Model Armor, passive outlier ejection, PII depth.

**Delivered:**

- **Graded circuit breaker — ✅ delivered.** `@gulley/routing` breaker now opens on consecutive failures **or** a high EWMA error rate (after a min sample count) — catching a target failing ~half its calls without a streak; multiplicative backoff on repeated ejections (capped), reset by a half-open recovery; an upstream **Retry-After** floors the cooldown; `errorRate(key)` exposed. Gateway parses Retry-After from the failover response and feeds it to `recordFailure`. API backward-compatible. 3 tests.
- **Retry with request-body replay — ✅ delivered.** Bounded same-target retries (`RETRY_MAX_ATTEMPTS`, default 1 = off) on transient errors before failover, with exponential backoff floored by Retry-After and abort-aware; safe because the body is already buffered (pre-first-byte). 1 integration test.
- **Generic Webhook guardrail — ✅ delivered.** `WebhookGuardrailPlugin` (bring-your-own DLP) → the `GuardrailPlugin` seam; allow/block/mask verdicts, fail-open/closed, SSRF-guarded URL (or `allowInternal` for an internal DLP). Wired via `GUARDRAILS_WEBHOOK_URL`; a block/mask verdict is authoritative even under the audit-only default. 3 tests. _Follow-up: output-direction webhook (needs async output inspection), managed plugins (Azure/OpenAI-moderation/Model-Armor)._
- **Inbound JWT/JWKS auth — ✅ delivered.** `apps/gateway/src/jwt-auth.ts`: an OAuth-broker principal is minted from a validated bearer JWT (asymmetric algs only — RS/PS/ES; HS\*/none rejected to defeat key-confusion), scope drawn from workspace/org claims with optional allowed-models/providers claims; deterministic `looksLikeJwt` gate selects JWT vs virtual-key path. Enabled by `JWT_ISSUER`+`JWT_AUDIENCE`. 1 integration test.
- **Browser OIDC login + session gate — ✅ delivered.** New `@gulley/oidc` (JWKS verify, discovery, `OidcProvider` with kid-rotation refresh) + control-api `/auth/{config,login,callback,me,logout}` (auth-code + PKCE, HMAC-signed flow state with nonce correlation, `gses_` admin session cookie, role-map → memberships). Admin UI gates on `/auth/me`. 9 tests.
- **Managed guardrail plugins — ✅ delivered.** `OpenAIModerationPlugin`, `AzureContentSafetyPlugin` (severity threshold), plus the earlier `WebhookGuardrailPlugin` and a Bedrock plugin, composed via `composePlugins`/`CompositeGuardrailPlugin` (short-circuit on block, chained masks). Fail-open by default, per-plugin fail-closed. 7 tests.
- **Hold-then-flush streaming block — ✅ delivered.** A route may opt into `holdStreamedOutput`: the streamed SSE body is buffered, the output guardrail policy runs on the whole body, and any enforcing verdict (block, or a would-be redaction that can't be re-encoded into SSE frames) withholds the response with a terminal error frame; otherwise the buffered SSE is flushed (detokenized). Usage is still metered. 1 integration test.
- **P2C least-load + session affinity (HRW) — ✅ delivered.** `@gulley/routing` gains a `LoadScoreboard` (in-flight counts) driving power-of-two-choices least-load selection for the `loadbalance` primary pick (default via `LB_LEAST_LOAD`), and weighted rendezvous hashing (`hrwOrder`) that pins a session to one target when `LB_SESSION_AFFINITY_HEADER` is set (header value, else principal id). Gateway begins on the served target and releases in teardown. 5 routing tests + 1 gateway integration test.
- _Still open in M11 (deferred): HTTP Basic/htpasswd inbound auth; Google Model Armor plugin; passive outlier-detection ejection/uneviction; PII depth (libphonenumber, context-word boosting)._

## M12 — Observability engine, config hot-reload & HTTP edge (P2/P3)

- **Config** — Postgres **LISTEN/NOTIFY** hot-reload (self-notification id) + Redis config pub/sub; **delta reconciliation** (upsert-then-prune, preserve live routing/breaker state); a resource manager (TTL remote-fetch cache + file-watch + commit/rollback); hybrid file+DB overlay + GitOps-lock + conflict detect + config-dump.
- **Observability** — a **config-driven access-log field engine** (add/remove/filter, value flattening — uses CEL); buffered per-stage **child spans** + outbound `traceparent` injection; trace sampling + span keep-filter + an OTLP access-log exporter.
- **HTTP edge** — **peekbody** (inspect N bytes then re-inject) + per-route BufferLimit + RecordedBody tee; buffer policy failClosed/failOpen; **CORS** (credentials-safe) for the admin UI; **CSRF** via Sec-Fetch-Site; HeaderModifier filter + RequestMirror (shadow traffic).
- **External policy hooks** — external authorization (simplified JSON contract, CEL-shaped request) + **decision caching** (expression key + TTL, single-flight refresh); configurable failure mode + external endpoint picker.
- **Admin DX** — runtime log-level control; redacted config dump; a live request tracer over SSE (`/debug/trace`); hardened draining.

**Done when:** a config change propagates across Fargate tasks without a redeploy and preserves live state; access-log fields are operator-configurable; external authz decisions are cached; the admin surface exposes runtime log control + a live tracer.

---

## Explicitly out of scope (this effort)

MCP tool-federation / agent gateway, A2A agent gateway, Kubernetes Gateway-API controller + xDS,
HBONE/SPIFFE service-mesh transport, and inference-gateway (GPU/KV-cache/LoRA) routing. Captured in
the catalog for reference only.
