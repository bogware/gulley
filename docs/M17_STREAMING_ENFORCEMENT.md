# M17 — Streaming output-guardrail enforcement

Until now, output guardrails could only **enforce** (block / redact) on a
non-streamed or hold-then-flush (buffered) response; on a live SSE stream they
were **audit-only** (scan + record, never modify) because enforcement conflicts
with raw-byte fidelity. M17 adds an **opt-in** mode that enforces the output
policy **in-stream**: it redacts matched PII/secret spans (or blocks on the first
violation) via a **windowed delayed-emit** transformer, trading raw-byte fidelity
and a bounded latency window — for that mode only — for enforcement.

## What it does

With `STREAMING_ENFORCE=true` and an enforcing `GUARDRAILS_OUTPUT_ACTION`
(`redact` / `mask` / `block`), a streamed **Anthropic-canonical** response is
rewritten as it flows to the client:

- **redact / mask** — each matched span (above `GUARDRAILS_OUTPUT_MIN_CONFIDENCE`)
  is replaced with `<<REDACTED_CATEGORY>>` before it reaches the client. A
  bounded tail is held back so a match forming at a chunk boundary is never
  split, and the safe-emit boundary is pulled earlier so a span's leading bytes
  are never emitted ahead of its redaction.
- **block** — the clean content up to the first violation is streamed, then the
  stream is terminated with a provider-shaped terminal SSE error. Content already
  streamed before the violation is inherent to streaming (irrevocable); a route
  wanting a strict all-or-nothing block should use `holdStreamedOutput`
  (buffer-and-withhold) instead.

Off by default: with the flag unset, streamed output is byte-identical raw
passthrough + audit-only — unchanged.

## Design — two layers, composed in the gateway

- **`StreamingRedactor`** (`@gulley/guardrails`) — the mutate-and-emit analogue of
  `StreamingScanner`, over **logical text** (not raw SSE). `push`/`flush` hold a
  `windowChars` tail, pull the safe boundary back past any straddling finding,
  redact findings inside the safe prefix, and emit. A `block` policy emits the
  clean prefix and sets `blocked`. The hold buffer is byte-capped: an open-ended
  match trips `failClosed` (withhold the rest). `findings()` are de-duplicated
  absolute offsets for the audit trail. Guarantee (mirrors `StreamingReplacer`):
  the concatenation of all output equals `redactText` over the fully-buffered
  body, for any chunk boundaries.
- **`AnthropicSseRewriter`** (`@gulley/providers`) — wraps `SSEParser`, applies an
  injected `{push, flush}` text transform to `content_block_delta` / `text_delta`
  text **only**, re-frames via `JSON.stringify` (so a placeholder's quotes /
  newlines stay escaped; SSE frames self-delimit, so a changed length is safe),
  preserves `index`, flushes the transform's held tail before each structural
  block-end, and passes every other frame (`message_start`, `thinking_delta`,
  `signature_delta`, `input_json_delta`, the usage-bearing `message_delta`, …)
  through verbatim.
- **Gateway** composes them at the single byte-transform seam in `handleProxy`:
  the shared `StringDecoder` output (code-point-clean, so no multi-byte UTF-8
  split) → `detok` (logical, if the request was masked) → redactor → SSE rewriter
  → the client, through the **same** backpressure `write` + `pause`/`drain` path.

## Invariants — relaxed (opt-in only) vs preserved

**Relaxed, only when the flag is on:** raw-byte fidelity (matched spans are
rewritten; a bounded tail is held before emit); a bounded added latency (the
delayed-emit window, `STREAMING_ENFORCE_WINDOW_CHARS`); and — for block —
content emitted before the first violation cannot be recalled.

**Preserved:** the single centralized `teardown()` (a block/fail-closed
termination aborts into the existing end/error funnel — never a fourth teardown);
backpressure (redacted buffers use the same `write`/`pause`/`drain`); the
inactivity watchdog (reset per chunk, cleared on block; the enforcer emits behind
its window immediately and never awaits more input); **meter-from-raw-usage**
(`usage.ingestSse` still parses the **original** pre-redaction frames via a second
independent parser); fail-closed on buffer overflow; and cache safety (enforcing
routes are never cached).

## Config

`GUARDRAILS_OUTPUT_ACTION` (audit | block | mask | redact) + `..._MIN_CONFIDENCE`,
`STREAMING_ENFORCE` (bool), `STREAMING_ENFORCE_WINDOW_CHARS` (default 256).

## Scope & limitations (v1)

- **Anthropic-canonical routes only.** The rewriter understands
  `content_block_delta`/`text_delta`; the gate restricts streaming enforcement to
  `/v1/messages`-family client paths (whose client-bound stream is Anthropic SSE).
  For other client shapes (native OpenAI `/v1/chat/completions`, Bedrock
  eventstream) use `holdStreamedOutput` for strict enforcement; streamed output
  there stays audit-only.
- **`windowChars` must exceed the longest expected match** — a match longer than
  the window can leak a prefix before it is recognized. Bounded categories
  (patterns + secret prefixes) are well-behaved; an open-ended `high_entropy`
  match trips the fail-closed cap.
- **Streaming `mask` == redaction.** There is no reversible client-side mask on
  the output side today (the vault is input-side); a streamed `mask` policy maps
  to irreversible `<<REDACTED_…>>` placeholders. Genuine reversible output-mask is
  a later milestone.
- **A persistent record + native non-Anthropic re-framing** are additive
  follow-ons.

## Phases

1. `StreamingRedactor` primitive (`@gulley/guardrails`) + unit tests (equivalence,
   boundary hold, block, de-dup, fail-closed).
2. `AnthropicSseRewriter` (`@gulley/providers`) + unit tests (verbatim
   passthrough, text-delta rewrite, held-tail flush, JSON escaping, split match).
3. Gateway hot-path wiring (the enforcer at the transform seam, block termination,
   flush, teardown findings, header) — **adversarial review**.
4. Config + `buildGuardrails` output policy + `.env.example`.
5. Integration tests (redact, block, clean-passthrough end-to-end) + docs.
