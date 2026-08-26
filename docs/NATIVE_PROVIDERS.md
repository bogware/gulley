# Native provider depth (Gemini / Vertex, Copilot)

Most non-Anthropic providers are reachable two ways in Gulley:

1. **OpenAI-compatible preset** (`packages/providers/src/presets.ts`) — rides the
   provider's `/chat/completions` shim. Zero-translation, but the shim drops
   provider-affine artifacts (reasoning signatures, cache markers).
2. **Native adapter** — speaks the provider's real protocol so those artifacts
   round-trip. This is what "native depth" means.

## Copilot / GitHub Models

GitHub Models is genuinely OpenAI-shaped, so the `copilot` preset + the existing
`AnthropicToOpenAIAdapter` (for Anthropic-speaking clients) is the full story —
there is no separate native protocol to implement.

## Gemini / Vertex AI (native `generateContent`)

`packages/providers/src/gemini.ts` speaks Gemini's real `contents`/`parts`
protocol:

- `anthropicToGemini(body)` — canonical Anthropic Messages → Gemini
  `generateContent` (roles, `systemInstruction`, `generationConfig`), and
  round-trips a prior `thinking` block's **`thoughtSignature`** back onto the
  reasoning part so the model accepts it as its own.
- `geminiSseToAnthropic(stream, model)` — Gemini `streamGenerateContent?alt=sse`
  → Anthropic Messages SSE: thinking parts become a `thinking` block, a part's
  `thoughtSignature` is relayed as a `signature_delta`, and `usageMetadata` maps
  to `message_delta.usage` (input = prompt − cached, cache_read = cached, output =
  candidates + thoughts).
- `GeminiNativeAdapter` — Anthropic in, native Gemini upstream, Anthropic out.

Text + thinking survive; tool/image blocks are pinned to their family and refused
(`canTranslateAnthropicToGemini`) so nothing is silently lost.

### Vertex auth (SA-JWT → OAuth2)

Vertex authenticates with a short-lived Bearer token.
`GoogleServiceAccountTokenProvider` (`packages/providers/src/google-auth.ts`)
mints one from a service account via the self-signed-JWT grant and caches it until
just before expiry (single-flight). Wire it into the adapter so tokens rotate with
no gateway plumbing:

```ts
import {
  GeminiNativeAdapter,
  GoogleServiceAccountTokenProvider,
  PassthroughAdapter,
} from '@gulley/providers';

const tokenProvider = GoogleServiceAccountTokenProvider.fromJson(saJson);
const inner = new PassthroughAdapter({
  name: 'vertex',
  baseUrl: 'https://us-central1-aiplatform.googleapis.com',
});
const adapter = new GeminiNativeAdapter({
  inner,
  targetModel: 'gemini-2.5-pro',
  pathTemplate:
    '/v1/projects/PROJECT/locations/us-central1/publishers/google/models/{model}:streamGenerateContent?alt=sse',
  tokenProvider, // mints + rotates the Bearer per call
});
```

Register `adapter` as a route target (client path `/vertex/v1/messages`,
`createExtractor: () => new AnthropicUsageExtractor()` — the translated stream is
Anthropic-shaped, so metering reads the mapped usage). Because the adapter emits
canonical Anthropic SSE, the whole downstream pipeline (guardrails, cache,
metering, audit) works unchanged.
