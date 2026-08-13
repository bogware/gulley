import { type Result, err, ok } from '@gulley/core';
import type { AuthFailure } from './errors';
import type { KeyStore } from './key-store';
import type { Principal } from './principal';
import { parseVirtualKey, verifySecret } from './virtual-key';

/** Credential channels lifted off the request. */
export interface AuthContext {
  /** `x-api-key` header (Claude Code's ANTHROPIC_API_KEY). */
  apiKey?: string | undefined;
  /** `Authorization: Bearer` value (ANTHROPIC_AUTH_TOKEN). */
  bearer?: string | undefined;
}

export interface ResolverDeps {
  keyStore: KeyStore;
  pepper: string;
  /** Injected for testability. */
  now?: () => number;
}

/**
 * Resolve a virtual-key principal. Deterministic and FAIL-CLOSED: a request that
 * presents a `gk_` token is resolved only as a virtual key, and any miss is an
 * auth failure — never a fall-through to another auth mode. The route policy
 * decides which resolver runs; this one owns exactly the virtual-key mode.
 */
export async function resolveVirtualKey(
  ctx: AuthContext,
  deps: ResolverDeps,
): Promise<Result<Principal, AuthFailure>> {
  const now = deps.now ? deps.now() : Date.now();

  const candidate = pickVirtualKeyCandidate(ctx);
  if (candidate === null) return err({ reason: 'missing_credential' });

  const parsed = parseVirtualKey(candidate);
  if (!parsed) return err({ reason: 'malformed_credential' });

  const stored = await deps.keyStore.findByPrefix(parsed.keyPrefix);
  if (!stored) return err({ reason: 'unknown_key' });
  if (!verifySecret(deps.pepper, parsed.secret, stored.keyHash)) {
    return err({ reason: 'bad_secret' });
  }
  if (stored.disabled) return err({ reason: 'disabled' });
  if (stored.expiresAt && stored.expiresAt.getTime() <= now) return err({ reason: 'expired' });

  // Best-effort last-used bookkeeping — MUST NOT reject unhandled: a transient
  // DB error here would otherwise become an unhandledRejection and, under Node's
  // default policy, terminate the process (severing every in-flight stream).
  void deps.keyStore.touchLastUsed(stored.id).catch(() => {});

  return ok({
    kind: 'virtual-key',
    id: stored.id,
    displayName: stored.displayName,
    authMode: 'virtual-key',
    scope: {
      orgId: stored.orgId,
      workspaceId: stored.workspaceId,
      allowedProviders: stored.allowedProviders,
      allowedModels: stored.allowedModels,
    },
  });
}

/** A virtual key may arrive on either channel; both map to the virtual-key mode. */
function pickVirtualKeyCandidate(ctx: AuthContext): string | null {
  if (ctx.apiKey && ctx.apiKey.startsWith('gk_')) return ctx.apiKey;
  if (ctx.bearer && ctx.bearer.startsWith('gk_')) return ctx.bearer;
  return null;
}
