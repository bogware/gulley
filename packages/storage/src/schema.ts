import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    // Group/team tags carried onto the principal's scope (per-group config, e.g.
    // smart routing). A lightweight claim/tag list, not a managed entity.
    groups: jsonb('groups')
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    // Cost-breakdown detail (computed on the hot path, previously discarded): the
    // cache-read/write token split and the provider-prompt-cache dollars saved, so
    // chargeback + savings reporting reads the durable ledger rather than the
    // best-effort request_log.
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    cacheSavedMicroUsd: bigint('cache_saved_micro_usd', { mode: 'number' }).notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    priced: boolean('priced').notNull().default(false),
    // Coding-agent / cost-attribution tags (repo, branch, PR, session, developer,
    // subagent, human-vs-agent, cost-center…), captured from configured request
    // headers so spend rolls up to any SDLC dimension for chargeback.
    attributes: jsonb('attributes'),
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
    // Open, low-cardinality facet bag (cache status, guardrail action, tags…).
    attributes: jsonb('attributes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('request_log_workspace_idx').on(t.workspaceId),
    index('request_log_created_idx').on(t.createdAt),
    // Keyset pagination + workspace-scoped browse: (workspace, created desc, id).
    index('request_log_ws_created_idx').on(t.workspaceId, t.createdAt),
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

// Persistent classifier centroids (M16 persistence): the embedded exemplar points
// for `embedding-nearest-label` smart routing. One row per (policy scope, category
// label, embedding model, exemplar). The reconciler loads all rows for the active
// policies once — so a fresh replica reuses these instead of re-embedding every
// exemplar on boot. The canonical embedding is jsonb (a number[]), which works at
// any dimension and is the in-memory (load-all + in-JS cosine) fallback.
//
// `embeddingVec` (M22 C) is the same vector in a pgvector `vector(256)` column, so
// request-time nearest-label can be an indexed ANN query (`PostgresCentroidIndex`)
// instead of an O(N) in-JS scan — the scale win for large exemplar sets. It is
// fixed at 256 dims (matching the semantic tier + the EMBEDDINGS_DIMENSIONS
// default); the ANN path is opt-in and guarded off for other dims. Like the
// semantic tier, the pgvector column + its HNSW cosine index + a backfill are
// hand-written in migration 0012 (drizzle-kit can't emit the HNSW opclass), and
// PGlite (no pgvector) simply skips them.
export const classifierCentroid = pgTable(
  'classifier_centroid',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(),
    label: text('label').notNull(),
    model: text('model').notNull(),
    exemplarSha: text('exemplar_sha').notNull(),
    embedding: jsonb('embedding').$type<number[]>().notNull(),
    embeddingVec: vector('embedding_vec', { dimensions: 256 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('classifier_centroid_uniq').on(t.scope, t.label, t.model, t.exemplarSha),
    index('classifier_centroid_scope_idx').on(t.scope),
    index('classifier_centroid_scope_model_idx').on(t.scope, t.model),
  ],
);

// Durable reversal store for guardrail `mask` (M22 D). When a request masks
// PII/secrets, the reversible token↔original map (TokenVault.entries()) is
// envelope-encrypted (@gulley/crypto, AAD-bound to request+workspace+direction) and
// stored here so an authorized admin can de-tokenize a masked response later. The
// `ciphertext` column holds ONLY the EnvelopeCiphertext — NEVER a plaintext original;
// encrypt/decrypt happen in the app layer, so this adapter never touches cleartext.
// Rows carry a short TTL (`expiresAt`) with an expiry sweep, like the exact cache.
export const maskVault = pgTable(
  'mask_vault',
  {
    requestId: text('request_id').notNull(),
    direction: text('direction').notNull(), // 'input' | 'output'
    workspaceId: uuid('workspace_id').notNull(),
    orgId: uuid('org_id'),
    ciphertext: jsonb('ciphertext').notNull(), // EnvelopeCiphertext (encrypted-at-rest)
    tokenCount: integer('token_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.direction] }),
    index('mask_vault_workspace_idx').on(t.workspaceId),
    index('mask_vault_expires_idx').on(t.expiresAt),
  ],
);

// --- M5.1 control-plane / RBAC ---------------------------------------------

// Admin users (Entra oid, or a bootstrap subject). Distinct from data-plane keys.
export const adminUser = pgTable(
  'admin_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subject: text('subject').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_user_subject_idx').on(t.subject)],
);

// A role granted at a scope. org_id NULL + workspace_id NULL is a platform grant;
// the in-memory '*' sentinel is never persisted here.
export const membership = pgTable(
  'membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUser.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    orgId: uuid('org_id').references(() => org.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
  },
  (t) => [index('membership_user_idx').on(t.userId)],
);

// Server-side admin sessions — the revocation record for a gses_ token.
export const adminSession = pgTable(
  'admin_session',
  {
    jti: uuid('jti').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    subject: text('subject').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('admin_session_hash_idx').on(t.tokenHash)],
);

export const provider = pgTable(
  'provider',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    baseUrl: text('base_url'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('provider_workspace_idx').on(t.workspaceId)],
);

// A reference to a Secrets Manager entry — ARN + version, NEVER the value.
export const providerCredential = pgTable(
  'provider_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => provider.id, { onDelete: 'cascade' }),
    secretArn: text('secret_arn').notNull(),
    secretVersion: text('secret_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('provider_credential_provider_idx').on(t.providerId)],
);

// Workspace-scoped config collections (routes, policies, model aliases, rate
// limits, guardrails). A jsonb `config` keeps the control plane schema-light;
// GitOps (M5.3) serializes these generically.
export const route = pgTable(
  'route',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('route_workspace_idx').on(t.workspaceId)],
);

export const routePolicy = pgTable(
  'route_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('route_policy_workspace_idx').on(t.workspaceId)],
);

export const modelAlias = pgTable(
  'model_alias',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('model_alias_workspace_idx').on(t.workspaceId)],
);

// Smart-routing policies (M15): a name-keyed jsonb collection identical in shape
// to `route`. The `config` holds the classifier spec, category→route map,
// selector, and priority (see @gulley/routing SmartRoutingPolicy).
export const smartRoutingPolicy = pgTable(
  'smart_routing_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('smart_routing_policy_workspace_idx').on(t.workspaceId)],
);

export const rateLimit = pgTable(
  'rate_limit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_limit_workspace_idx').on(t.workspaceId)],
);

export const guardrail = pgTable(
  'guardrail',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('guardrail_workspace_idx').on(t.workspaceId)],
);

// Per-workspace spend cap (micro-USD). period_seconds null = lifetime cap.
export const budget = pgTable(
  'budget',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    // Config-document entity name (singular per workspace; 'default' by convention).
    // Carried so a GitOps round-trip preserves the authored name.
    name: text('name').notNull().default('default'),
    capMicroUsd: bigint('cap_micro_usd', { mode: 'number' }).notNull(),
    periodSeconds: integer('period_seconds'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('budget_workspace_idx').on(t.workspaceId)],
);

// --- M5.2 OAuth broker -----------------------------------------------------

export const oauthClient = pgTable('oauth_client', {
  clientId: text('client_id').primaryKey(),
  name: text('name').notNull(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => org.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  grantTypes: jsonb('grant_types')
    .notNull()
    .default(sql`'[]'::jsonb`),
  redirectAllowlist: jsonb('redirect_allowlist')
    .notNull()
    .default(sql`'[]'::jsonb`),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row per token family. Rotation advances refresh_generation; the previous
// refresh hash is retained so single-step reuse is distinguishable from forgery.
export const oauthGrant = pgTable(
  'oauth_grant',
  {
    handle: text('handle').primaryKey(),
    clientId: text('client_id').notNull(),
    principalId: text('principal_id').notNull(),
    displayName: text('display_name').notNull(),
    orgId: uuid('org_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    status: text('status').notNull(),
    accessTokenHash: text('access_token_hash'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenHash: text('refresh_token_hash'),
    prevRefreshTokenHash: text('prev_refresh_token_hash'),
    refreshGeneration: integer('refresh_generation').notNull().default(0),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_grant_client_idx').on(t.clientId)],
);

export const deviceCode = pgTable(
  'device_code',
  {
    deviceCode: text('device_code').primaryKey(),
    userCode: text('user_code').notNull(),
    clientId: text('client_id').notNull(),
    status: text('status').notNull(),
    principalId: text('principal_id'),
    displayName: text('display_name'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastPolledAt: bigint('last_polled_at', { mode: 'number' }).notNull().default(0),
    intervalMs: integer('interval_ms').notNull().default(5000),
  },
  (t) => [uniqueIndex('device_code_user_idx').on(t.userCode)],
);

export const authCode = pgTable('auth_code', {
  code: text('code').primaryKey(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  principalId: text('principal_id').notNull(),
  displayName: text('display_name').notNull(),
  orgId: uuid('org_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// --- M5.3 config / GitOps --------------------------------------------------

// Append-only version log. content_hash is NON-unique so a revert (re-applying
// earlier content) is allowed. Immutability is enforced in migration 0006.
export const configVersion = pgTable(
  'config_version',
  {
    version: integer('version').primaryKey(),
    contentHash: text('content_hash').notNull(),
    yaml: text('yaml').notNull(),
    actor: text('actor').notNull(),
    summary: jsonb('summary')
      .notNull()
      .default(sql`'{}'::jsonb`),
    auditSeq: bigint('audit_seq', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('config_version_hash_idx').on(t.contentHash)],
);
