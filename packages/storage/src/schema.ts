import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
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

// Durable spend ledger — the source of truth for cost. Redis budget counters
// are a rebuildable projection of this table (never the reverse).
export const spendLedger = pgTable(
  'spend_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: text('request_id').notNull(),
    principalId: text('principal_id').notNull(),
    orgId: uuid('org_id'),
    workspaceId: uuid('workspace_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    priced: boolean('priced').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('spend_ledger_workspace_idx').on(t.workspaceId),
    index('spend_ledger_created_idx').on(t.createdAt),
  ],
);

// Per-request operational log. High write volume — a later milestone
// time-partitions this and drops old partitions rather than DELETE-ing.
export const requestLog = pgTable(
  'request_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: text('request_id').notNull(),
    principalId: text('principal_id').notNull(),
    workspaceId: uuid('workspace_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    route: text('route').notNull(),
    statusCode: integer('status_code').notNull(),
    status: text('status').notNull(),
    streamed: boolean('streamed').notNull().default(false),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('request_log_workspace_idx').on(t.workspaceId),
    index('request_log_created_idx').on(t.createdAt),
  ],
);

// Two-tier response cache. `cache_entry` is the exact tier — the full response
// bytes, replayed verbatim on a key hit. Body is base64 text so binary SSE
// survives the round-trip. Scope is carried for partition-scoped eviction.
export const cacheEntry = pgTable(
  'cache_entry',
  {
    key: text('key').primaryKey(),
    scope: text('scope').notNull(),
    provider: text('provider').notNull().default(''),
    model: text('model').notNull(),
    statusCode: integer('status_code').notNull(),
    streamed: boolean('streamed').notNull().default(false),
    headers: jsonb('headers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    body: text('body').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cache_entry_scope_idx').on(t.scope),
    index('cache_entry_expires_idx').on(t.expiresAt),
  ],
);

// Semantic tier: the embedding of a cached request. Primary key equals the
// exact-cache key, so a nearest-neighbor match resolves straight to a
// cache_entry. Requires pgvector — migration 0003 adds `CREATE EXTENSION vector`
// and an HNSW cosine index (which drizzle-kit cannot emit on its own).
export const semanticVector = pgTable(
  'semantic_vector',
  {
    key: text('key')
      .primaryKey()
      .references(() => cacheEntry.key, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    embedding: vector('embedding', { dimensions: 256 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('semantic_vector_scope_idx').on(t.scope)],
);

// Per-workspace spend cap (micro-USD). period_seconds null = lifetime cap.
export const budget = pgTable(
  'budget',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    capMicroUsd: bigint('cap_micro_usd', { mode: 'number' }).notNull(),
    periodSeconds: integer('period_seconds'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('budget_workspace_idx').on(t.workspaceId)],
);
