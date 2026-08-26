import { z } from 'zod';

/** Providers Gulley fronts in v1. */
export const ProviderKind = z.enum([
  'anthropic',
  'anthropic-enterprise',
  'openai',
  'bedrock',
  'azure-foundry',
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * Client -> gateway auth modes a route policy may allow for a (provider, route)
 * pair. The auth resolver selects exactly one deterministically and fails closed
 * on it — it never falls through from one mode to another.
 */
export const AuthMode = z.enum(['oauth-broker', 'virtual-key', 'passthrough', 'basic']);
export type AuthMode = z.infer<typeof AuthMode>;

/** API surfaces Gulley routes/meters/guards/caches as first-class in v1. */
export const ApiSurface = z.enum(['anthropic-messages', 'openai-chat', 'openai-responses']);
export type ApiSurface = z.infer<typeof ApiSurface>;
