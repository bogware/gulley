import { and, asc, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm';

import type { Database } from './db';
import { org, spendLedger, workspace } from './schema';

/**
 * K5 per-agent FinOps over the DURABLE spend ledger: the agent cost tree
 * (session → prompt → subagent), per-session cost statistics for the runaway
 * detector, and a FOCUS 1.2-shaped export.
 *
 * Attribution comes from the ledger's `attributes` jsonb (zero-config Claude Code /
 * Codex tags: `session`, `prompt`, `cc_agent`, `cc_parent_agent`, `request_class`,
 * `compaction`, `agent`, plus operator tags). Cascade / hedge / classifier legs are
 * separate ledger rows whose request id is `<parent>#<leg>`; a classifier leg carries
 * no attributes, so every leg is attributed to its parent request through a self-join
 * on the parent id — cost rolls up to the session that caused it.
 */

// --- shared ---------------------------------------------------------------------

export interface LedgerWindow {
  /** RBAC scope. Undefined = every workspace; an explicit empty list = nothing. */
  workspaceIds?: string[];
  from?: Date;
  to?: Date;
}

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Window predicate on the (unaliased) spend_ledger table. */
function windowConds(q: LedgerWindow): SQL {
  const conds: SQL[] = [];
  if (q.workspaceIds) conds.push(inArray(spendLedger.workspaceId, q.workspaceIds));
  if (q.from) conds.push(gte(spendLedger.createdAt, q.from));
  if (q.to) conds.push(lt(spendLedger.createdAt, q.to));
  const w = conds.length ? and(...conds) : undefined;
  return w ?? sql`true`;
}

/** Ledger rows joined to the parent of a `<id>#<leg>` leg so a leg without its own
 *  attributes (the `#classify` row) inherits the parent's. */
const LEG_PARENT_JOIN = sql`left join spend_ledger p
    on strpos(spend_ledger.request_id, '#') > 0
   and p.request_id = split_part(spend_ledger.request_id, '#', 1)`;

/** Hard bound on sessions returned by the tree / stats queries. */
export const FINOPS_MAX_SESSIONS = 10_000;

// --- agent cost tree -------------------------------------------------------------

export interface AgentCostTotals {
  /** Distinct parent request ids (legs fold into their parent). */
  requests: number;
  /** Ledger rows, legs included. */
  legs: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  cacheSavedMicroUsd: number;
  /** Spend on context compaction (`request_class = compaction` or a `compaction` tag). */
  compactionMicroUsd: number;
  /** Spend with `request_class = subagent`. */
  subagentMicroUsd: number;
}

/** One leaf of the flat list: a (session, prompt, cc_agent) group. */
export interface AgentCostRow extends AgentCostTotals {
  workspaceId: string | null;
  session: string;
  principalId: string | null;
  prompt: string | null;
  ccAgent: string | null;
  ccParentAgent: string | null;
  firstAt: string;
  lastAt: string;
}

export interface AgentNode extends AgentCostTotals {
  ccAgent: string;
  ccParentAgent: string | null;
  /** Subagents whose `cc_parent_agent` is this agent. */
  children: AgentNode[];
}

export interface PromptNode extends AgentCostTotals {
  prompt: string | null;
  /** Spend by the main thread (no `cc_agent`) for this prompt. */
  direct: AgentCostTotals;
  /** Subagents, nested by parent; roots are agents whose parent is not in the prompt. */
  agents: AgentNode[];
}

export interface SessionNode extends AgentCostTotals {
  workspaceId: string | null;
  session: string;
  principalId: string | null;
  firstAt: string;
  lastAt: string;
  prompts: PromptNode[];
}

export interface AgentCostTree {
  tree: SessionNode[];
  rows: AgentCostRow[];
  /** True when more than {@link FINOPS_MAX_SESSIONS} sessions matched (the costliest are kept). */
  truncated: boolean;
}

export interface AgentCostTreeQuery extends LedgerWindow {
  /** One session only (the drill-down). */
  session?: string;
}

function emptyTotals(): AgentCostTotals {
  return {
    requests: 0,
    legs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0,
    cacheSavedMicroUsd: 0,
    compactionMicroUsd: 0,
    subagentMicroUsd: 0,
  };
}

function addTotals(into: AgentCostTotals, r: AgentCostTotals): void {
  into.requests += r.requests;
  into.legs += r.legs;
  into.inputTokens += r.inputTokens;
  into.outputTokens += r.outputTokens;
  into.costMicroUsd += r.costMicroUsd;
  into.cacheSavedMicroUsd += r.cacheSavedMicroUsd;
  into.compactionMicroUsd += r.compactionMicroUsd;
  into.subagentMicroUsd += r.subagentMicroUsd;
}

function totalsOf(r: AgentCostTotals): AgentCostTotals {
  const t = emptyTotals();
  addTotals(t, r);
  return t;
}

/**
 * Spend grouped by session → prompt → subagent over the window, costliest sessions
 * first, bounded to {@link FINOPS_MAX_SESSIONS}. Returns the nested tree and the flat
 * grouped rows it was built from.
 */
export async function agentCostTree(db: Database, q: AgentCostTreeQuery): Promise<AgentCostTree> {
  if (q.workspaceIds && q.workspaceIds.length === 0)
    return { tree: [], rows: [], truncated: false };
  // The session filter is applied on the base table (so the expression index serves
  // it) while still admitting attribute-less legs, which are re-filtered after the
  // parent join.
  const baseSession =
    q.session !== undefined
      ? sql`and (spend_ledger.attributes ->> 'session' = ${q.session}
             or (spend_ledger.attributes is null and strpos(spend_ledger.request_id, '#') > 0))`
      : sql``;
  const taggedSession =
    q.session !== undefined ? sql`and attrs ->> 'session' = ${q.session}` : sql``;
  const limit = FINOPS_MAX_SESSIONS + 1;
  const res = await db.execute(sql`
    with base as (
      select split_part(spend_ledger.request_id, '#', 1) as rid,
             spend_ledger.workspace_id,
             spend_ledger.principal_id,
             coalesce(spend_ledger.attributes, p.attributes) as attrs,
             spend_ledger.input_tokens,
             spend_ledger.output_tokens,
             spend_ledger.cost_micro_usd,
             spend_ledger.cache_saved_micro_usd,
             spend_ledger.created_at
      from spend_ledger
      ${LEG_PARENT_JOIN}
      where ${windowConds(q)} ${baseSession}
    ),
    tagged as (
      select rid, workspace_id, principal_id,
             attrs ->> 'session' as session,
             attrs ->> 'prompt' as prompt,
             attrs ->> 'cc_agent' as cc_agent,
             attrs ->> 'cc_parent_agent' as cc_parent_agent,
             (coalesce(attrs ->> 'request_class' = 'compaction', false)
               or (attrs -> 'compaction') is not null) as is_compaction,
             coalesce(attrs ->> 'request_class' = 'subagent', false) as is_subagent,
             input_tokens, output_tokens, cost_micro_usd, cache_saved_micro_usd, created_at
      from base
      where attrs ->> 'session' is not null ${taggedSession}
    ),
    top as (
      select workspace_id, session
      from tagged
      group by workspace_id, session
      order by sum(cost_micro_usd) desc, session
      limit ${limit}
    )
    select t.workspace_id, t.session, t.prompt, t.cc_agent, t.cc_parent_agent,
           min(t.principal_id) as principal_id,
           count(distinct t.rid) as requests,
           count(*) as legs,
           coalesce(sum(t.input_tokens), 0) as input_tokens,
           coalesce(sum(t.output_tokens), 0) as output_tokens,
           coalesce(sum(t.cost_micro_usd), 0) as cost_micro_usd,
           coalesce(sum(t.cache_saved_micro_usd), 0) as cache_saved_micro_usd,
           coalesce(sum(t.cost_micro_usd) filter (where t.is_compaction), 0) as compaction_micro_usd,
           coalesce(sum(t.cost_micro_usd) filter (where t.is_subagent), 0) as subagent_micro_usd,
           min(t.created_at) as first_at,
           max(t.created_at) as last_at
    from tagged t
    join top on top.workspace_id is not distinct from t.workspace_id and top.session = t.session
    group by t.workspace_id, t.session, t.prompt, t.cc_agent, t.cc_parent_agent
    order by t.workspace_id, t.session, 11 desc, t.prompt, t.cc_agent
  `);
  const rows: AgentCostRow[] = rowsOf<Record<string, unknown>>(res).map((r) => ({
    workspaceId: str(r['workspace_id']),
    session: String(r['session']),
    principalId: str(r['principal_id']),
    prompt: str(r['prompt']),
    ccAgent: str(r['cc_agent']),
    ccParentAgent: str(r['cc_parent_agent']),
    requests: num(r['requests']),
    legs: num(r['legs']),
    inputTokens: num(r['input_tokens']),
    outputTokens: num(r['output_tokens']),
    costMicroUsd: num(r['cost_micro_usd']),
    cacheSavedMicroUsd: num(r['cache_saved_micro_usd']),
    compactionMicroUsd: num(r['compaction_micro_usd']),
    subagentMicroUsd: num(r['subagent_micro_usd']),
    firstAt: iso(r['first_at']),
    lastAt: iso(r['last_at']),
  }));
  return buildAgentTree(rows);
}

/** Fold flat (session, prompt, agent) rows into the nested tree. Pure; exported for
 *  tests and for callers that already hold rows. */
export function buildAgentTree(rows: AgentCostRow[]): AgentCostTree {
  const sessions = new Map<string, SessionNode & { promptIndex: Map<string, PromptNode> }>();
  for (const r of rows) {
    const key = `${r.workspaceId ?? ''}:${r.session}`;
    let s = sessions.get(key);
    if (!s) {
      s = {
        ...emptyTotals(),
        workspaceId: r.workspaceId,
        session: r.session,
        principalId: r.principalId,
        firstAt: r.firstAt,
        lastAt: r.lastAt,
        prompts: [],
        promptIndex: new Map(),
      };
      sessions.set(key, s);
    }
    addTotals(s, r);
    if (r.firstAt && (!s.firstAt || r.firstAt < s.firstAt)) s.firstAt = r.firstAt;
    if (r.lastAt > s.lastAt) s.lastAt = r.lastAt;
    if (s.principalId === null && r.principalId !== null) s.principalId = r.principalId;
    const pk = r.prompt ?? '';
    let p = s.promptIndex.get(pk);
    if (!p) {
      p = { ...emptyTotals(), prompt: r.prompt, direct: emptyTotals(), agents: [] };
      s.promptIndex.set(pk, p);
      s.prompts.push(p);
    }
    addTotals(p, r);
    if (r.ccAgent === null) addTotals(p.direct, r);
    else
      p.agents.push({
        ...totalsOf(r),
        ccAgent: r.ccAgent,
        ccParentAgent: r.ccParentAgent,
        children: [],
      });
  }
  const truncated = sessions.size > FINOPS_MAX_SESSIONS;
  const tree: SessionNode[] = [...sessions.values()]
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || a.session.localeCompare(b.session))
    .slice(0, FINOPS_MAX_SESSIONS)
    .map(({ promptIndex: _ignored, ...s }) => ({
      ...s,
      prompts: s.prompts
        .sort((a, b) => b.costMicroUsd - a.costMicroUsd)
        .map((p) => ({ ...p, agents: nestAgents(p.agents) })),
    }));
  const kept = new Set(tree.map((s) => `${s.workspaceId ?? ''}:${s.session}`));
  return {
    tree,
    rows: truncated ? rows.filter((r) => kept.has(`${r.workspaceId ?? ''}:${r.session}`)) : rows,
    truncated,
  };
}

/** Nest subagents under their parent when the parent is in the same prompt; the rest
 *  stay at the root. A cycle (bad client data) falls back to the root. */
function nestAgents(flat: AgentNode[]): AgentNode[] {
  const byId = new Map<string, AgentNode>();
  for (const a of flat) {
    const existing = byId.get(a.ccAgent);
    if (existing) {
      addTotals(existing, a); // the same agent id under two parents: merge
    } else byId.set(a.ccAgent, a);
  }
  const roots: AgentNode[] = [];
  for (const a of byId.values()) {
    const parent = a.ccParentAgent !== null ? byId.get(a.ccParentAgent) : undefined;
    if (parent && parent !== a && !isAncestor(a, parent, byId)) parent.children.push(a);
    else roots.push(a);
  }
  const sortRec = (nodes: AgentNode[]): AgentNode[] => {
    nodes.sort((x, y) => y.costMicroUsd - x.costMicroUsd || x.ccAgent.localeCompare(y.ccAgent));
    for (const n of nodes) sortRec(n.children);
    return nodes;
  };
  return sortRec(roots);
}

function isAncestor(candidate: AgentNode, of: AgentNode, byId: Map<string, AgentNode>): boolean {
  let cur: AgentNode | undefined = of;
  for (let i = 0; cur && i < 1000; i++) {
    if (cur === candidate) return true;
    cur = cur.ccParentAgent !== null ? byId.get(cur.ccParentAgent) : undefined;
  }
  return false;
}

// --- per-session cost statistics (runaway detector) --------------------------------

export interface SessionCost {
  workspaceId: string | null;
  session: string;
  orgId: string | null;
  principalId: string | null;
  costMicroUsd: number;
  requests: number;
  firstAt: string;
  lastAt: string;
}

/** Percentiles over per-session cost. `*ExcludingTop*` leaves the single costliest
 *  session out, so a candidate that IS the top session can be compared against the
 *  distribution of the others (a percentile that includes the candidate can never be
 *  exceeded by it when fewer than 100 sessions exist). */
export interface PrincipalSessionStats {
  principalId: string;
  sessions: number;
  p95MicroUsd: number;
  p95ExcludingTopMicroUsd: number;
  /** `${workspaceId ?? ''}:${session}` of this principal's costliest session. */
  topSessionKey: string | null;
}

export interface OrgSessionStats {
  sessions: number;
  p95MicroUsd: number;
  p99MicroUsd: number;
  p95ExcludingTopMicroUsd: number;
  p99ExcludingTopMicroUsd: number;
  topSessionKey: string | null;
}

export interface SessionCostStats {
  /** Costliest first, bounded to {@link FINOPS_MAX_SESSIONS}. */
  sessions: SessionCost[];
  principals: Record<string, PrincipalSessionStats>;
  /** The whole queried scope (single-tenant: the deployment). */
  org: OrgSessionStats;
}

export function sessionKey(workspaceId: string | null, session: string): string {
  return `${workspaceId ?? ''}:${session}`;
}

/**
 * Per-session cost over the window plus the percentiles the runaway rule needs:
 * each principal's p95 of per-session cost, and the scope-wide p95/p99 — both with
 * and without the costliest session.
 */
export async function sessionCostStats(db: Database, q: LedgerWindow): Promise<SessionCostStats> {
  const empty: OrgSessionStats = {
    sessions: 0,
    p95MicroUsd: 0,
    p99MicroUsd: 0,
    p95ExcludingTopMicroUsd: 0,
    p99ExcludingTopMicroUsd: 0,
    topSessionKey: null,
  };
  if (q.workspaceIds && q.workspaceIds.length === 0)
    return { sessions: [], principals: {}, org: empty };
  const ranked = sql`
    with base as (
      select split_part(spend_ledger.request_id, '#', 1) as rid,
             spend_ledger.workspace_id,
             spend_ledger.org_id,
             spend_ledger.principal_id,
             coalesce(spend_ledger.attributes, p.attributes) ->> 'session' as session,
             spend_ledger.cost_micro_usd,
             spend_ledger.created_at
      from spend_ledger
      ${LEG_PARENT_JOIN}
      where ${windowConds(q)}
    ),
    per_session as (
      select workspace_id, session,
             min(org_id::text) as org_id,
             min(principal_id) as principal_id,
             coalesce(sum(cost_micro_usd), 0) as cost,
             count(distinct rid) as requests,
             min(created_at) as first_at,
             max(created_at) as last_at
      from base
      where session is not null
      group by workspace_id, session
    ),
    ranked as (
      select *,
             coalesce(workspace_id::text, '') || ':' || session as key,
             row_number() over (order by cost desc, workspace_id, session) as org_rank,
             row_number() over (partition by principal_id order by cost desc, workspace_id, session) as principal_rank
      from per_session
    )`;
  const [sessRes, statRes] = await Promise.all([
    db.execute(sql`${ranked}
      select workspace_id, session, org_id, principal_id, cost, requests, first_at, last_at
      from ranked
      order by cost desc, workspace_id, session
      limit ${FINOPS_MAX_SESSIONS}`),
    db.execute(sql`${ranked}
      select grouping(principal_id) as is_org,
             principal_id,
             count(*) as sessions,
             percentile_disc(0.95) within group (order by cost) as p95,
             percentile_disc(0.99) within group (order by cost) as p99,
             percentile_disc(0.95) within group (order by cost) filter (where principal_rank > 1) as p95_loo_principal,
             percentile_disc(0.95) within group (order by cost) filter (where org_rank > 1) as p95_loo_org,
             percentile_disc(0.99) within group (order by cost) filter (where org_rank > 1) as p99_loo_org,
             max(case when principal_rank = 1 then key end) as top_principal_key,
             max(case when org_rank = 1 then key end) as top_org_key
      from ranked
      group by grouping sets ((principal_id), ())`),
  ]);
  const sessions: SessionCost[] = rowsOf<Record<string, unknown>>(sessRes).map((r) => ({
    workspaceId: str(r['workspace_id']),
    session: String(r['session']),
    orgId: str(r['org_id']),
    principalId: str(r['principal_id']),
    costMicroUsd: num(r['cost']),
    requests: num(r['requests']),
    firstAt: iso(r['first_at']),
    lastAt: iso(r['last_at']),
  }));
  const principals: Record<string, PrincipalSessionStats> = {};
  let orgStats = empty;
  for (const r of rowsOf<Record<string, unknown>>(statRes)) {
    if (num(r['is_org']) === 1) {
      orgStats = {
        sessions: num(r['sessions']),
        p95MicroUsd: num(r['p95']),
        p99MicroUsd: num(r['p99']),
        p95ExcludingTopMicroUsd: num(r['p95_loo_org']),
        p99ExcludingTopMicroUsd: num(r['p99_loo_org']),
        topSessionKey: str(r['top_org_key']),
      };
      continue;
    }
    const principalId = str(r['principal_id']);
    if (principalId === null) continue;
    principals[principalId] = {
      principalId,
      sessions: num(r['sessions']),
      p95MicroUsd: num(r['p95']),
      p95ExcludingTopMicroUsd: num(r['p95_loo_principal']),
      topSessionKey: str(r['top_principal_key']),
    };
  }
  return { sessions, principals, org: orgStats };
}

// --- FOCUS 1.2 export -------------------------------------------------------------

/** FOCUS 1.2 column order, then the `x_gulley_*` extension columns. Fixed: the CSV
 *  header and every JSON Lines object follow this order. */
export const FOCUS_COLUMNS = [
  'BilledCost',
  'EffectiveCost',
  'ListCost',
  'ContractedCost',
  'BillingCurrency',
  'BillingAccountId',
  'BillingAccountName',
  'SubAccountId',
  'SubAccountName',
  'ChargeCategory',
  'ChargeClass',
  'ChargeFrequency',
  'ChargeDescription',
  'ChargePeriodStart',
  'ChargePeriodEnd',
  'BillingPeriodStart',
  'BillingPeriodEnd',
  'ServiceName',
  'ServiceCategory',
  'ServiceSubcategory',
  'ProviderName',
  'PublisherName',
  'InvoiceIssuerName',
  'ResourceId',
  'ResourceName',
  'ResourceType',
  'RegionId',
  'RegionName',
  'SkuId',
  'SkuPriceId',
  'PricingCategory',
  'PricingQuantity',
  'PricingUnit',
  'ConsumedQuantity',
  'ConsumedUnit',
  'ListUnitPrice',
  'Tags',
  'x_gulley_input_tokens',
  'x_gulley_output_tokens',
  'x_gulley_cache_read_tokens',
  'x_gulley_cache_write_tokens',
  'x_gulley_principal_id',
  'x_gulley_status',
  'x_gulley_session',
  'x_gulley_prompt',
  'x_gulley_agent',
  'x_gulley_cc_agent',
  'x_gulley_request_class',
] as const;

export type FocusColumn = (typeof FOCUS_COLUMNS)[number];
export type FocusValue = string | number | null | Record<string, string>;
export type FocusRow = Record<FocusColumn, FocusValue>;

const PUBLISHERS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  bedrock: 'Amazon Web Services',
  azure: 'Microsoft',
};

/** FOCUS `PublisherName` for a Gulley provider id (the vendor behind the API). */
export function focusPublisher(provider: string): string {
  return PUBLISHERS[provider] ?? provider;
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function nextMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Micro-USD → a USD decimal with no float noise (6 fixed decimals, trimmed). */
export function microToUsd(micro: number): number {
  return Number((micro / 1_000_000).toFixed(6));
}

export interface FocusLedgerRow {
  id: string;
  requestId: string;
  principalId: string;
  orgId: string | null;
  orgName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  provider: string;
  model: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheSavedMicroUsd: number;
  costMicroUsd: number;
  attributes: Record<string, unknown> | null;
  createdAt: Date;
}

function tagString(attrs: Record<string, unknown> | null, key: string): string | null {
  const v = attrs?.[key];
  return typeof v === 'string' ? v : v === undefined || v === null ? null : String(v);
}

/** Map one ledger row to a FOCUS 1.2 row. Pure; exported for tests. */
export function toFocusRow(r: FocusLedgerRow): FocusRow {
  const created = r.createdAt;
  const effective = microToUsd(r.costMicroUsd);
  const tokens = r.inputTokens + r.outputTokens;
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.attributes ?? {})) {
    if (v !== null && v !== undefined) tags[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return {
    BilledCost: effective,
    EffectiveCost: effective,
    ListCost: microToUsd(r.costMicroUsd + r.cacheSavedMicroUsd),
    ContractedCost: effective,
    BillingCurrency: 'USD',
    BillingAccountId: r.orgId,
    BillingAccountName: r.orgName ?? r.orgId,
    SubAccountId: r.workspaceId,
    SubAccountName: r.workspaceName ?? r.workspaceId,
    ChargeCategory: 'Usage',
    ChargeClass: null,
    ChargeFrequency: 'Usage-Based',
    ChargeDescription: `${r.provider}/${r.model} request`,
    ChargePeriodStart: created.toISOString(),
    ChargePeriodEnd: created.toISOString(),
    BillingPeriodStart: monthStart(created).toISOString(),
    BillingPeriodEnd: nextMonthStart(created).toISOString(),
    ServiceName: 'Gulley LLM Gateway',
    ServiceCategory: 'AI and Machine Learning',
    ServiceSubcategory: 'Generative AI',
    ProviderName: r.provider,
    PublisherName: focusPublisher(r.provider),
    InvoiceIssuerName: 'Gulley',
    ResourceId: r.requestId,
    ResourceName: null,
    ResourceType: 'llm-request',
    RegionId: null,
    RegionName: null,
    SkuId: r.model,
    SkuPriceId: null,
    PricingCategory: 'Standard',
    PricingQuantity: tokens,
    PricingUnit: 'Tokens',
    ConsumedQuantity: tokens,
    ConsumedUnit: 'Tokens',
    ListUnitPrice: null,
    Tags: tags,
    x_gulley_input_tokens: r.inputTokens,
    x_gulley_output_tokens: r.outputTokens,
    x_gulley_cache_read_tokens: r.cacheReadTokens,
    x_gulley_cache_write_tokens: r.cacheWriteTokens,
    x_gulley_principal_id: r.principalId,
    x_gulley_status: r.status,
    x_gulley_session: tagString(r.attributes, 'session'),
    x_gulley_prompt: tagString(r.attributes, 'prompt'),
    x_gulley_agent: tagString(r.attributes, 'agent'),
    x_gulley_cc_agent: tagString(r.attributes, 'cc_agent'),
    x_gulley_request_class: tagString(r.attributes, 'request_class'),
  };
}

/** RFC 4180 field: quoted when it holds a comma, quote or line break (quotes doubled);
 *  a string beginning with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` so a
 *  spreadsheet never evaluates an attribution value as a formula. Numbers and nulls
 *  are emitted bare (null = empty field). */
export function csvField(v: FocusValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const FOCUS_CSV_HEADER = `${FOCUS_COLUMNS.join(',')}\r\n`;

export function focusCsvLine(row: FocusRow): string {
  return `${FOCUS_COLUMNS.map((c) => csvField(row[c])).join(',')}\r\n`;
}

/** One JSON Lines record, keys in {@link FOCUS_COLUMNS} order. */
export function focusJsonlLine(row: FocusRow): string {
  const ordered: Record<string, FocusValue> = {};
  for (const c of FOCUS_COLUMNS) ordered[c] = row[c];
  return `${JSON.stringify(ordered)}\n`;
}

// --- FOCUS paging over the ledger ---------------------------------------------------

export interface FocusCursor {
  createdAt: Date;
  id: string;
}

export function encodeFocusCursor(c: FocusCursor): string {
  return Buffer.from(JSON.stringify({ t: c.createdAt.toISOString(), id: c.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeFocusCursor(raw: string | undefined): FocusCursor | undefined {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (typeof j.t !== 'string' || typeof j.id !== 'string') return undefined;
    const d = new Date(j.t);
    return Number.isNaN(d.getTime()) ? undefined : { createdAt: d, id: j.id };
  } catch {
    return undefined;
  }
}

export interface FocusQuery extends LedgerWindow {
  /** Rows per call (1..50_000; default 1_000). */
  limit?: number;
  /** Resume after this row (from a previous `nextCursor`). */
  cursor?: string;
  /** Internal: stop at (and include) this row — keeps a streamed page consistent. */
  endCursor?: string;
}

export interface FocusPage {
  rows: FocusRow[];
  nextCursor?: string;
}

/** Keyset predicate: rows strictly after the cursor under (created_at, id). */
function afterCursor(c: FocusCursor): SQL {
  return sql`(${spendLedger.createdAt} > ${c.createdAt} OR (${spendLedger.createdAt} = ${c.createdAt} AND ${spendLedger.id}::text > ${c.id}))`;
}
function atOrBeforeCursor(c: FocusCursor): SQL {
  return sql`(${spendLedger.createdAt} < ${c.createdAt} OR (${spendLedger.createdAt} = ${c.createdAt} AND ${spendLedger.id}::text <= ${c.id}))`;
}

/** One page of FOCUS rows, oldest first, keyset-paged by (created_at, id). */
export async function focusRows(db: Database, q: FocusQuery): Promise<FocusPage> {
  if (q.workspaceIds && q.workspaceIds.length === 0) return { rows: [] };
  const limit = Math.max(1, Math.min(q.limit ?? 1_000, 50_000));
  const conds: SQL[] = [windowConds(q)];
  const start = decodeFocusCursor(q.cursor);
  if (start) conds.push(afterCursor(start));
  const end = decodeFocusCursor(q.endCursor);
  if (end) conds.push(atOrBeforeCursor(end));
  const rows = await db
    .select({
      id: spendLedger.id,
      requestId: spendLedger.requestId,
      principalId: spendLedger.principalId,
      orgId: spendLedger.orgId,
      orgName: org.name,
      workspaceId: spendLedger.workspaceId,
      workspaceName: workspace.name,
      provider: spendLedger.provider,
      model: spendLedger.model,
      status: spendLedger.status,
      inputTokens: spendLedger.inputTokens,
      outputTokens: spendLedger.outputTokens,
      cacheReadTokens: spendLedger.cacheReadTokens,
      cacheWriteTokens: spendLedger.cacheWriteTokens,
      cacheSavedMicroUsd: spendLedger.cacheSavedMicroUsd,
      costMicroUsd: spendLedger.costMicroUsd,
      attributes: spendLedger.attributes,
      createdAt: spendLedger.createdAt,
    })
    .from(spendLedger)
    .leftJoin(org, eq(org.id, spendLedger.orgId))
    .leftJoin(workspace, eq(workspace.id, spendLedger.workspaceId))
    .where(and(...conds))
    .orderBy(asc(spendLedger.createdAt), asc(spendLedger.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) =>
      toFocusRow({
        ...r,
        attributes: (r.attributes ?? null) as Record<string, unknown> | null,
        createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt)),
      }),
    ),
    nextCursor:
      rows.length > limit && last
        ? encodeFocusCursor({
            createdAt:
              last.createdAt instanceof Date ? last.createdAt : new Date(String(last.createdAt)),
            id: last.id,
          })
        : undefined,
  };
}

export interface FocusPageStreamQuery extends LedgerWindow {
  cursor?: string;
  /** Rows in this streamed page (default 50_000). */
  pageSize?: number;
  /** Rows per database round-trip while streaming (default 5_000). */
  batchSize?: number;
}

export interface FocusPageStream {
  /** Present when another page follows this one; pass it back as `cursor`. Known
   *  BEFORE the first batch is read, so it can travel in a response header. */
  nextCursor?: string;
  /** Yields the page in order, batch by batch. */
  batches: () => AsyncGenerator<FocusRow[], void, undefined>;
}

/**
 * A streamable page of up to `pageSize` FOCUS rows. The page's last row is located
 * up front (one bounded index probe), so the continuation cursor is known before any
 * row is emitted and the batches are bounded to that row — a page stays identical even
 * if rows land in the window while it streams.
 */
export async function openFocusPage(
  db: Database,
  q: FocusPageStreamQuery,
): Promise<FocusPageStream> {
  const pageSize = Math.max(1, Math.min(q.pageSize ?? 50_000, 50_000));
  const batchSize = Math.max(1, Math.min(q.batchSize ?? 5_000, pageSize));
  if (q.workspaceIds && q.workspaceIds.length === 0) {
    return { batches: async function* () {} };
  }
  const conds: SQL[] = [windowConds(q)];
  const start = decodeFocusCursor(q.cursor);
  if (start) conds.push(afterCursor(start));
  // The page boundary: the row at offset pageSize-1 is this page's last row; a row
  // after it means another page follows.
  const boundary = await db
    .select({ createdAt: spendLedger.createdAt, id: spendLedger.id })
    .from(spendLedger)
    .where(and(...conds))
    .orderBy(asc(spendLedger.createdAt), asc(spendLedger.id))
    .offset(pageSize - 1)
    .limit(2);
  const endRow = boundary[0];
  const end = endRow
    ? encodeFocusCursor({
        createdAt:
          endRow.createdAt instanceof Date ? endRow.createdAt : new Date(String(endRow.createdAt)),
        id: endRow.id,
      })
    : undefined;
  const nextCursor = boundary.length > 1 ? end : undefined;
  const window: LedgerWindow = { workspaceIds: q.workspaceIds, from: q.from, to: q.to };
  async function* batches(): AsyncGenerator<FocusRow[], void, undefined> {
    let cursor = q.cursor;
    let emitted = 0;
    for (;;) {
      const page = await focusRows(db, {
        ...window,
        cursor,
        endCursor: end,
        limit: Math.min(batchSize, pageSize - emitted),
      });
      if (page.rows.length > 0) yield page.rows;
      emitted += page.rows.length;
      if (!page.nextCursor || emitted >= pageSize) return;
      cursor = page.nextCursor;
    }
  }
  return { nextCursor, batches };
}
