import { contentHash, diffDocuments, toYaml } from '@gulley/config';
import type { AdminPrincipal, Permission, ScopeRef } from '@gulley/rbac';
import type { ConfigNotifier, PostgresConfigBackend } from '@gulley/storage';
import { auditedWrite } from './admin';
import type { ControlContext, DurableCommitDeps } from './context';

/**
 * DB mode: one console edit = one durable config commit. The mutation runs against the
 * Postgres config backend INSIDE the same transaction as its audit row and a new
 * `config_version` row (content hash + yaml + diff summary of the resulting document),
 * exactly like a GitOps apply — so the gateway's watcher sees the version advance and
 * reconciles, drift detection stays true, and the console's history shows the edit.
 * After commit the in-memory read model is re-hydrated and a bus signal is emitted.
 *
 * Before this, console CRUD in DB mode wrote only the process-local registries: the
 * gateway (which reads Postgres) never saw the change and a restart wiped it.
 */
export class DurableConfigWriter {
  constructor(
    private readonly deps: {
      atomic: <T>(fn: (deps: DurableCommitDeps) => Promise<T>) => Promise<T>;
      hydrate: () => Promise<unknown>;
      notifier?: ConfigNotifier;
      originId: string;
      now?: () => number;
    },
  ) {}

  async commit<T>(
    admin: AdminPrincipal,
    args: {
      action: string;
      target: string;
      orgId: string | null;
      diff: Record<string, unknown>;
      run: (backend: PostgresConfigBackend) => Promise<T>;
    },
  ): Promise<{ value: T; version: number; contentHash: string }> {
    const attempt = (): Promise<{ value: T; version: number; contentHash: string }> =>
      this.deps.atomic(async (d) => {
        const before = await d.store.exportDocument('*');
        const value = await args.run(d.backend);
        const after = await d.store.exportDocument('*');
        const hash = contentHash(after);
        const summary = diffDocuments(before, after);
        const auditRow = await d.audit.append({
          orgId: args.orgId,
          actor: admin.subject,
          action: args.action,
          target: args.target,
          payload: { ...args.diff, contentHash: hash },
        });
        const version = (await d.versions.currentVersion()) + 1;
        await d.versions.append({
          version,
          contentHash: hash,
          yaml: toYaml(after),
          actor: admin.subject,
          summary,
          auditSeq: auditRow.seq,
          createdAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
        });
        return { value, version, contentHash: hash };
      });
    let out: { value: T; version: number; contentHash: string };
    try {
      out = await attempt();
    } catch (err) {
      // A duplicate entity name (the (workspace, name) unique index) is a real conflict,
      // NOT the retryable version-PK race — retrying would just conflict again → a 500.
      if (isEntityNameConflict(err)) throw new DuplicateEntityError();
      // A concurrent apply/edit took our version number (config_version PK): the whole tx
      // rolled back, so one retry re-reads the head and re-runs the mutation cleanly.
      if (!isUniqueViolation(err)) throw err;
      out = await attempt();
    }
    await this.deps.hydrate();
    if (this.deps.notifier) {
      try {
        await this.deps.notifier.emit({
          v: out.version,
          hash: out.contentHash,
          origin: this.deps.originId,
          ts: Date.now(),
        });
      } catch {
        /* best-effort broadcast; the durable version is the source of truth */
      }
    }
    return out;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** A 23505 on a `<table>_workspace_name_idx` unique index = a duplicate entity name
 *  (concurrent create, or a GitOps doc with two same-named entries) — distinct from the
 *  retryable config_version PK race. */
function isEntityNameConflict(err: unknown): boolean {
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
  const c = e?.constraint_name ?? e?.cause?.constraint_name;
  return isUniqueViolation(err) && typeof c === 'string' && c.endsWith('_workspace_name_idx');
}

/** A duplicate config-entity name within a workspace; the route maps it to 409. */
export class DuplicateEntityError extends Error {
  constructor() {
    super('an entity with this name already exists in this workspace');
    this.name = 'DuplicateEntityError';
  }
}

export interface ConsoleWriteArgs<T> {
  perm: Permission;
  at: ScopeRef;
  action: string;
  target: string;
  diff: Record<string, unknown>;
  /** The in-memory mutation (no-DB mode, and the only path before this cycle). */
  memory: () => T | Promise<T>;
  /** The durable mutation (DB mode); absent ⇒ the in-memory path is used even with a DB. */
  durable?: (backend: PostgresConfigBackend) => Promise<T>;
}

/**
 * Permission-check → mutate → audit, choosing the durable commit (DB mode) or the
 * in-memory auditedWrite. Routes stay backend-agnostic.
 */
export async function consoleWrite<T>(
  ctx: ControlContext,
  admin: AdminPrincipal,
  args: ConsoleWriteArgs<T>,
): Promise<{ ok: true; value: T; version?: number } | { ok: false; conflict?: string }> {
  if (!ctx.durableConfig || !args.durable) {
    return auditedWrite(ctx, admin, {
      perm: args.perm,
      at: args.at,
      action: args.action,
      target: args.target,
      diff: args.diff,
      mutate: args.memory,
    });
  }
  if (!(await ctx.access.can(admin, args.perm, args.at))) return { ok: false };
  try {
    const r = await ctx.durableConfig.commit(admin, {
      action: args.action,
      target: args.target,
      orgId: args.at.orgId ?? null,
      diff: args.diff,
      run: args.durable,
    });
    return { ok: true, value: r.value, version: r.version };
  } catch (err) {
    // A duplicate entity name is a 409, not a 500: the (workspace, name) unique index is
    // the durable backstop for the TOCTOU race the in-memory nameTaken check can't close.
    if (err instanceof DuplicateEntityError) return { ok: false, conflict: err.message };
    throw err;
  }
}
