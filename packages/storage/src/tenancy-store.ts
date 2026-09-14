import { eq } from 'drizzle-orm';

import type { Database } from './db';
import { org, workspace } from './schema';

/**
 * Durable tenancy registry (org + workspace rows) for the control plane's in-memory
 * OrgStore / WorkspaceStore. Those registries stay the synchronous read model every
 * admin route and RBAC scope check reads; in DB mode they are HYDRATED from these
 * rows at boot (and after a config apply) and every create/delete is WRITTEN THROUGH
 * here first — so a workspace created in the console exists in Postgres before a
 * virtual key or an OAuth client references it by foreign key, and it is still there
 * after a restart. (Previously the registries were process-local only: in a DB
 * deployment a restart emptied the console's workspace list and key minting failed on
 * `virtual_key_workspace_id_fk`.)
 */
export interface TenancyOrgRow {
  id: string;
  name: string;
  createdAt: Date;
}

export interface TenancyWorkspaceRow {
  id: string;
  orgId: string;
  name: string;
  createdAt: Date;
}

export class PostgresTenancyStore {
  constructor(private readonly db: Database) {}

  async listOrgs(): Promise<TenancyOrgRow[]> {
    return this.db.select({ id: org.id, name: org.name, createdAt: org.createdAt }).from(org);
  }

  async listWorkspaces(): Promise<TenancyWorkspaceRow[]> {
    return this.db
      .select({
        id: workspace.id,
        orgId: workspace.orgId,
        name: workspace.name,
        createdAt: workspace.createdAt,
      })
      .from(workspace);
  }

  /** Insert with the caller-generated id so the in-memory row and the durable row
   *  are the same identity. Idempotent on a repeated insert of the same id. */
  async insertOrg(row: TenancyOrgRow): Promise<void> {
    await this.db
      .insert(org)
      .values({ id: row.id, name: row.name, createdAt: row.createdAt })
      .onConflictDoNothing({ target: org.id });
  }

  async insertWorkspace(row: TenancyWorkspaceRow): Promise<void> {
    await this.db
      .insert(workspace)
      .values({ id: row.id, orgId: row.orgId, name: row.name, createdAt: row.createdAt })
      .onConflictDoNothing({ target: workspace.id });
  }

  /** Cascades to the org's workspaces (and, via their FKs, keys/clients/…). */
  async deleteOrg(id: string): Promise<boolean> {
    const rows = await this.db.delete(org).where(eq(org.id, id)).returning({ id: org.id });
    return rows.length > 0;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(workspace)
      .where(eq(workspace.id, id))
      .returning({ id: workspace.id });
    return rows.length > 0;
  }
}
