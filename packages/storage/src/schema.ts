import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// The org/workspace/project spine. Single-tenant today; these boundaries are
// carried now so a future multi-tenant mode is config, not a migration.

export const org = pgTable('org', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspace = pgTable(
  'workspace',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('workspace_org_idx').on(t.orgId)],
);

export const project = pgTable(
  'project',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_workspace_idx').on(t.workspaceId)],
);

// Virtual keys: only the HMAC of the secret is stored (pepper lives in KMS).
// Never the secret itself. `epoch` enables sub-second revocation via Redis
// pub/sub invalidation rather than waiting out a TTL.
export const virtualKey = pgTable(
  'virtual_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
    disabled: boolean('disabled').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('virtual_key_prefix_idx').on(t.keyPrefix),
    index('virtual_key_workspace_idx').on(t.workspaceId),
  ],
);

// Append-only, hash-chained audit log. A later migration revokes UPDATE/DELETE
// from the app role and mirrors this stream to S3 Object Lock (WORM) as the
// retained system of record; Postgres stays the queryable projection.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    orgId: uuid('org_id'),
    actor: text('actor'),
    action: text('action').notNull(),
    target: text('target'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    prevHash: text('prev_hash'),
    rowHash: text('row_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('audit_log_seq_idx').on(t.seq)],
);
