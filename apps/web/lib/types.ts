/**
 * DTOs for the Gulley admin console, mirroring the control-api responses this UI
 * consumes. Kept as a hand-authored mirror (not a shared package import) so the
 * web app stays a thin, independently buildable client.
 */

export type RequestStatus = 'ok' | 'error' | 'aborted';

export interface RequestLog {
  id: string;
  requestId: string;
  principalId: string;
  workspaceId: string;
  provider: string;
  model: string;
  route: string;
  statusCode: number;
  status: RequestStatus;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  createdAt: string;
  attributes?: Record<string, unknown>;
}

export interface LogPage {
  entries: RequestLog[];
  nextCursor?: string;
}

export interface LogFilter {
  workspaceId?: string;
  provider?: string;
  model?: string;
  status?: RequestStatus;
  minStatusCode?: number;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export type UsageBucketWidth = 'minute' | 'hour' | 'day';

export interface UsageBucket {
  bucketStart: string;
  group?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export interface UsageQuery {
  workspaceId?: string;
  from?: string;
  to?: string;
  bucket?: UsageBucketWidth;
  groupBy?: 'provider' | 'model' | 'workspace';
}

export interface Org {
  id: string;
  name: string;
}
export interface Workspace {
  id: string;
  orgId: string;
  name: string;
}
export interface VirtualKeyView {
  id: string;
  keyPrefix: string;
  workspaceId: string;
  displayName: string;
  disabled: boolean;
}
export interface Provider {
  id: string;
  workspaceId: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
}

export interface CollectionEntity {
  id: string;
  workspaceId: string;
  name: string;
  config: Record<string, unknown>;
}

/** The workspace-scoped config collections exposed by the control-api. */
export type CollectionKind =
  'budgets' | 'rate-limits' | 'guardrails' | 'routes' | 'policies' | 'model-aliases';

/* ------------------------------------------------------------ parity DTOs */

export interface AdminStatus {
  version: string;
  durable: boolean;
  subsystems: Record<string, boolean>;
}

export interface AuditEvent {
  seq: number;
  orgId: string | null;
  actor: string;
  action: string;
  target: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

// --- config (GitOps) ---
export interface ConfigVersion {
  version: number;
  contentHash: string;
  actor: string;
  summary: unknown;
  createdAt: string;
}
export interface DriftReport {
  drifted: boolean;
  [k: string]: unknown;
}

// --- prompts ---
export interface PromptVersion {
  version: number;
  hash: string;
  prevHash: string | null;
  variables: string[];
  body?: string;
}
export interface PromptTemplate {
  id: string;
  workspaceId: string;
  name: string;
  versions: PromptVersion[];
}

// --- compliance ---
export interface Attestation {
  verified: boolean;
  count: number;
  firstHash?: string;
  lastHash?: string;
  algorithm?: string;
  signature?: string;
  [k: string]: unknown;
}
export interface WormStatus {
  lastShippedSeq?: number;
  [k: string]: unknown;
}
export interface AnchorRef {
  seq: number;
  headHash: string;
  createdAt?: string;
  [k: string]: unknown;
}

// --- privacy ---
export interface CryptoShredState {
  subject: string;
  active: boolean;
}
export interface MaskReveal {
  requestId: string;
  reveals: Array<{ direction: string; tokenCount: number; tokens: Record<string, string> }>;
}

// --- finops ---
export interface ChargebackRow {
  key: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  cacheSavedMicroUsd?: number;
}
export interface ChargebackQuery {
  workspaceId?: string;
  groupBy?: 'workspace' | 'provider' | 'model' | `attr:${string}`;
  from?: string;
  to?: string;
}
export interface ShadowSpendRow {
  provider: string;
  gatewayMicroUsd: number;
  providerMicroUsd: number;
  shadowMicroUsd: number;
  shadowRatioBps: number;
  flagged: boolean;
}
export interface ShadowSpendReport {
  flagged: boolean;
  rows: ShadowSpendRow[];
  reconciledProviders?: string[];
  [k: string]: unknown;
}

// --- eval rollouts ---
export interface EvalSuite {
  id: string;
  name: string;
  cases: Array<{ id: string; request: unknown; scorers: unknown[] }>;
}
export interface Rollout {
  id: string;
  suiteId: string;
  target: { workspaceId: string; alias: string; fromModel: string; toModel: string };
  status: 'pending' | 'promoted' | 'held' | 'error';
  createdAt: string;
  decidedAt?: string;
  appliedVersion?: number;
  report?: unknown;
  error?: string;
}

// --- observability (live gateway metrics) ---
export interface GatewayMetricsSummary {
  scrapedAt: string;
  requests: {
    total: number;
    byStatus: Record<string, number>;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    streamedShare: number;
  };
  tokens: { input: number; output: number; byProvider: Record<string, number> };
  cost: { totalMicroUsd: number; savedMicroUsd: Record<string, number>; unpriced: number };
  cache: { byStatus: Record<string, number>; hitRatio: number };
  guardrail: Record<string, number>;
  failovers: Record<string, number>;
  budgetAlerts: Record<string, number>;
  duration: { count: number; avgSeconds: number; p50: number; p90: number; p99: number };
}

// --- identity ---
export interface AdminUser {
  id: string;
  subject: string;
  displayName?: string;
  email?: string;
}
export interface Membership {
  id?: string;
  subject?: string;
  role: string;
  orgId: string;
  workspaceId?: string | null;
}
export interface AdminSessionInfo {
  jti: string;
  subject: string;
  source: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}
export interface OAuthClient {
  clientId: string;
  name: string;
  orgId: string;
  workspaceId: string;
  grantTypes: string[];
  redirectAllowlist: string[];
  enabled: boolean;
}
export interface OAuthGrant {
  handle: string;
  clientId: string;
  principalId: string;
  displayName: string;
  orgId: string;
  workspaceId: string;
  status: string;
  accessTokenExpiresAt: number;
  refreshGeneration: number;
  absoluteExpiresAt: number;
}
export interface DeviceCodeView {
  clientId: string;
  status: string;
  principalId?: string;
  displayName?: string;
  expiresAt: string;
}
export interface ReuseAlert {
  seq: number;
  handle: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

/** Micro-USD → a display string like "$1.2345". */
export function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}
