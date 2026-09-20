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
      // A concurrent apply/edit took our version number (PK): the whole tx rolled back,
      // so one retry re-reads the head and re-runs the mutation cleanly.
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
): Promise<{ ok: true; value: T; version?: number } | { ok: false }> {
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
  const r = await ctx.durableConfig.commit(admin, {
    action: args.action,
    target: args.target,
    orgId: args.at.orgId ?? null,
    diff: args.diff,
    run: args.durable,
  });
  return { ok: true, value: r.value, version: r.version };
}
