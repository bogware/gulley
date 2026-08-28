# M22 — Tier 1 differentiators

The Tier-1 "differentiators" from the port roadmap (`docs/AGENTGATEWAY_PORT.md`).
Each is a deep, high-value edge over the moat already built. Same per-slice
discipline: implement → focused tests → `bash ci/verify.sh` green → commit `-s` →
push. Hot-path-file slices carry a `Hotpath-Reviewed:` trailer and an adversarial
review.

Roadmap item #2 ("`/v1/responses` streaming enforcement + persisted-vault reversal
path") is genuinely two features, shipped as separate slices **B** and **D**.

| Slice | What                                                                                                 | Status |
| ----- | ---------------------------------------------------------------------------------------------------- | ------ |
| **A** | Native **Gemini tool-call + image** translation (makes Vertex first-class; M14 B did text+thinking). | ✅     |
| **B** | **`/v1/responses` streaming output-guardrail enforcement** (was audit-only).                         | ✅     |
| **C** | **pgvector-backed centroid ANN** (M18 persists jsonb + in-JS cosine; scale to large exemplar sets).  | ✅     |
| **D** | Durable, encrypted **mask-vault reversal** path (persist the mask token↔original map at rest).       | ✅     |

## A — Native Gemini tool-call + image translation ✅

Entirely local to `packages/providers/src/gemini.ts` (the native `contents`/`parts`
adapter M14 B added for text + `thoughtSignature`). Both directions now round-trip
tool-calls and base64 images:

- **Request** (`anthropicToGemini`): `tool_use` → `functionCall`; `tool_result` →
  `functionResponse`, resolving the block's `tool_use_id` back to the function name
  via a scan of prior `tool_use` blocks (Gemini keys functionResponse on **name**, not
  id); top-level `tools` → `functionDeclarations`; `tool_choice` (auto/any/none/tool)
  → `toolConfig.functionCallingConfig`; base64 `image` block → `inlineData`.
- **Response** (`geminiSseToAnthropic`): a `functionCall` part becomes the canonical
  Anthropic `tool_use` triple (synthesized id + one `input_json_delta` with the args —
  Gemini sends the whole args in one chunk, no accumulation), atomically closing any
  open text block first; an `inlineData` part becomes an image block. **`stop_reason`
  is driven by the presence of a functionCall part** (`tool_use`), because Gemini
  reports `finishReason: STOP` even on a tool turn.
- **Refusal narrowed**: only genuinely untranslatable content (a URL-sourced image)
  is refused; text/thinking/tool/base64-image all translate. Metering, teardown, and
  downstream guardrails are unaffected — the adapter still emits canonical Anthropic
  SSE. 12 provider tests.

## B — /v1/responses streaming enforcement ✅

Extends the opt-in windowed streaming enforcer (M17/M18) to the OpenAI Responses API
(`/v1/responses`), which was audit-only. New `ResponsesSseRewriter` applies the same
`StreamingRedactor` transform and — the hard part — keeps EVERY echo consistent: the
full assistant text is re-emitted in `output_text.done`, `content_part.done`,
`output_item.done`, and `response.completed`, and most SDKs build the final message
from one of those. The stateful windowed transform can't re-run over the echoes, so
the rewriter substitutes its already-transformed accumulator into each. Per-token
`logprobs` (which echo the raw text token-by-token) are stripped from every rewritten
frame. Gateway wiring: `responsesClient` detection, `clientDialect: 'responses'`, the
enforcer branch, and a Responses-shaped terminal error frame. Usage in
`response.completed` is byte-intact (metered pre-rewrite). Single output_text part
only; an echo without a preceding delta → fail closed.

**Adversarial hot-path review** (6-agent workflow: 3 lenses + 3 judges) confirmed two
high-severity leaks in the first cut, both fixed + regression-tested: (1)
`response.output_item.done` passed through un-redacted (the frame the official SDK
builds `response.output` from); (2) `logprobs[].token` carried the raw text verbatim
(also closed the same pre-existing gap in `OpenAiSseRewriter`). 22 rewriter tests + 1
gateway integration test (all four echoes + output_item.done + logprobs proven
leak-free through `handleProxy`; usage preserved). `Hotpath-Reviewed` trailer.

## C — pgvector-backed centroid ANN ✅

M16/M18 persisted classifier exemplars as jsonb and ranked nearest-label by an O(N)
in-JS cosine scan (every vector shipped to every replica). C adds an indexed ANN
path, mirroring the semantic-cache pgvector tier exactly:

- **Schema + migration**: `classifier_centroid` gains a `embedding_vec vector(256)`
  column and an HNSW `vector_cosine_ops` index (migration 0012, hand-written like
  0003 — drizzle-kit can't emit the opclass), plus a `(scope, model)` btree for the
  ANN filter and a one-time backfill of existing jsonb rows. The jsonb `embedding`
  stays as the canonical value + in-memory fallback.
- **Dual-write, single writer**: `save()` (the table's only writer, so the columns
  can't drift) writes both `embedding` and `embedding_vec`. On PGlite (no pgvector)
  the column degrades to `text` and the literal stores harmlessly; the pg-test
  sanitizers skip the `CREATE EXTENSION` / `USING hnsw` / `::vector` backfill.
- **`PostgresCentroidIndex`**: request-time `nearest` is a `<=>` cosine ANN query
  filtered by scope AND embedding model, structurally a `CentroidIndex`. **Fail-open**
  (any DB error → `[]`, so `classifyRequest` abstains → model router — the same
  never-throw contract as the in-memory path).
- **Wiring**: `buildPersistentCentroids` (overloaded) still embeds + persists but
  returns the ANN index when one is supplied; `config-reload` builds it under
  `SMART_ROUTING_CENTROID_ANN` (opt-in) **only when `EMBEDDINGS_DIMENSIONS === 256`**
  (the vector column dim) — any other dim logs and falls back to the in-memory scan.

3 storage unit tests (row mapping, score coercion, fail-open) + the ANN-index build
path + the existing jsonb pg-test (dual-write confirmed working under PGlite). The
`<=>` distance itself is validated in prod/live, like the semantic tier (PGlite has
no pgvector).

## D — Durable, encrypted mask-vault reversal ✅

Guardrail `mask` tokenizes PII/secrets via a `TokenVault` (coreference-preserving,
reversible) — but the vault was request-scoped and never persisted, so a masked
response that still carries `<<GULLEY_…>>` tokens could never be de-tokenized later.
D adds a durable, **encrypted-at-rest** reversal store:

- **Store** (`@gulley/storage`): a `mask_vault` table (migration 0013) + a
  `PostgresMaskVaultStore` holding ONLY the `EnvelopeCiphertext` jsonb (never
  plaintext), keyed by `(request_id, direction)`, TTL-bounded with an `expiresAt`
  sweep like the exact cache.
- **Crypto**: the token↔original map (`TokenVault.entries()`) is envelope-encrypted
  with `@gulley/crypto` (KMS in prod, the in-memory dev twin otherwise), AAD-bound to
  `${requestId}:${workspaceId}:${direction}` so a stolen/misrouted row is
  undecryptable under any other scope. `TokenVault.fromEntries` rebuilds a vault from
  a decrypted map for later detokenization.
- **Hot path** (gateway teardown): each non-empty vault (input + the buffered/stream
  output vault) is encrypted and persisted in the single centralized `teardown()`,
  as a best-effort durable sink alongside ledger/audit/cache — **after** the budget
  release (a persist failure can't leak a reservation), so it never adds
  client-visible latency and never blocks first byte. The store only ever receives
  ciphertext (encrypt-before-store, enforced by construction). `MASK_VAULT_PERSIST`
  (off by default) + `GULLEY_KMS_KEY_ARN` + `MASK_VAULT_TTL_SECONDS`.
- **Reveal** (`control-api`): `GET /admin/mask-vault/:requestId` decrypts and returns
  the map for an authorized admin. Deny-by-default and high-privilege: a NEW
  **owner-only** `guardrail:reveal` permission (above `admin`, since it exposes raw
  secret VALUES) **and** workspace visibility (same as `/admin/logs`); decryption
  fails closed (502) on a wrong key / AAD mismatch; every reveal is hash-chain
  audited (`guardrail.reveal`) with only the actor + requestId + token **count** —
  never the values. `501` until wired.

Tests: 4 storage pg-tests (put/get/list/upsert/TTL-hide/sweep) + `TokenVault
.fromEntries` round-trip + 1 gateway integration test (teardown persists exactly one
encrypted input record; ciphertext carries no plaintext; decrypts back to the
original) + 5 control-api reveal tests (authorized decrypt, 404, wrong-key 502, 401,
501). `Hotpath-Reviewed` trailer.
