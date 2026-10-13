import { asc, eq } from 'drizzle-orm';
import type { Database } from './db';
import { role } from './schema';

/** A role row as the control plane sees it. `permissions` are permission names;
 *  the storage layer does not know the @gulley/rbac union — callers validate. */
export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  builtin: boolean;
  orgId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleWrite {
  name: string;
  description?: string | null;
  permissions: readonly string[];
}

/** Thrown when a built-in role is updated or deleted; the API maps it to a 409. */
export class BuiltinRoleError extends Error {
  constructor(readonly roleId: string) {
    super(`role "${roleId}" is built-in and immutable`);
    this.name = 'BuiltinRoleError';
  }
}

/**
 * Durable role catalogue. Built-ins (seeded by migration 0028) are immutable here:
 * `update`/`delete` refuse them with {@link BuiltinRoleError}, and `ensureBuiltins`
 * keeps their stored name/description/permissions in step with the code definitions
 * at boot (the migration seed is only the initial state).
 */
export class PostgresRoleStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<RoleRow[]> {
    const rows = await this.db.select().from(role).orderBy(asc(role.builtin), asc(role.id));
    return rows.map((r) => this.view(r));
  }

  async get(id: string): Promise<RoleRow | undefined> {
    const [r] = await this.db.select().from(role).where(eq(role.id, id)).limit(1);
    return r ? this.view(r) : undefined;
  }

  /** Insert a custom role. A duplicate id surfaces as the driver's unique-violation. */
  async create(id: string, input: RoleWrite): Promise<RoleRow> {
    const [r] = await this.db
      .insert(role)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        permissions: [...input.permissions],
        builtin: false,
        orgId: null,
      })
      .returning();
    return this.view(r!);
  }

  /** Update a custom role; undefined when it does not exist. */
  async update(id: string, patch: Partial<RoleWrite>): Promise<RoleRow | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    if (existing.builtin) throw new BuiltinRoleError(id);
    const [r] = await this.db
      .update(role)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.permissions !== undefined ? { permissions: [...patch.permissions] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(role.id, id))
      .returning();
    return r ? this.view(r) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    if (existing.builtin) throw new BuiltinRoleError(id);
    const rows = await this.db.delete(role).where(eq(role.id, id)).returning({ id: role.id });
    return rows.length > 0;
  }

  /** Upsert the built-in definitions (id, name, description, permissions) so the
   *  stored catalogue mirrors the code's — idempotent, run at boot. */
  async ensureBuiltins(
    defs: readonly {
      id: string;
      name: string;
      description?: string;
      permissions: readonly string[];
    }[],
  ): Promise<void> {
    for (const d of defs) {
      await this.db
        .insert(role)
        .values({
          id: d.id,
          name: d.name,
          description: d.description ?? null,
          permissions: [...d.permissions],
          builtin: true,
          orgId: null,
        })
        .onConflictDoUpdate({
          target: role.id,
          set: {
            name: d.name,
            description: d.description ?? null,
            permissions: [...d.permissions],
            builtin: true,
            updatedAt: new Date(),
          },
        });
    }
  }

  private view(r: typeof role.$inferSelect): RoleRow {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: Array.isArray(r.permissions)
        ? r.permissions.filter((p) => typeof p === 'string')
        : [],
      builtin: r.builtin,
      orgId: r.orgId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
