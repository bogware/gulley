import {
  type ChainVerification,
  type CreatePromptArgs,
  nextVersion,
  PromptNameConflictError,
  type PromptRegistry,
  type PromptSummary,
  type PromptTemplate,
  type PromptVersion,
  summarizeTemplate,
  verifyChain,
} from '@gulley/prompts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './db';
import { promptTemplate, promptVersion } from './schema';

/**
 * Durable governed prompt registry. Templates are workspace-scoped and name-unique;
 * versions are append-only rows whose hash chains to the previous head (computed by
 * @gulley/prompts' `nextVersion`, verified by `verifyChain`). A new version is
 * appended inside a transaction that re-reads the head under `FOR UPDATE` on the
 * template row, so two concurrent appends cannot both chain to the same prev hash
 * (the (template, version) unique index is the backstop).
 */
export class PostgresPromptRegistry implements PromptRegistry {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private mapVersion(r: typeof promptVersion.$inferSelect): PromptVersion {
    return {
      version: r.version,
      body: r.body,
      variables: (r.variables as string[]) ?? [],
      hash: r.hash,
      prevHash: r.prevHash,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      ...(r.message != null ? { message: r.message } : {}),
    };
  }

  private async versionsOf(templateId: string, db: Database = this.db): Promise<PromptVersion[]> {
    const rows = await db
      .select()
      .from(promptVersion)
      .where(eq(promptVersion.templateId, templateId))
      .orderBy(asc(promptVersion.version));
    return rows.map((r) => this.mapVersion(r));
  }

  private async insertVersion(
    db: Database,
    templateId: string,
    prev: PromptVersion | undefined,
    args: CreatePromptArgs,
  ): Promise<PromptVersion> {
    const v = nextVersion(prev, args, this.now);
    await db.insert(promptVersion).values({
      templateId,
      version: v.version,
      body: v.body,
      variables: v.variables,
      hash: v.hash,
      prevHash: v.prevHash,
      createdAt: new Date(v.createdAt),
      createdBy: v.createdBy,
      message: v.message ?? null,
    });
    return v;
  }

  async create(workspaceId: string, name: string, args: CreatePromptArgs): Promise<PromptTemplate> {
    return this.db.transaction(async (tx) => {
      const h = tx as unknown as Database;
      const [existing] = await h
        .select({ id: promptTemplate.id })
        .from(promptTemplate)
        .where(and(eq(promptTemplate.workspaceId, workspaceId), eq(promptTemplate.name, name)))
        .limit(1);
      if (existing) throw new PromptNameConflictError(name);
      const [t] = await h
        .insert(promptTemplate)
        .values({ workspaceId, name })
        .returning({ id: promptTemplate.id });
      const v = await this.insertVersion(h, t!.id, undefined, args);
      return { id: t!.id, workspaceId, name, versions: [v] };
    });
  }

  async addVersion(id: string, args: CreatePromptArgs): Promise<PromptVersion | undefined> {
    return this.db.transaction(async (tx) => {
      const h = tx as unknown as Database;
      // Serialize appends per template: lock the template row, then read the head.
      const locked = await h.execute(
        sql`select id from ${promptTemplate} where id = ${id} for update`,
      );
      const rows = Array.isArray(locked) ? locked : ((locked as { rows?: unknown[] }).rows ?? []);
      if (rows.length === 0) return undefined;
      const [headRow] = await h
        .select()
        .from(promptVersion)
        .where(eq(promptVersion.templateId, id))
        .orderBy(desc(promptVersion.version))
        .limit(1);
      const prev = headRow ? this.mapVersion(headRow) : undefined;
      return this.insertVersion(h, id, prev, args);
    });
  }

  async get(id: string): Promise<PromptTemplate | undefined> {
    const [t] = await this.db.select().from(promptTemplate).where(eq(promptTemplate.id, id));
    if (!t) return undefined;
    return {
      id: t.id,
      workspaceId: t.workspaceId,
      name: t.name,
      versions: await this.versionsOf(id),
    };
  }

  async getByName(workspaceId: string, name: string): Promise<PromptTemplate | undefined> {
    const [t] = await this.db
      .select()
      .from(promptTemplate)
      .where(and(eq(promptTemplate.workspaceId, workspaceId), eq(promptTemplate.name, name)))
      .limit(1);
    if (!t) return undefined;
    return {
      id: t.id,
      workspaceId: t.workspaceId,
      name: t.name,
      versions: await this.versionsOf(t.id),
    };
  }

  async head(id: string): Promise<PromptVersion | undefined> {
    const [r] = await this.db
      .select()
      .from(promptVersion)
      .where(eq(promptVersion.templateId, id))
      .orderBy(desc(promptVersion.version))
      .limit(1);
    return r ? this.mapVersion(r) : undefined;
  }

  async version(id: string, version: number): Promise<PromptVersion | undefined> {
    const [r] = await this.db
      .select()
      .from(promptVersion)
      .where(and(eq(promptVersion.templateId, id), eq(promptVersion.version, version)))
      .limit(1);
    return r ? this.mapVersion(r) : undefined;
  }

  /** Secret-free summaries: one query for the templates, one for their heads. */
  async list(workspaceIds: readonly string[] | '*'): Promise<PromptSummary[]> {
    if (workspaceIds !== '*' && workspaceIds.length === 0) return [];
    const templates =
      workspaceIds === '*'
        ? await this.db.select().from(promptTemplate).orderBy(asc(promptTemplate.name))
        : await this.db
            .select()
            .from(promptTemplate)
            .where(inArray(promptTemplate.workspaceId, [...workspaceIds]))
            .orderBy(asc(promptTemplate.name));
    if (templates.length === 0) return [];
    const heads = await this.db
      .select()
      .from(promptVersion)
      .where(
        inArray(
          promptVersion.templateId,
          templates.map((t) => t.id),
        ),
      )
      .orderBy(asc(promptVersion.templateId), desc(promptVersion.version));
    const headByTemplate = new Map<string, PromptVersion>();
    for (const h of heads)
      if (!headByTemplate.has(h.templateId)) headByTemplate.set(h.templateId, this.mapVersion(h));
    return templates.map((t) => {
      const head = headByTemplate.get(t.id);
      return summarizeTemplate({
        id: t.id,
        workspaceId: t.workspaceId,
        name: t.name,
        versions: head ? [head] : [],
      });
    });
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(promptTemplate)
      .where(eq(promptTemplate.id, id))
      .returning({ id: promptTemplate.id });
    return rows.length > 0;
  }

  async verifyChain(id: string): Promise<ChainVerification | undefined> {
    const [t] = await this.db
      .select({ id: promptTemplate.id })
      .from(promptTemplate)
      .where(eq(promptTemplate.id, id));
    if (!t) return undefined;
    return verifyChain(await this.versionsOf(id));
  }
}
