/**
 * OpenAI-compatible provider presets. Most hosted "OpenAI-compatible" gateways
 * and every popular local runtime (Ollama, Jan, LM Studio, vLLM, LocalAI,
 * llama.cpp, …) expose the `/v1/chat/completions` surface, so a single
 * passthrough adapter serves them all — a preset just supplies the base URL, the
 * chat path, and whether an API key is required. Local presets are keyless and
 * point at loopback defaults; the operator overrides the base URL as needed.
 *
 * Base URLs are chosen so `baseUrl + chatPath` is the real endpoint. They are
 * server-side config (never client-supplied), so pointing one at a loopback/LAN
 * host is a deliberate operator choice, not an SSRF vector.
 */
export interface ProviderPreset {
  /** Metering / cost-catalog label. */
  provider: string;
  baseUrl: string;
  /** Path appended to baseUrl for chat completions. */
  chatPath: string;
  /** Path for embeddings, when the preset's base differs from `/v1/embeddings`. */
  embeddingsPath?: string;
  /** True if the backend needs an API key (local runtimes do not). */
  requiresKey: boolean;
  /** Loopback/self-hosted runtime (keyless, http, operator-configured host). */
  local?: boolean;
}

const CHAT = '/v1/chat/completions';
const EMBED = '/v1/embeddings';

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  // --- Hosted OpenAI-compatible ---
  groq: {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai',
    chatPath: CHAT,
    requiresKey: true,
  },
  mistral: {
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai',
    chatPath: CHAT,
    requiresKey: true,
  },
  together: {
    provider: 'together',
    baseUrl: 'https://api.together.xyz',
    chatPath: CHAT,
    requiresKey: true,
  },
  openrouter: {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api',
    chatPath: CHAT,
    requiresKey: true,
  },
  deepseek: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    chatPath: CHAT,
    requiresKey: true,
  },
  fireworks: {
    provider: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference',
    chatPath: CHAT,
    requiresKey: true,
  },
  cerebras: {
    provider: 'cerebras',
    baseUrl: 'https://api.cerebras.ai',
    chatPath: CHAT,
    requiresKey: true,
  },
  xai: { provider: 'xai', baseUrl: 'https://api.x.ai', chatPath: CHAT, requiresKey: true },
  nvidia: {
    provider: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com',
    chatPath: CHAT,
    requiresKey: true,
  },
  deepinfra: {
    provider: 'deepinfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    chatPath: '/chat/completions',
    embeddingsPath: '/embeddings',
    requiresKey: true,
  },
  perplexity: {
    provider: 'perplexity',
    baseUrl: 'https://api.perplexity.ai',
    chatPath: '/chat/completions',
    requiresKey: true,
  },
  // Google Gemini via its OpenAI-compatible surface (native generateContent
  // adapter with thoughtSignature round-trip is a later, higher-fidelity add).
  gemini: {
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatPath: '/chat/completions',
    embeddingsPath: '/embeddings',
    requiresKey: true,
  },
  // GitHub Models / Copilot via its OpenAI-compatible inference surface (auth is a
  // GitHub token). `chatPath` is the full path under the inference base.
  copilot: {
    provider: 'copilot',
    baseUrl: 'https://models.github.ai/inference',
    chatPath: '/chat/completions',
    embeddingsPath: '/embeddings',
    requiresKey: true,
  },
  // Google Vertex AI via its OpenAI-compatible endpoint. The base URL is
  // project/region-specific, so override `baseUrl` per deployment, e.g.
  // https://us-central1-aiplatform.googleapis.com/v1beta1/projects/PROJECT/locations/us-central1/endpoints/openapi
  // Auth is a Google OAuth2 access token (SA/ADC) supplied as the API key.
  vertex: {
    provider: 'vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1beta1',
    chatPath: '/chat/completions',
    requiresKey: true,
  },

  // --- Local / self-hosted runtimes (keyless, OpenAI-compatible) ---
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
  jan: {
    provider: 'jan',
    baseUrl: 'http://localhost:1337',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
  lmstudio: {
    provider: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
  vllm: {
    provider: 'vllm',
    baseUrl: 'http://localhost:8000',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
  localai: {
    provider: 'localai',
    baseUrl: 'http://localhost:8080',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
  llamacpp: {
    provider: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
  koboldcpp: {
    provider: 'koboldcpp',
    baseUrl: 'http://localhost:5001',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
  tgwui: {
    provider: 'tgwui',
    baseUrl: 'http://localhost:5000',
    chatPath: CHAT,
    requiresKey: false,
    local: true,
  },
};

/** Declarative config for one custom / preset-backed OpenAI-compatible provider. */
export interface CustomProviderConfig {
  /** Preset name to base this on (fills baseUrl / chatPath / requiresKey). */
  preset?: string;
  /** Provider label (defaults to the preset's). Required when no preset. */
  provider?: string;
  /** Base URL override (required when no preset). */
  baseUrl?: string;
  /** API key; omit for keyless local runtimes. */
  apiKey?: string;
  /** Chat-completions path override. */
  chatPath?: string;
  /** Model ids this provider serves — surfaced by /v1/models and used to route
   *  a shared /v1/chat/completions request by model. */
  models?: string[];
  /** Expose a /{provider}/v1/embeddings passthrough (many local runtimes serve
   *  embeddings too). Defaults the path to /v1/embeddings unless overridden. */
  embeddings?: boolean;
  embeddingsPath?: string;
}

export interface ResolvedProvider {
  provider: string;
  baseUrl: string;
  chatPath: string;
  apiKey: string;
  local: boolean;
  models: string[];
  /** Present when this provider should expose an embeddings passthrough. */
  embeddingsPath?: string;
}

/** Resolve a declarative entry against the preset table. Throws on missing
 *  required fields or an unknown preset. */
export function resolveCustomProvider(entry: CustomProviderConfig): ResolvedProvider {
  const preset = entry.preset ? PROVIDER_PRESETS[entry.preset] : undefined;
  if (entry.preset && !preset) throw new Error(`unknown provider preset: ${entry.preset}`);
  const provider = entry.provider ?? preset?.provider;
  const baseUrl = entry.baseUrl ?? preset?.baseUrl;
  if (!provider) throw new Error('custom provider requires a "provider" label (or a preset)');
  if (!baseUrl) throw new Error(`custom provider "${provider}" requires a baseUrl (or a preset)`);
  // Embeddings are opt-in: an explicit path, or the `embeddings` flag which uses
  // the preset's embeddings path (falling back to /v1/embeddings).
  const embeddingsPath =
    entry.embeddingsPath ?? (entry.embeddings ? (preset?.embeddingsPath ?? EMBED) : undefined);

  return {
    provider,
    baseUrl,
    chatPath: entry.chatPath ?? preset?.chatPath ?? CHAT,
    apiKey: entry.apiKey ?? '',
    local: preset?.local ?? false,
    models: Array.isArray(entry.models) ? entry.models.filter((m) => typeof m === 'string') : [],
    ...(embeddingsPath ? { embeddingsPath } : {}),
  };
}
