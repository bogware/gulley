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
  | **C** | **pgvector-backed centroid ANN** (M18 persists jsonb + in-JS cosine; scale to large exemplar sets). | ⏳ |
