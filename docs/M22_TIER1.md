# M22 — Tier 1 differentiators

The Tier-1 "differentiators" from the port roadmap (`docs/AGENTGATEWAY_PORT.md`).
Each is a deep, high-value edge over the moat already built. Same per-slice
discipline: implement → focused tests → `bash ci/verify.sh` green → commit `-s` →
push. Hot-path-file slices carry a `Hotpath-Reviewed:` trailer and an adversarial
review.

| Slice | What                                                                                                 | Status |
| ----- | ---------------------------------------------------------------------------------------------------- | ------ |
| **A** | Native **Gemini tool-call + image** translation (makes Vertex first-class; M14 B did text+thinking). | ✅     |

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
  | **B** | **`/v1/responses` streaming enforcement** + a durable, encrypted **vault-reversal** path. | ⏳ |
  | **C** | **pgvector-backed centroid ANN** (M18 persists jsonb + in-JS cosine; scale to large exemplar sets). | ✅ |

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
