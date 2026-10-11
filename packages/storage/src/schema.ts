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
    // Per-key authz scope, enforced by the gateway on the RESOLVED provider/model:
    // NULL = unrestricted (`*`), a JSON string array = the allow-list. The data-plane
    // key store hard-coded `*` before these columns existed, so per-key scoping was
    // silently impossible in production.
    allowedProviders: jsonb('allowed_providers'),
    allowedModels: jsonb('allowed_models'),
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
    // Every rollup (chargeback, ledger totals, boot-time budget heal) filters by
    // workspace AND time; the composite keeps them an index range scan as the ledger grows.
    index('spend_ledger_ws_created_idx').on(t.workspaceId, t.createdAt),
    // Idempotency + dispute lookup: one ledger row per request id (cascade legs carry
    // their own `<id>#<leg>` ids). PostgresLedger.record is ON CONFLICT DO NOTHING.
    uniqueIndex('spend_ledger_request_idx').on(t.requestId),
  ],
);

// Session kill switch (K5 FinOps). A row blocks one agent session (the `session`
// attribution tag — Claude Code's x-claude-code-session-id, or the operator's own
// mapped header) in one workspace: the gateway refuses the session's requests with
// 403 `session_blocked` while a non-expired row exists. Written by the runaway-session
// detector (`source = 'runaway'`, TTL-bounded) or an operator (`source = 'manual'`).
// The gateway reads a periodic snapshot (SessionBlockSnapshot), never per request.
export const sessionBlock = pgTable(
  'session_block',
  {
    workspaceId: uuid('workspace_id').notNull(),
    session: text('session').notNull(),
    reason: text('reason').notNull(),
    source: text('source').notNull(), // 'runaway' | 'manual' (CHECK in migration 0029)
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.session] }),
    index('session_block_expires_idx').on(t.expiresAt),
  ],
);

// Per-request operational log. High write volume — bounded today by a batched
// retention DELETE on created_at (REQUEST_LOG_RETENTION_DAYS, see retention.ts); a
// later milestone time-partitions this and drops old partitions instead.
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
    // Data-residency region the upstream served from (null = unknown / not stamped).
    // First-class column so residency can be filtered/rolled-up in compliance queries.
    servedRegion: text('served_region'),
    // Open, low-cardinality facet bag (cache status, guardrail action, tags…).
    attributes: jsonb('attributes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('request_log_workspace_idx').on(t.workspaceId),
    index('request_log_created_idx').on(t.createdAt),
    // Keyset pagination + workspace-scoped browse: (workspace, created desc, id).
    index('request_log_ws_created_idx').on(t.workspaceId, t.createdAt),
    // Request detail lookup (`WHERE request_id = $1 ORDER BY created_at DESC`) —
    // without it every console "open request" click seq-scanned the biggest table.
    index('request_log_request_id_idx').on(t.requestId, t.createdAt),
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
    // The conversation the request belonged to (K2 conversation-stable masking):
    // a bounded printable id (`session:…` / `conv:…` / `fp:…` / `principal:…`).
    conversationId: text('conversation_id'),
    ciphertext: jsonb('ciphertext').notNull(), // EnvelopeCiphertext (encrypted-at-rest)
    tokenCount: integer('token_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.requestId, t.direction] }),
    index('mask_vault_workspace_idx').on(t.workspaceId),
    index('mask_vault_expires_idx').on(t.expiresAt),
    index('mask_vault_conversation_idx').on(t.conversationId),
  ],
);

// Per-subject crypto-shred keys. Each subject's data-encryption key is held WRAPPED by
// the deployment master (BYOK) in `wrapped_key`; a crypto-shred NULLs it (destroying the
// key) so every ciphertext under that subject becomes permanently unreadable, with
// `shredded_at` recording the erasure. A NULL wrapped_key = shredded/absent.
export const subjectKey = pgTable('subject_key', {
  subject: text('subject').primaryKey(),
  wrappedKey: jsonb('wrapped_key'), // EnvelopeCiphertext of the raw key; NULL once shredded
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  shreddedAt: timestamp('shredded_at', { withTimezone: true }),
});

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
// the in-memory '*' sentinel is never persisted here. org_id / workspace_id are
// plain scope IDENTIFIERS (matched by RBAC), NOT foreign keys: the admin org/
// workspace directory is in-memory in v1 while these rows are durable, so an FK to
// the Postgres org/workspace tables would reject a grant for an admin-created scope.
// The user_id FK stays — deprovisioning a user must cascade its grants.
export const membership = pgTable(
  'membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUser.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    orgId: uuid('org_id'),
    workspaceId: uuid('workspace_id'),
  },
  (t) => [index('membership_user_idx').on(t.userId)],
);

// Role catalogue (P11 custom roles). A row per role id; the five built-ins are
// seeded by migration 0028 with builtin=true and are immutable through the API (the
// permission engine resolves a built-in from code, so a hand-edited builtin row never
// changes what `owner` can do). `permissions` is a JSON array of permission names
// validated against @gulley/rbac's ALL_PERMISSIONS on write. org_id is carried for a
// future per-org catalogue; v1 roles are platform-wide (NULL).
export const role = pgTable('role', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  permissions: jsonb('permissions').$type<string[]>().notNull(),
  builtin: boolean('builtin').notNull().default(false),
  orgId: uuid('org_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// SCIM 2.0 Groups: an IdP-provisioned group. Its displayName maps (via
// SCIM_GROUP_ROLE_MAP) to a role, and each member gets that role granted as a
// `membership` row — so an Entra Enterprise-App group assignment provisions RBAC.
export const scimGroup = pgTable(
  'scim_group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('scim_group_display_idx').on(t.displayName)],
);

// A member of a SCIM group, and the membership row that member's role grant produced
// (so removing the member revokes exactly that grant).
export const scimGroupMember = pgTable(
  'scim_group_member',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => scimGroup.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUser.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id'),
  },
  (t) => [uniqueIndex('scim_group_member_idx').on(t.groupId, t.userId)],
);

// Server-side admin sessions — the revocation record for a gses_ token.
export const adminSession = pgTable(
  'admin_session',
  {
    jti: uuid('jti').primaryKey(),
    tokenHash: text('token_hash').notNull().default(''),
    subject: text('subject').notNull(),
    // How the session was minted: 'exchange' | 'oidc' | 'saml' | 'break-glass' (console list).
    source: text('source').notNull().default('exchange'),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('admin_session_hash_idx').on(t.tokenHash),
    // Deprovision revokes by subject; the console lists newest-first.
    index('admin_session_subject_idx').on(t.subject),
    index('admin_session_created_idx').on(t.createdAt),
  ],
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
    // Data-residency stamp so DB-config-mode routes can satisfy an active residency/ZDR
    // policy (the env path stamps these from ANTHROPIC_REGION/ZDR etc.). Null region + a
    // false zdr fail CLOSED under an active policy, matching the env behavior.
    region: text('region'),
    zdr: boolean('zdr').notNull().default(false),
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
  // Unique per (workspace, name): the name is the GitOps reconcile key, so a duplicate
  // would make export/apply ambiguous. workspace_id leads, so this also serves the
  // workspace-scoped list query. (An in-memory TOCTOU check alone let a concurrent
  // create — or a GitOps doc with two same-named entries — persist duplicate rows.)
  (t) => [uniqueIndex('route_workspace_name_idx').on(t.workspaceId, t.name)],
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
  (t) => [uniqueIndex('route_policy_workspace_name_idx').on(t.workspaceId, t.name)],
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
  (t) => [uniqueIndex('model_alias_workspace_name_idx').on(t.workspaceId, t.name)],
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
  (t) => [uniqueIndex('smart_routing_policy_workspace_name_idx').on(t.workspaceId, t.name)],
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
  (t) => [uniqueIndex('rate_limit_workspace_name_idx').on(t.workspaceId, t.name)],
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
  (t) => [uniqueIndex('guardrail_workspace_name_idx').on(t.workspaceId, t.name)],
);

// Spend caps (micro-USD) — hierarchical since 0.7 (K4). One row caps ONE entity:
//   scope_kind='workspace' (the pre-0.7 row; scope_id = the workspace id),
//   scope_kind='org' (workspace_id NULL; scope_id = the org id),
//   scope_kind in key|user|team|project within a workspace (scope_id = the entity id,
//   or '*' for the DEFAULT covering every entity of that kind without its own row).
// `windows` is the multi-window spec [{capMicroUsd, period}] (period: none | daily |
// weekly | monthly | {seconds}); NULL means the legacy single cap in cap_micro_usd /
// period_seconds (a fixed window from first spend; null period = lifetime).
export const budget = pgTable(
  'budget',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    // Config-document entity name. Carried so a GitOps round-trip preserves the
    // authored name.
    name: text('name').notNull().default('default'),
    scopeKind: text('scope_kind').notNull().default('workspace'),
    scopeId: text('scope_id').notNull(),
    capMicroUsd: bigint('cap_micro_usd', { mode: 'number' }).notNull(),
    periodSeconds: integer('period_seconds'),
    windows: jsonb('windows'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('budget_scope_idx')
      .on(t.workspaceId, t.scopeKind, t.scopeId)
      .where(sql`${t.workspaceId} is not null`),
    uniqueIndex('budget_org_scope_idx')
      .on(t.scopeKind, t.scopeId)
      .where(sql`${t.workspaceId} is null`),
  ],
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
    // Workload identity federation (migration 0030): 'user' (consented device /
    // auth-code family) or 'service' (RFC 7523 JWT-bearer exchange — access-only).
    kind: text('kind').notNull().default('user'),
    // Service grants: the federation (trust configuration) + the verified assertion sub.
    federation: text('federation'),
    subject: text('subject'),
    // Stored data-plane scope ({ allowedProviders, allowedModels, groups? }); null on
    // user grants (resolved as '*').
    scope: jsonb('scope'),
    // Service grants: may this principal assert an end user via x-user-id?
    onBehalfOf: boolean('on_behalf_of').notNull().default(false),
  },
  (t) => [
    index('oauth_grant_client_idx').on(t.clientId),
    index('oauth_grant_created_idx').on(t.createdAt),
    // Backs revoke-by-principal (SCIM deprovision) and the expired-grant sweep.
    index('oauth_grant_principal_idx').on(t.principalId),
    index('oauth_grant_absolute_expires_idx').on(t.absoluteExpiresAt),
  ],
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
  (t) => [
    uniqueIndex('device_code_user_idx').on(t.userCode),
    // Backs the expiry sweep (purgeExpiredOAuthCodes).
    index('device_code_expires_idx').on(t.expiresAt),
  ],
);

export const authCode = pgTable(
  'auth_code',
  {
    code: text('code').primaryKey(),
    clientId: text('client_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    principalId: text('principal_id').notNull(),
    displayName: text('display_name').notNull(),
    orgId: uuid('org_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('auth_code_expires_idx').on(t.expiresAt)],
);

// --- Governed prompt registry (durable) --------------------------------------
// A named, workspace-scoped template and its append-only, per-template hash-chained
// versions. The chain (hash over prev_hash + body/variables/author/timestamp/message)
// is verified by @gulley/prompts' verifyChain; rows are never updated in place.

export const promptTemplate = pgTable(
  'prompt_template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('prompt_template_ws_name_idx').on(t.workspaceId, t.name)],
);

export const promptVersion = pgTable(
  'prompt_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => promptTemplate.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    variables: jsonb('variables')
      .notNull()
      .default(sql`'[]'::jsonb`),
    hash: text('hash').notNull(),
    prevHash: text('prev_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    message: text('message'),
  },
  (t) => [uniqueIndex('prompt_version_template_version_idx').on(t.templateId, t.version)],
);

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
