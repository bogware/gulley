import { type AlertSink, makeAlert } from '@gulley/alerts';
import type { AuditSink } from '@gulley/pipeline';
import type { KeyAdmin, KeyView } from './domain';

const DAY_MS = 86_400_000;

/** The actor stamped on the sweep's audit rows. */
export const KEY_EXPIRY_SWEEP_ACTOR = 'system:key-expiry-sweep';

export interface KeyExpirySweeperDeps {
  keys: Pick<KeyAdmin, 'listExpiring'>;
  audit: AuditSink;
  alerts: AlertSink;
  /** Resolve a workspace's org for the audit row (null when unknown). */
  orgIdOf: (workspaceId: string) => string | null;
  /** Notice window in days (ALERT_KEY_EXPIRY_DAYS). */
  withinDays: number;
  /** An already-expired key older than this is no longer news and is not announced —
   *  bounds the replay after a restart (the announced set is per process). Default 1 h;
   *  main.ts passes max(2 × sweep interval, 1 h). */
  expiredLookbackMs?: number;
  /** Fleet mutex (DB mode): run the sweep under the advisory lock; resolve `undefined`
   *  when another replica holds it. Absent (in-memory mode) = run unconditionally. */
  lock?: (fn: () => Promise<KeyExpirySweepResult>) => Promise<KeyExpirySweepResult | undefined>;
  now?: () => Date;
}

export interface KeyExpirySweepResult {
  /** Keys in the window (expiring soon + recently expired). */
  scanned: number;
  /** `key.expiring` notices emitted this run. */
  expiring: number;
  /** `key.expired` notices emitted this run. */
  expired: number;
  /** True when the run did nothing because another replica/run held the lock. */
  skipped: boolean;
}

/**
 * Periodic virtual-key expiry notices: `key.expiring` (+ audit `key.expiring_soon`)
 * once per key while it is inside the notice window, then `key.expired` (+ audit
 * `key.expired`) once it lapses. Disabled keys are ignored (revocation is already an
 * audited admin action).
 *
 * Idempotence is an in-process set keyed by (key id, expiresAt) — there is no
 * bookkeeping table in this version. Consequences, by design: a restart may repeat a
 * notice for a key still inside the window (bounded by the dispatcher's storm control
 * and `expiredLookbackMs`), and a rotated expiry re-announces. In DB mode the advisory
 * lock keeps a fleet to one announcer per tick; in-memory mode is single-process.
 */
export class KeyExpirySweeper {
  private readonly announced = new Map<string, 'expiring' | 'expired'>();
  private inFlight = false;

  constructor(private readonly deps: KeyExpirySweeperDeps) {}

  async sweep(): Promise<KeyExpirySweepResult> {
    if (this.inFlight) return { scanned: 0, expiring: 0, expired: 0, skipped: true };
    this.inFlight = true;
    try {
      const run = (): Promise<KeyExpirySweepResult> => this.run();
      if (this.deps.lock) {
        const r = await this.deps.lock(run);
        return r ?? { scanned: 0, expiring: 0, expired: 0, skipped: true };
      }
      return await run();
    } finally {
      this.inFlight = false;
    }
  }

  private async run(): Promise<KeyExpirySweepResult> {
    const now = (this.deps.now ?? (() => new Date()))();
    const nowMs = now.getTime();
    const horizon = new Date(nowMs + this.deps.withinDays * DAY_MS);
    const lookback = this.deps.expiredLookbackMs ?? 3_600_000;
    const rows = await this.deps.keys.listExpiring(horizon);
    const live = new Set<string>();
    let expiring = 0;
    let expired = 0;
    for (const key of rows) {
      if (!key.expiresAt) continue;
      const expiresMs = Date.parse(key.expiresAt);
      if (!Number.isFinite(expiresMs)) continue;
      const stateKey = `${key.id}@${key.expiresAt}`;
      if (expiresMs <= nowMs) {
        if (nowMs - expiresMs > lookback) continue; // long gone: not news
        live.add(stateKey);
        if (this.announced.get(stateKey) === 'expired') continue;
        await this.announceExpired(key, now);
        this.announced.set(stateKey, 'expired'); // after the audit row lands (at-least-once)
        expired += 1;
      } else {
        live.add(stateKey);
        if (this.announced.has(stateKey)) continue;
        const daysLeft = Math.max(1, Math.ceil((expiresMs - nowMs) / DAY_MS));
        await this.announceExpiring(key, daysLeft, now);
        this.announced.set(stateKey, 'expiring');
        expiring += 1;
      }
    }
    // Keys that left the window (deleted, disabled, rotated expiry, past the lookback)
    // drop out of the set so it stays bounded by the live window.
    for (const k of this.announced.keys()) if (!live.has(k)) this.announced.delete(k);
    return { scanned: rows.length, expiring, expired, skipped: false };
  }

  private async announceExpiring(key: KeyView, daysLeft: number, now: Date): Promise<void> {
    await this.deps.audit.append({
      orgId: this.deps.orgIdOf(key.workspaceId),
      actor: KEY_EXPIRY_SWEEP_ACTOR,
      action: 'key.expiring_soon',
      target: key.id,
      payload: {
        name: key.name,
        workspaceId: key.workspaceId,
        expiresAt: key.expiresAt,
        daysLeft,
      },
    });
    this.deps.alerts.emit(
      makeAlert(
        {
          kind: 'key.expiring',
          keyId: key.id,
          displayName: key.name,
          workspaceId: key.workspaceId,
          expiresAt: key.expiresAt as string,
          daysLeft,
        },
        () => now,
      ),
    );
  }

  private async announceExpired(key: KeyView, now: Date): Promise<void> {
    await this.deps.audit.append({
      orgId: this.deps.orgIdOf(key.workspaceId),
      actor: KEY_EXPIRY_SWEEP_ACTOR,
      action: 'key.expired',
      target: key.id,
      payload: { name: key.name, workspaceId: key.workspaceId, expiresAt: key.expiresAt },
    });
    this.deps.alerts.emit(
      makeAlert(
        {
          kind: 'key.expired',
          keyId: key.id,
          displayName: key.name,
          workspaceId: key.workspaceId,
          expiresAt: key.expiresAt as string,
        },
        () => now,
      ),
    );
  }
}
