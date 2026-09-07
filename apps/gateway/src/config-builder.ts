import type { ConfigDocument, ConfigEntity, ConfigProvider } from '@gulley/config';
import type { SecretResolver } from '@gulley/core';
import { type ModelRouteRule, ModelRouter } from '@gulley/routing';
import {
  AnthropicAdapter,
  AnthropicUsageExtractor,
  AzureAdapter,
  BedrockAdapter,
  OpenAIAdapter,
  OpenAIUsageExtractor,
  type UpstreamCredential,
} from '@gulley/providers';
import {
  type Detector,
  type GuardrailAction,
  GuardrailEngine,
  type GuardrailPolicy,
  InjectionDetector,
  NativeDetector,
  strongerPolicy,
} from '@gulley/guardrails';
import type { ProviderRoute } from './routes/messages';

/** sk-ant-… keys use x-api-key; OAuth/enterprise tokens use bearer. */
function anthropicCredential(value: string): UpstreamCredential {
  return value.startsWith('sk-ant-') ? { scheme: 'x-api-key', value } : { scheme: 'bearer', value };
}

/**
 * Build the model router from the config document's `modelAliases` so
 * admin-configured aliases/pins take effect in the data plane (they were built only
 * from the CUSTOM_PROVIDERS env before, so DB-configured aliases were inert). An
 * alias entity maps a requested-model pattern (its `config.pattern`, else its name)
 * to an upstream `target` rewrite and/or a `provider` label. Single-tenant v1:
 * aliases across all workspaces are flattened into one global router.
 */
export function buildModelRouterFromDocument(doc: ConfigDocument): ModelRouter | undefined {
  const rules: ModelRouteRule[] = [];
  for (const org of doc.orgs) {
    for (const ws of org.workspaces) {
      for (const alias of ws.modelAliases ?? []) {
        const cfg = alias.config;
        const pattern =
          typeof cfg['pattern'] === 'string' ? (cfg['pattern'] as string) : alias.name;
        const rule: ModelRouteRule = { pattern };
        if (typeof cfg['target'] === 'string') rule.target = cfg['target'] as string;
        if (typeof cfg['provider'] === 'string') rule.provider = cfg['provider'] as string;
        rules.push(rule);
      }
    }
  }
  return rules.length > 0 ? new ModelRouter(rules) : undefined;
}

/** A workspace's resolved guardrail configuration, attached to each of its routes. */
export interface WorkspaceGuardrails {
  engine: GuardrailEngine;
  /** In-stream (windowed) enforcement of the OUTPUT policy on STREAMED responses.
   *  Streamed output guardrails are audit-only unless enforcement is opted in, so
   *  this defaults ON when the output policy enforces (block/mask/redact) — a
   *  coding agent's streamed response would otherwise bypass output DLP entirely.
   *  A guardrail entity can force it off (`streamEnforce: false`) to keep raw-byte
   *  fidelity and fall back to buffered (non-streamed) enforcement. */
  streamEnforce: boolean;
}

const VALID_ACTIONS = new Set<GuardrailAction>(['audit', 'mask', 'redact', 'block']);

function asAction(v: unknown): GuardrailAction | undefined {
  return typeof v === 'string' && VALID_ACTIONS.has(v as GuardrailAction)
    ? (v as GuardrailAction)
    : undefined;
}

/** Parse one direction (`input`/`output`) of a guardrail entity's config into a
 *  policy, honoring the top-level `action` shorthand as the fallback for both
 *  directions. Returns undefined when neither is specified. */
function parsePolicy(
  entity: Record<string, unknown>,
  dir: 'input' | 'output',
): GuardrailPolicy | undefined {
  const raw = entity[dir];
  const shorthand = asAction(entity['action']);
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const action = asAction(obj?.['action']) ?? shorthand;
  if (!action) return undefined;
  const policy: GuardrailPolicy = { action };
  const min = obj?.['minConfidence'];
  if (typeof min === 'number' && Number.isFinite(min)) policy.minConfidence = min;
  const cats = obj?.['categories'];
  if (Array.isArray(cats))
    policy.categories = cats.filter((c): c is string => typeof c === 'string');
  return policy;
}

function stronger(
  a: GuardrailPolicy | undefined,
  b: GuardrailPolicy | undefined,
): GuardrailPolicy | undefined {
  if (!a) return b;
  if (!b) return a;
  // Strongest action + widest coverage wins so folding entities never weakens
  // enforcement (shared with the engine's global-floor layering).
  return strongerPolicy(a, b);
}

/**
 * Build a per-workspace guardrail engine from its `guardrails` config entities —
 * the document-sourced sibling of context.ts's env `buildGuardrails`. Entities are
 * folded so the strongest action and widest coverage win (multiple entities never
 * weaken enforcement); native PII/secret detection is always on, with entropy and
 * prompt-injection detectors opt-in per entity. Returns undefined when there are no
 * entities (the route then falls back to the context's global engine).
 *
 * When a `base` engine (the env-configured global floor) is given, the workspace
 * engine is LAYERED OVER it (engine.layerOver): the floor's external DLP plugins
 * and any stronger direction survive, so adding a partial/weaker workspace policy
 * can only ADD to the org floor — never silently drop its output enforcement or
 * managed plugins. streamEnforce keys off the WORKSPACE's own output intent (not
 * the floor's), so adding a guardrail entity never surprises a workspace by turning
 * on in-stream enforcement the floor would otherwise have kept audit-only on streams.
 *
 * Entity `config` shape (all optional):
 *   { action?, input?: {action,minConfidence?,categories?}, output?: {...},
 *     entropy?: bool, injection?: bool, streamEnforce?: bool }
 * `action` is a shorthand applied to whichever direction omits its own policy.
 */
export function buildWorkspaceGuardrails(
  entities: ConfigEntity[],
  base?: GuardrailEngine,
): WorkspaceGuardrails | undefined {
  if (entities.length === 0) return undefined;
  let input: GuardrailPolicy | undefined;
  let output: GuardrailPolicy | undefined;
  let entropy = false;
  let injection = false;
  let streamOn = false;
  let streamOff = false;
  for (const e of entities) {
    const c = e.config;
    input = stronger(input, parsePolicy(c, 'input'));
    output = stronger(output, parsePolicy(c, 'output'));
    if (c['entropy'] === true) entropy = true;
    if (c['injection'] === true) injection = true;
    if (c['streamEnforce'] === true) streamOn = true;
    if (c['streamEnforce'] === false) streamOff = true;
  }
  const detectors: Detector[] = [new NativeDetector({ entropy })];
  if (injection) detectors.push(new InjectionDetector());
  let engine = new GuardrailEngine(detectors, {
    input: input ?? { action: 'audit' },
    output: output ?? { action: 'audit' },
  });
  // Never below the org floor: retain its plugins and stronger directions.
  if (base) engine = engine.layerOver(base);
  const outputEnforcing = (output?.action ?? 'audit') !== 'audit';
  // On when explicitly asked, or when the WORKSPACE's own output enforces and nobody
  // opted out (a floor-only enforcing output stays audit-only on streams, unchanged).
  const streamEnforce = streamOn || (outputEnforcing && !streamOff);
  return { engine, streamEnforce };
}

/**
 * The provider routes for one DB-configured provider — the document-sourced
 * sibling of context.ts's env `buildRoutes`. The credential value has already
 * been resolved from its ARN; this only maps a provider kind → adapter + paths.
 * An unknown kind yields no routes (skipped, not an error).
 */
export function routesForProvider(
  kind: string,
  baseUrl: string | null,
  value: string,
): ProviderRoute[] {
  switch (kind) {
    case 'anthropic':
      return [
        {
          clientPaths: ['/v1/messages', '/anthropic/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: {
            mode: 'single',
            target: {
              name: 'anthropic',
              provider: 'anthropic',
              adapter: new AnthropicAdapter({ baseUrl: baseUrl ?? 'https://api.anthropic.com' }),
              credential: anthropicCredential(value),
              upstreamPath: '/v1/messages',
            },
          },
        },
      ];
    case 'openai': {
      const adapter = new OpenAIAdapter({ baseUrl: baseUrl ?? 'https://api.openai.com' });
      const credential: UpstreamCredential = { scheme: 'bearer', value };
      const target = (upstreamPath: string) => ({
        name: 'openai',
        provider: 'openai',
        adapter,
        credential,
        upstreamPath,
      });
      return [
        {
          clientPaths: ['/v1/chat/completions', '/openai/v1/chat/completions'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/v1/chat/completions') },
        },
        {
          clientPaths: ['/v1/responses', '/openai/v1/responses'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/v1/responses') },
        },
        {
          clientPaths: ['/v1/embeddings', '/openai/v1/embeddings'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/v1/embeddings') },
          cacheable: false,
        },
      ];
    }
    case 'bedrock':
      return [
        {
          clientPaths: ['/bedrock/v1/messages'],
          createExtractor: () => new AnthropicUsageExtractor(),
          strategy: {
            mode: 'single',
            target: {
              name: 'bedrock',
              provider: 'bedrock',
              adapter: new BedrockAdapter({ region: baseUrl ?? 'us-east-1' }),
              credential: { scheme: 'bearer', value },
              upstreamPath: '/v1/messages',
              alwaysStream: true,
            },
          },
        },
      ];
    case 'azure': {
      if (!baseUrl) return [];
      const adapter = new AzureAdapter({ baseUrl });
      const credential: UpstreamCredential = { scheme: 'api-key', value };
      const target = (upstreamPath: string) => ({
        name: 'azure',
        provider: 'azure',
        adapter,
        credential,
        upstreamPath,
      });
      return [
        {
          clientPaths: ['/azure/v1/chat/completions', '/azure/openai/v1/chat/completions'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/openai/v1/chat/completions') },
        },
        {
          clientPaths: ['/azure/v1/responses', '/azure/openai/v1/responses'],
          createExtractor: () => new OpenAIUsageExtractor(),
          strategy: { mode: 'single', target: target('/openai/v1/responses') },
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Build the gateway's provider routes from a config document, resolving each
 * enabled provider's credential ARN via `resolver`. A resolution failure REJECTS
 * (the caller must abort the reconcile and keep the old routes) — never a partial
 * table with a live route pointing at an unresolved credential.
 *
 * `baseGuardrails` is the env-configured global engine (ctx.guardrails). A workspace
 * guardrail policy is LAYERED OVER it, never replacing it, so a partial workspace
 * policy can't silently drop the org's output enforcement or managed DLP plugins.
 */
export async function buildRoutesFromDocument(
  doc: ConfigDocument,
  resolver: SecretResolver,
  baseGuardrails?: GuardrailEngine,
): Promise<ProviderRoute[]> {
  const routes: ProviderRoute[] = [];
  for (const org of doc.orgs) {
    for (const ws of org.workspaces) {
      // Per-workspace guardrail policy (DLP/PII) built once and attached to every
      // route this workspace serves, so a DB-configured policy is enforced in the
      // data plane instead of sitting inert (routes without one fall back to the
      // context's global engine). Layered over the global floor so it never enforces
      // BELOW it. Single-tenant v1: providers/routes are global, so the LAST
      // workspace that declares a guardrail wins for a shared path — but every
      // workspace engine is >= the floor, so a shared path never drops below it.
      const guardrails = buildWorkspaceGuardrails(ws.guardrails, baseGuardrails);
      for (const p of ws.providers as ConfigProvider[]) {
        if (!p.enabled || !p.credential) continue;
        const value = await resolver.resolve(p.credential);
        for (const route of routesForProvider(p.kind, p.baseUrl ?? null, value)) {
          if (guardrails) {
            route.guardrails = guardrails.engine;
            // In-stream output enforcement is meaningless on non-cacheable/embedding
            // shapes; the pipeline already gates it to enforceable stream dialects.
            if (guardrails.streamEnforce) route.streamEnforce = true;
          }
          routes.push(route);
        }
      }
    }
  }
  return routes;
}
