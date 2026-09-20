import { and, eq } from 'drizzle-orm';
import type { Database } from './db';
import { membership, scimGroup, scimGroupMember } from './schema';

export interface ScimGroupRow {
  id: string;
  externalId: string | null;
  displayName: string;
  members: string[]; // admin_user ids
}

/** Maps a provisioned group's displayName to the role it grants, or null when the
 *  group is not mapped (members are tracked but granted nothing). orgId null = a
 *  platform-wide grant (the membership loader reads NULL org as '*'). */
export type GroupRoleResolver = (
  displayName: string,
) => { role: string; orgId: string | null } | null;

/**
 * Durable SCIM 2.0 Groups. A group's members each receive the role its displayName
 * maps to (as a `membership` row), so an Entra Enterprise-App group assignment
 * provisions RBAC; removing a member — or deleting the group — revokes exactly the
 * membership rows those grants produced.
 */
export class PostgresScimGroupStore {
  constructor(
    private readonly db: Database,
    private readonly roleFor: GroupRoleResolver,
  ) {}

  async create(displayName: string, externalId?: string | null): Promise<ScimGroupRow> {
    const [row] = await this.db
      .insert(scimGroup)
      .values({ displayName, externalId: externalId ?? null })
      .returning();
    return { id: row!.id, externalId: row!.externalId, displayName: row!.displayName, members: [] };
  }

  async get(id: string): Promise<ScimGroupRow | undefined> {
    const [g] = await this.db.select().from(scimGroup).where(eq(scimGroup.id, id)).limit(1);
    if (!g) return undefined;
    const members = await this.db
      .select({ userId: scimGroupMember.userId })
      .from(scimGroupMember)
      .where(eq(scimGroupMember.groupId, id));
    return {
      id: g.id,
      externalId: g.externalId,
      displayName: g.displayName,
      members: members.map((m) => m.userId),
    };
  }

  async list(): Promise<ScimGroupRow[]> {
    const groups = await this.db.select().from(scimGroup);
    const out: ScimGroupRow[] = [];
    for (const g of groups) {
      const members = await this.db
        .select({ userId: scimGroupMember.userId })
        .from(scimGroupMember)
        .where(eq(scimGroupMember.groupId, g.id));
      out.push({
        id: g.id,
        externalId: g.externalId,
        displayName: g.displayName,
        members: members.map((m) => m.userId),
      });
    }
    return out;
  }

  /** Grant the group's role to a user (idempotent) and track the membership row.
   *  One transaction, with the membership link claimed FIRST via the unique
   *  (group, user) index: an IdP that retries a PATCH-add (routine on a 5xx/timeout)
   *  previously passed the "already a member" read on both calls and left a second,
   *  unlinked `membership` grant that no later SCIM removal could ever revoke. */
  async addMember(groupId: string, userId: string, displayName: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const claimed = await tx
        .insert(scimGroupMember)
        .values({ groupId, userId, membershipId: null })
        .onConflictDoNothing()
        .returning({ userId: scimGroupMember.userId });
      if (claimed.length === 0) return; // already a member — no duplicate grant
      const mapped = this.roleFor(displayName);
      if (!mapped) return;
      const [m] = await tx
        .insert(membership)
        .values({ userId, role: mapped.role, orgId: mapped.orgId, workspaceId: null })
        .returning({ id: membership.id });
      await tx
        .update(scimGroupMember)
        .set({ membershipId: m!.id })
        .where(and(eq(scimGroupMember.groupId, groupId), eq(scimGroupMember.userId, userId)));
    });
  }

  /** Remove a user from the group and revoke exactly the membership its grant
   *  produced — atomically, so a crash between the two deletes cannot orphan a grant. */
  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(scimGroupMember)
        .where(and(eq(scimGroupMember.groupId, groupId), eq(scimGroupMember.userId, userId)))
        .returning({ membershipId: scimGroupMember.membershipId });
      const mid = rows[0]?.membershipId;
      if (mid) await tx.delete(membership).where(eq(membership.id, mid));
    });
  }

  /** Delete the group, revoking every membership its grants produced first (one tx). */
  async delete(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const members = await tx
        .select({ membershipId: scimGroupMember.membershipId })
        .from(scimGroupMember)
        .where(eq(scimGroupMember.groupId, id));
      for (const m of members) {
        if (m.membershipId) await tx.delete(membership).where(eq(membership.id, m.membershipId));
      }
      const rows = await tx
        .delete(scimGroup)
        .where(eq(scimGroup.id, id))
        .returning({ id: scimGroup.id });
      return rows.length > 0;
    });
  }
}
