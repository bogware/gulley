import type { AuditSink } from '@gulley/pipeline';
import type { SessionBlockStore, SessionCost, SessionCostStats } from '@gulley/storage';
import { sessionKey } from '@gulley/storage';

/**
 * Runaway-session detector (K5). Every tick it scores each agent session active in
 * the last `windowMinutes` against two bars and flags (or blocks) the ones that
 * clear both:
 *
 *   C                 = the session's spend over the baseline window
 *   baseline          = baselineMultiplier (2) × p95 of the PRINCIPAL's per-session
 *                       spend over `baselineDays` — or the scope-wide p95 when the
 *                       principal has fewer than `minPrincipalSessions` (20) sessions
 *   runaway           ⇔ C > max(minCostUsd, baseline) AND C > scope-wide p99
 *
 * Percentiles that include the candidate itself cannot be exceeded by it when fewer
 * than 100 sessions exist, so when the candidate IS the costliest session the
 * leave-one-out percentiles (the distribution of the OTHER sessions) are used. With
 * no other session at all the bars collapse to `minCostUsd` — the cold-start floor.
 *
 * Actions: `flag` audits + alerts; `block` additionally writes a TTL-bounded
 * `session_block` row the gateway honours. A session is never re-alerted within the
 * block TTL (in-process dedupe; an already-blocked session is skipped outright).
 */

/** Mirrors `SessionRunawayAlert` in @gulley/alerts — structurally identical so the
 *  real `AlertSink` plugs in unchanged; kept local so this app needs no dependency
 *  on the alerts package until it is wired. */
export interface SessionRunawayAlertEvent {
  kind: 'session.runaway';
  session: string;
  workspaceId: string;
  principalId?: string;
  costMicroUsd: number;
  baselineMicroUsd: number;
  orgP99MicroUsd: number;
  action: 'blocked' | 'flagged';
  /** ISO-8601. */
  at: string;
  severity: 'warning' | 'critical';
}

export interface RunawayAlertSink {
  emit(event: SessionRunawayAlertEvent): void;
}

export interface RunawayDetectorOptions {
  /** A session counts as active when it spent within this many minutes. */
  windowMinutes: number;
  /** Baseline statistics are computed over this many days. */
  baselineDays: number;
  /** Absolute floor (USD): a session below it is never a runaway. */
  minCostUsd: number;
  action: 'flag' | 'block';
  /** TTL of a detector-written block, and the re-alert suppression window. */
  blockTtlMinutes: number;
  /** Principals with fewer sessions than this use the scope-wide p95. Default 20. */
  minPrincipalSessions?: number;
  /** baseline = this × p95. Default 2. */
  baselineMultiplier?: number;
}

export interface RunawayDetectorDeps {
  /** Per-session spend + percentiles over [from, to) (storage `sessionCostStats`). */
  stats: (window: { from: Date; to: Date }) => Promise<SessionCostStats>;
  blocks: SessionBlockStore;
  audit: AuditSink;
  alerts?: RunawayAlertSink;
  /** Cross-replica exclusion for one tick; resolves `undefined` when another replica
   *  holds the lock. Default: no exclusion (single process / tests). */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  now?: () => Date;
  log?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export interface RunawayFinding {
  session: string;
  workspaceId: string | null;
  orgId: string | null;
  principalId: string | null;
  costMicroUsd: number;
  baselineMicroUsd: number;
  orgP99MicroUsd: number;
  /** Which distribution produced the baseline. */
  baselineSource: 'principal' | 'org';
}

export interface RunawayTickResult {
  /** Another replica held the lock; nothing was evaluated. */
  skipped: boolean;
  /** Sessions active in the window that were scored. */
  evaluated: number;
  /** Findings acted on this tick (already-blocked / recently-alerted sessions excluded). */
  runaway: Array<RunawayFinding & { action: 'blocked' | 'flagged' }>;
}

const DEFAULT_MIN_PRINCIPAL_SESSIONS = 20;
const DEFAULT_BASELINE_MULTIPLIER = 2;

export class RunawayDetector {
  /** `${workspaceId}:${session}` → epoch ms until which it is not re-alerted. */
  private readonly alerted = new Map<string, number>();

  constructor(
    private readonly opts: RunawayDetectorOptions,
    private readonly deps: RunawayDetectorDeps,
  ) {}

  /** Pure scoring of one stats snapshot: every active session that clears both bars. */
  evaluate(stats: SessionCostStats, now: Date): RunawayFinding[] {
    const windowStart = now.getTime() - this.opts.windowMinutes * 60_000;
    const minCostMicro = Math.round(this.opts.minCostUsd * 1_000_000);
    const minSessions = this.opts.minPrincipalSessions ?? DEFAULT_MIN_PRINCIPAL_SESSIONS;
    const multiplier = this.opts.baselineMultiplier ?? DEFAULT_BASELINE_MULTIPLIER;
    const findings: RunawayFinding[] = [];
    for (const s of stats.sessions) {
      if (!isActive(s, windowStart)) continue;
      const key = sessionKey(s.workspaceId, s.session);
      const principal = s.principalId !== null ? stats.principals[s.principalId] : undefined;
      const usePrincipal = principal !== undefined && principal.sessions >= minSessions;
      const p95 = usePrincipal
        ? key === principal.topSessionKey
          ? principal.p95ExcludingTopMicroUsd
          : principal.p95MicroUsd
        : key === stats.org.topSessionKey
          ? stats.org.p95ExcludingTopMicroUsd
          : stats.org.p95MicroUsd;
      const orgP99 =
        key === stats.org.topSessionKey ? stats.org.p99ExcludingTopMicroUsd : stats.org.p99MicroUsd;
      const baseline = Math.round(multiplier * p95);
      const bar = Math.max(minCostMicro, baseline);
      if (s.costMicroUsd > bar && s.costMicroUsd > orgP99) {
        findings.push({
          session: s.session,
          workspaceId: s.workspaceId,
          orgId: s.orgId,
          principalId: s.principalId,
          costMicroUsd: s.costMicroUsd,
          baselineMicroUsd: baseline,
          orgP99MicroUsd: orgP99,
          baselineSource: usePrincipal ? 'principal' : 'org',
        });
      }
    }
    return findings;
  }

  /** One detector pass: score, then block/flag + audit + alert each new finding. */
  async tick(): Promise<RunawayTickResult> {
    const run = async (): Promise<RunawayTickResult> => {
      const now = this.deps.now?.() ?? new Date();
      this.prune(now);
      const from = new Date(now.getTime() - this.opts.baselineDays * 86_400_000);
      const stats = await this.deps.stats({ from, to: now });
      const windowStart = now.getTime() - this.opts.windowMinutes * 60_000;
      const evaluated = stats.sessions.filter((s) => isActive(s, windowStart)).length;
      const result: RunawayTickResult = { skipped: false, evaluated, runaway: [] };
      for (const f of this.evaluate(stats, now)) {
        const key = sessionKey(f.workspaceId, f.session);
        const until = this.alerted.get(key);
        if (until !== undefined && until > now.getTime()) continue;
        if (f.workspaceId !== null && (await this.deps.blocks.isBlocked(f.workspaceId, f.session)))
          continue; // already blocked (by a previous tick, a replica or an operator)
        const action = await this.act(f, now);
        this.alerted.set(key, now.getTime() + this.opts.blockTtlMinutes * 60_000);
        result.runaway.push({ ...f, action });
      }
      return result;
    };
    const r = this.deps.withLock ? await this.deps.withLock(run) : await run();
    return r ?? { skipped: true, evaluated: 0, runaway: [] };
  }

  private async act(f: RunawayFinding, now: Date): Promise<'blocked' | 'flagged'> {
    const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
    const reason = `runaway: ${usd(f.costMicroUsd)} exceeds baseline ${usd(f.baselineMicroUsd)} (${f.baselineSource} p95×2) and org p99 ${usd(f.orgP99MicroUsd)}`;
    // A session without a workspace cannot be keyed for the gateway kill switch.
    const action: 'blocked' | 'flagged' =
      this.opts.action === 'block' && f.workspaceId !== null ? 'blocked' : 'flagged';
    if (action === 'blocked') {
      await this.deps.blocks.block({
        workspaceId: f.workspaceId as string,
        session: f.session,
        reason,
        source: 'runaway',
        createdBy: 'runaway-detector',
        ttlSeconds: this.opts.blockTtlMinutes * 60,
      });
    }
    try {
      await this.deps.audit.append({
        orgId: f.orgId,
        actor: 'runaway-detector',
        action: 'session.runaway',
        target: f.session,
        payload: {
          session: f.session,
          workspaceId: f.workspaceId,
          principalId: f.principalId,
          costMicroUsd: f.costMicroUsd,
          baselineMicroUsd: f.baselineMicroUsd,
          baselineSource: f.baselineSource,
          orgP99MicroUsd: f.orgP99MicroUsd,
          action,
          ...(action === 'blocked' ? { blockTtlMinutes: this.opts.blockTtlMinutes } : {}),
        },
      });
    } catch (err) {
      this.deps.log?.warn({ err, session: f.session }, 'runaway audit append failed');
    }
    try {
      this.deps.alerts?.emit({
        kind: 'session.runaway',
        session: f.session,
        workspaceId: f.workspaceId ?? '',
        ...(f.principalId !== null ? { principalId: f.principalId } : {}),
        costMicroUsd: f.costMicroUsd,
        baselineMicroUsd: f.baselineMicroUsd,
        orgP99MicroUsd: f.orgP99MicroUsd,
        action,
        at: now.toISOString(),
        severity: action === 'blocked' ? 'critical' : 'warning',
      });
    } catch (err) {
      this.deps.log?.warn({ err, session: f.session }, 'runaway alert emit failed');
    }
    this.deps.log?.info(
      {
        session: f.session,
        workspaceId: f.workspaceId,
        principalId: f.principalId,
        costMicroUsd: f.costMicroUsd,
        baselineMicroUsd: f.baselineMicroUsd,
        orgP99MicroUsd: f.orgP99MicroUsd,
        action,
      },
      'runaway session',
    );
    return action;
  }

  private prune(now: Date): void {
    for (const [k, until] of this.alerted) if (until <= now.getTime()) this.alerted.delete(k);
  }
}

function isActive(s: SessionCost, windowStartMs: number): boolean {
  const last = Date.parse(s.lastAt);
  return Number.isFinite(last) && last >= windowStartMs;
}
