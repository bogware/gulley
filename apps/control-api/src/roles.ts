import {
  BUILTIN_ROLES,
  builtinRole,
  isPermission,
  type Permission,
  type RefreshableRoleResolver,
  type RoleDefinition,
} from '@gulley/rbac';
import type { RoleRow, RoleWrite } from '@gulley/storage';

/** The role catalogue port the control plane reads/writes: Postgres in DB mode
 *  (`PostgresRoleStore`), in-memory otherwise (`InMemoryRoleStore` in stores.ts).
 *  Built-ins are immutable (update/delete throw `BuiltinRoleError`). */
export interface RoleStore {
  list(): Promise<RoleRow[]>;
  get(id: string): Promise<RoleRow | undefined>;
  create(id: string, input: RoleWrite): Promise<RoleRow>;
  update(id: string, patch: Partial<RoleWrite>): Promise<RoleRow | undefined>;
  delete(id: string): Promise<boolean>;
  /** Upsert the built-in definitions so the stored catalogue mirrors the code's. */
  ensureBuiltins?(defs: readonly RoleDefinition[]): Promise<void>;
}

/** A stored row as a {@link RoleDefinition}; unknown permission names are dropped
 *  (never granted) rather than failing the whole role. */
export function roleDefinitionOf(row: RoleRow): RoleDefinition {
  return {
    id: row.id,
    name: row.name,
    permissions: row.permissions.filter((p): p is Permission => isPermission(p)),
    builtin: row.builtin,
    ...(row.description ? { description: row.description } : {}),
  };
}

export interface CachedRoleResolverOptions {
  /** Snapshot lifetime (ms); default 10 s. */
  ttlMs?: number;
  /** Structured hook for a failing load (the stale snapshot stays in use). */
  onError?: (err: unknown) => void;
  now?: () => number;
}

/**
 * The {@link RoleResolver} the permission engine consults for custom role ids: a
 * memoized snapshot of the store, refreshed at most every `ttlMs` (default 10 s),
 * stale-on-error (a failing store never widens or narrows what the last good snapshot
 * granted; before the first successful load only the built-ins resolve). `get` is
 * synchronous for the engine; `ensureFresh` lets async callers (the AccessControl
 * port, the membership routes) wait for a current snapshot; a write path calls
 * `invalidate` so its own replica sees the change immediately.
 */
export class CachedRoleResolver implements RefreshableRoleResolver {
  private snapshot = new Map<string, RoleDefinition>();
  private loadedAt = 0;
  private inflight: Promise<void> | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly load: () => Promise<RoleRow[]>,
    private readonly opts: CachedRoleResolverOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  get(roleId: string): RoleDefinition | undefined {
    const b = builtinRole(roleId);
    if (b) return b;
    if (this.stale()) void this.refresh();
    return this.snapshot.get(roleId);
  }

  /** Every definition: the built-ins (from code) + the custom snapshot. */
  list(): RoleDefinition[] {
    return [...BUILTIN_ROLES, ...this.snapshot.values()];
  }

  async ensureFresh(): Promise<void> {
    if (this.stale()) await this.refresh();
  }

  invalidate(): void {
    this.loadedAt = 0;
  }

  /** Reload the snapshot (single-flight). Never rejects. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const rows = await this.load();
        const next = new Map<string, RoleDefinition>();
        for (const r of rows)
          if (!r.builtin && !builtinRole(r.id)) next.set(r.id, roleDefinitionOf(r));
        this.snapshot = next;
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        // Stale-on-error: hold the old snapshot and retry only after the TTL, so a
        // failing store is not hammered once per permission check.
        this.loadedAt = this.now();
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private stale(): boolean {
    return this.now() - this.loadedAt >= this.ttlMs;
  }
}

/** Build the loader for a store: seeds the built-ins once (upsert), then lists. */
export function roleLoader(store: RoleStore): () => Promise<RoleRow[]> {
  let seeded = !store.ensureBuiltins;
  return async () => {
    if (!seeded) {
      await store.ensureBuiltins!(BUILTIN_ROLES);
      seeded = true;
    }
    return store.list();
  };
}
