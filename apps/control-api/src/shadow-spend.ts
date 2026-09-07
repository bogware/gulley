import { assertEgressAllowed } from '@gulley/egress';

/**
 * Shadow-spend reconciliation — the "CISO bypass alert".
 *
 * Gulley's durable ledger is the source of truth for spend the GATEWAY mediated.
 * But a provider API key used DIRECTLY (bypassing the gateway) still bills the org
 * and never touches the ledger. This module reconciles each provider's own
 * usage/cost API (Anthropic Admin, OpenAI) against the ledger totals for the same
 * period: any excess the provider billed beyond what the gateway mediated is
 * "shadow spend" — usage that escaped governance/DLP/budget. A per-provider ratio
 * over a threshold is flagged for a bypass alert.
 *
 * The reconciliation ENGINE and the response PARSERS are pure + unit-tested; the
 * live provider fetch is egress-guarded and exercised by a live-check only.
 */

/** Provider-reported usage for a period, normalized to the ledger's micro-USD unit. */
export interface ProviderUsageRow {
  provider: string;
  costMicroUsd: number;
}

/** Gateway-side spend for a period (a subset of storage's LedgerSpendTotal). */
export interface GatewaySpendRow {
  provider: string;
  costMicroUsd: number;
}

export interface ShadowSpendRow {
  provider: string;
  /** Spend the gateway mediated (from the durable ledger). */
  gatewayMicroUsd: number;
  /** Spend the provider's own usage/cost API reports it billed. */
  providerMicroUsd: number;
  /** Excess the provider billed beyond the gateway — spend that bypassed Gulley. */
  shadowMicroUsd: number;
  /** shadowMicroUsd / providerMicroUsd (0..1). */
  shadowRatio: number;
  /** True when shadowRatio meets the flag threshold and there is real shadow spend. */
  flagged: boolean;
}

export interface ShadowSpendReport {
  rows: ShadowSpendRow[];
  gatewayTotalMicroUsd: number;
  providerTotalMicroUsd: number;
  shadowTotalMicroUsd: number;
  /** True when ANY provider is flagged — the CISO bypass alert. */
  flagged: boolean;
  /** The providers for which provider-side usage was available (reconciled). A
   *  provider absent here has gateway-only data (its API was not configured). */
  reconciledProviders: string[];
}

function sumByProvider(
  rows: Array<{ provider: string; costMicroUsd: number }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.provider, (m.get(r.provider) ?? 0) + r.costMicroUsd);
  return m;
}

/**
 * Reconcile provider-reported spend against gateway-mediated (ledger) spend, per
 * provider. Reconciliation is at the PROVIDER level (summing models) because a
 * provider's usage API may label models differently than the ledger — the
 * provider total vs gateway total is the robust bypass signal. `flagRatioBps` is
 * the shadow/provider ratio (in basis points) at/above which a provider is
 * flagged; default 500 bps (5%). Only providers present in `provider` (i.e. whose
 * usage API was reconciled) can be flagged — a gateway-only provider is reported
 * with providerMicroUsd 0 and never flagged (absence of data ≠ evidence of bypass).
 */
export function reconcileShadowSpend(
  provider: ProviderUsageRow[],
  gateway: GatewaySpendRow[],
  opts: { flagRatioBps?: number } = {},
): ShadowSpendReport {
  const flagRatio = Math.max(0, opts.flagRatioBps ?? 500) / 10_000;
  const providerByName = sumByProvider(provider);
  const gatewayByName = sumByProvider(gateway);
  const reconciledProviders = [...providerByName.keys()];
  const names = new Set<string>([...providerByName.keys(), ...gatewayByName.keys()]);
  const rows: ShadowSpendRow[] = [];
  for (const name of names) {
    const providerMicroUsd = providerByName.get(name) ?? 0;
    const gatewayMicroUsd = gatewayByName.get(name) ?? 0;
    const shadowMicroUsd = Math.max(0, providerMicroUsd - gatewayMicroUsd);
    const shadowRatio = providerMicroUsd > 0 ? shadowMicroUsd / providerMicroUsd : 0;
    // Only a reconciled provider (real provider-side data) can be flagged.
    const flagged = providerByName.has(name) && shadowMicroUsd > 0 && shadowRatio >= flagRatio;
    rows.push({
      provider: name,
      gatewayMicroUsd,
      providerMicroUsd,
      shadowMicroUsd,
      shadowRatio,
      flagged,
    });
  }
  rows.sort((a, b) => b.shadowMicroUsd - a.shadowMicroUsd);
  return {
    rows,
    gatewayTotalMicroUsd: [...gatewayByName.values()].reduce((n, v) => n + v, 0),
    providerTotalMicroUsd: [...providerByName.values()].reduce((n, v) => n + v, 0),
    shadowTotalMicroUsd: rows.reduce((n, r) => n + r.shadowMicroUsd, 0),
    flagged: rows.some((r) => r.flagged),
    reconciledProviders,
  };
}

function usd(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0; // USD → micro-USD
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Parse an Anthropic Admin cost-report response into a provider total. The cost
 * report groups amounts into time buckets, each with one or more `results` line
 * items carrying an `amount` (USD). We sum every line item across all buckets.
 * Shape (Admin API `GET /v1/organizations/cost_report`):
 *   { data: [ { results: [ { amount: "12.34", currency: "USD", ... } ] } ] }
 * Defensive: unknown fields ignored, non-numeric amounts skipped.
 */
export function parseAnthropicCostReport(json: unknown): ProviderUsageRow[] {
  const root = asRecord(json);
  const data = Array.isArray(root?.['data']) ? (root!['data'] as unknown[]) : [];
  let micro = 0;
  for (const bucket of data) {
    const results = asRecord(bucket)?.['results'];
    if (!Array.isArray(results)) continue;
    for (const item of results) {
      const r = asRecord(item);
      if (r && (r['amount'] !== undefined || r['cost'] !== undefined)) {
        micro += usd(r['amount'] ?? r['cost']);
      }
    }
  }
  return micro > 0 ? [{ provider: 'anthropic', costMicroUsd: micro }] : [];
}

/**
 * Parse an OpenAI organization costs response into a provider total. Shape
 * (`GET /v1/organization/costs`):
 *   { data: [ { results: [ { amount: { value: 12.34, currency: "usd" } } ] } ] }
 * Sums `amount.value` across all buckets/results.
 */
export function parseOpenAICostReport(json: unknown): ProviderUsageRow[] {
  const root = asRecord(json);
  const data = Array.isArray(root?.['data']) ? (root!['data'] as unknown[]) : [];
  let micro = 0;
  for (const bucket of data) {
    const results = asRecord(bucket)?.['results'];
    if (!Array.isArray(results)) continue;
    for (const item of results) {
      const amount = asRecord(asRecord(item)?.['amount']);
      if (amount && amount['value'] !== undefined) micro += usd(amount['value']);
    }
  }
  return micro > 0 ? [{ provider: 'openai', costMicroUsd: micro }] : [];
}

/** Fetches provider-reported usage for the [from, to) window. Injectable so the
 *  route + reconciliation are testable without live provider calls. */
export type ProviderUsageSource = (from: Date, to: Date) => Promise<ProviderUsageRow[]>;

export interface AdminApiClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowlist?: ReadonlySet<string> | readonly string[];
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  opts: AdminApiClientOptions,
): Promise<unknown> {
  // SSRF guard before every outbound admin-API call (structural; the hosts are
  // fixed provider domains). DNS-rebind is not re-checked here because the host is
  // a hard-coded provider domain, not operator input.
  assertEgressAllowed(url, { allowlist: opts.allowlist });
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  timer.unref?.();
  try {
    const res = await doFetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`admin usage API returned ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Anthropic Admin cost-report ingest. Requires an org Admin API key (sk-ant-admin…).
 *  Live call — exercised by a live-check, not CI. */
export function anthropicAdminUsageSource(
  adminKey: string,
  opts: AdminApiClientOptions = {},
): ProviderUsageSource {
  return async (from, to) => {
    const params = new URLSearchParams({
      starting_at: from.toISOString(),
      ending_at: to.toISOString(),
      bucket_width: '1d',
    });
    const json = await getJson(
      `https://api.anthropic.com/v1/organizations/cost_report?${params.toString()}`,
      { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' },
      opts,
    );
    return parseAnthropicCostReport(json);
  };
}

/** OpenAI organization-costs ingest. Requires an Admin API key. Live call. */
export function openAiUsageSource(
  adminKey: string,
  opts: AdminApiClientOptions = {},
): ProviderUsageSource {
  return async (from, to) => {
    const params = new URLSearchParams({
      start_time: String(Math.floor(from.getTime() / 1000)),
      end_time: String(Math.floor(to.getTime() / 1000)),
      bucket_width: '1d',
    });
    const json = await getJson(
      `https://api.openai.com/v1/organization/costs?${params.toString()}`,
      { authorization: `Bearer ${adminKey}` },
      opts,
    );
    return parseOpenAICostReport(json);
  };
}

/**
 * Run a full reconciliation: pull each configured provider's usage for [from, to)
 * and reconcile against the gateway ledger totals. A provider source that throws
 * (API error) is skipped — reconciliation degrades to the providers it could
 * reach rather than failing the whole report.
 */
export async function runShadowSpendReconciliation(
  gateway: GatewaySpendRow[],
  sources: ProviderUsageSource[],
  from: Date,
  to: Date,
  opts: { flagRatioBps?: number } = {},
): Promise<ShadowSpendReport> {
  const provider: ProviderUsageRow[] = [];
  for (const source of sources) {
    try {
      provider.push(...(await source(from, to)));
    } catch {
      /* skip an unreachable provider; report the rest */
    }
  }
  return reconcileShadowSpend(provider, gateway, opts);
}
