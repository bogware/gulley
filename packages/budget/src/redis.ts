import { LuaScript, type ScriptRedis } from '@gulley/core';
import {
  type BudgetDecision,
  type BudgetStore,
  type BudgetWindow,
  type CapResolver,
  normalizeBudget,
} from './types';
import {
  type BudgetPeriod,
  isCalendar,
  parsePeriod,
  secondsUntilReset,
  windowEnd,
  windowId,
} from './window';

/** Minimal Redis surface (ioredis satisfies this) so this package needn't
 *  depend on ioredis directly. `evalsha` is optional (EVALSHA fast path). */
export type EvalRedis = ScriptRedis;

// Atomic reserve over EVERY window of a budget. KEYS = [reservedKey, committedKey_1 …
// committedKey_n]; ARGV = [worst, field, now, maxLifetime, n, cap_1, reservedTtl_1 …
// cap_n, reservedTtl_n]. Each reservation field holds "amount:expiryMs:ttlSeconds"
// (older rows may carry only "amount:expiryMs"); before checking the caps we SWEEP
// fields whose expiry has passed (a request that crashed between reserve and commit
// would otherwise strand its worst-case forever), rebuild the authoritative __total
// from the live fields, then reserve if it fits every window. Returns
// {allowed, bindingIndex (1-based), usedBinding, capBinding}: on a rejection the window
// that rejected, otherwise the window with the highest utilization after the reserve.
const RESERVE_LUA = new LuaScript(`
local reservedKey = KEYS[1]
local worst = tonumber(ARGV[1])
local field = ARGV[2]
local now = tonumber(ARGV[3])
local maxLifetime = tonumber(ARGV[4])
local n = tonumber(ARGV[5])
local all = redis.call('HGETALL', reservedKey)
local reserved = 0
for i = 1, #all, 2 do
  local k = all[i]
  local v = all[i + 1]
  if k ~= '__total' then
    local sep = string.find(v, ':')
    if sep then
      local amt = tonumber(string.sub(v, 1, sep - 1))
      local rest = string.sub(v, sep + 1)
      local sep2 = string.find(rest, ':')
      local exp = tonumber(sep2 and string.sub(rest, 1, sep2 - 1) or rest)
      if exp and exp <= now then
        redis.call('HDEL', reservedKey, k)
      else
        reserved = reserved + (amt or 0)
      end
    else
      redis.call('HDEL', reservedKey, k)
    end
  end
end
local bestIdx = 1
local bestUsed = 0
local bestCap = 1
local bestRatio = -1
local maxTtl = 0
for i = 1, n do
  local cap = tonumber(ARGV[4 + i * 2])
  local ttl = tonumber(ARGV[5 + i * 2])
  if ttl > maxTtl then maxTtl = ttl end
  local committed = tonumber(redis.call('GET', KEYS[1 + i]) or '0')
  local used = reserved + committed
  if used + worst > cap then
    redis.call('HSET', reservedKey, '__total', reserved)
    return {0, i, used, cap}
  end
  local ratio = (used + worst) / cap
  if ratio > bestRatio then
    bestRatio = ratio
    bestIdx = i
    bestUsed = used + worst
    bestCap = cap
  end
end
local ttlField = maxTtl
if ttlField <= 0 then ttlField = 0 end
redis.call('HSET', reservedKey, field, worst .. ':' .. (now + maxLifetime) .. ':' .. ttlField)
redis.call('HSET', reservedKey, '__total', reserved + worst)
if maxTtl > 0 then redis.call('EXPIRE', reservedKey, maxTtl) end
return {1, bestIdx, bestUsed, bestCap}
`);

// Atomic commit: release the reservation, add the actual spend to EVERY window counter.
// KEYS = [reservedKey, commitIdKey, committedKey_1 … committedKey_n];
// ARGV = [field, actual, dedupTtl, n, mode_1, ttl_1 … mode_n, ttl_n] where mode is
// 'calendar' (counter expires `ttl` seconds after the window resets — set on every
// commit, cheap), 'fixed' (the pre-0.7 window: TTL set when the key is first created,
// so the window starts at first spend), 'none' (lifetime: PERSIST), or 'keep' (the
// window is UNKNOWN — a commit with no reserve-time layout and no resolver: credit the
// spend, never touch the key's TTL). Ordering + guards matter:
//  * the spend is added BEFORE the reservation bookkeeping, so a fault in the
//    __total arithmetic can never drop real spend;
//  * `HINCRBY … -0` is skipped — Redis 7.0 rejects the "-0" Lua renders for a
//    negative zero, which aborted the script (spend silently never committed)
//    whenever the reservation field was already gone (expired / swept / failover);
//  * a $0 commit against an ABSENT counter (a rollback) does not create the key, so
//    it neither starts a budget window nor blocks the boot-time heal;
//  * a period change is applied to a live key (lifetime→periodic gets its TTL,
//    periodic→lifetime is PERSISTed) instead of only on first creation.
//  * Idempotency: a resent commit (ioredis auto-retries a command whose reply was lost
//    after the script already ran server-side) must not double-count. The token is ONE
//    self-expiring key per request id (SET NX EX): created only the FIRST time this
//    request id commits to this scope, so a resend finds it and skips the INCRBY. It is
//    NOT the reservation field (deleted on first commit), so a swept-then-committed
//    request still records exactly once. A per-request key keeps the footprint BOUNDED.
const COMMIT_LUA = new LuaScript(`
local reservedKey = KEYS[1]
local commitIdKey = KEYS[2]
local field = ARGV[1]
local actual = tonumber(ARGV[2])
local dedupTtl = tonumber(ARGV[3])
local n = tonumber(ARGV[4])
if dedupTtl < 1 then dedupTtl = 1 end
local fresh = 0
if redis.call('SET', commitIdKey, '1', 'NX', 'EX', dedupTtl) then fresh = 1 end
local raw = redis.call('HGET', reservedKey, field)
local worst = 0
if raw then
  local sep = string.find(raw, ':')
  if sep then
    worst = tonumber(string.sub(raw, 1, sep - 1)) or 0
  else
    worst = tonumber(raw) or 0
  end
end
local maxTtl = 0
for i = 1, n do
  local committedKey = KEYS[2 + i]
  local mode = ARGV[3 + i * 2]
  local ttl = tonumber(ARGV[4 + i * 2])
  if ttl > maxTtl then maxTtl = ttl end
  local existed = redis.call('EXISTS', committedKey)
  if fresh == 1 and (actual > 0 or existed == 1) then
    redis.call('INCRBY', committedKey, actual)
  end
  if redis.call('EXISTS', committedKey) == 1 then
    if mode == 'calendar' then
      redis.call('EXPIRE', committedKey, ttl)
    elseif mode == 'fixed' then
      if redis.call('TTL', committedKey) == -1 then redis.call('EXPIRE', committedKey, ttl) end
    elseif mode == 'none' then
      if redis.call('TTL', committedKey) > 0 then redis.call('PERSIST', committedKey) end
    end
  end
end
if raw then
  redis.call('HDEL', reservedKey, field)
  if worst > 0 then redis.call('HINCRBY', reservedKey, '__total', -worst) end
end
if maxTtl > 0 and redis.call('EXISTS', reservedKey) == 1 then
  redis.call('EXPIRE', reservedKey, maxTtl)
end
return 1
`);

// Re-stamp a live reservation's expiry (amount + period unchanged) so a long stream
// isn't reaped by the RESERVE sweep. Idempotent; a no-op if the field is already gone
// (committed/expired). Does not touch __total (the reserved amount is unchanged).
const REFRESH_LUA = new LuaScript(`
local reservedKey = KEYS[1]
local field = ARGV[1]
local newExp = ARGV[2]
local raw = redis.call('HGET', reservedKey, field)
if not raw then return 0 end
local sep = string.find(raw, ':')
local amt = raw
local ttlPart = ''
if sep then
  amt = string.sub(raw, 1, sep - 1)
  local rest = string.sub(raw, sep + 1)
  local sep2 = string.find(rest, ':')
  if sep2 then ttlPart = ':' .. string.sub(rest, sep2 + 1) end
end
redis.call('HSET', reservedKey, field, amt .. ':' .. newExp .. ttlPart)
return 1
`);

// Self-heal a LOST committed counter from the durable ledger. A live counter is
// AUTHORITATIVE for its window and is never overwritten: the ledger sum is taken
// over a window that may include prior-window spend and would OVER-enforce a healthy
// counter. So this only rebuilds an ABSENT counter (a counters-Redis flush, where
// committed was reset to 0) — flush recovery, not an every-boot rewrite. Raise-only:
// a heal can only restore enforcement, never weaken it.
const HEAL_LUA = new LuaScript(`
local committedKey = KEYS[1]
local ledgerSum = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
if redis.call('EXISTS', committedKey) == 1 then
  return {0, tonumber(redis.call('GET', committedKey) or '0')}
end
if ledgerSum > 0 then
  redis.call('SET', committedKey, ledgerSum)
  if ttl > 0 then redis.call('EXPIRE', committedKey, ttl) end
  return {1, ledgerSum}
end
return {0, 0}
`);

/** Keep an expired calendar counter around this long after its window resets so a
 *  late commit / reveal still lands in the right window. */
const CALENDAR_GRACE_SECONDS = 7 * 86_400;

/** The counters a reservation was admitted against, remembered in-process from reserve
 *  to commit (both run on the replica that serves the request). */
interface ReserveLayout {
  windows: Array<{ key: string; mode: string; ttl: number }>;
  at: number;
}

/** Upper bound on remembered layouts (one per in-flight reservation; pruned by age). */
const MAX_LAYOUTS = 100_000;

export class RedisBudgetStore implements BudgetStore {
  /** reserve-time window layout per `scope\0requestId`, consumed by commit. */
  private readonly layouts = new Map<string, ReserveLayout>();

  constructor(
    private readonly redis: EvalRedis,
    private readonly capFor: CapResolver,
    /** Max lifetime of a reservation before it is swept as orphaned (ms). */
    private readonly maxReservationLifetimeMs = 600_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private reservedKey(scope: string): string {
    // Hash-tag keeps every key of a scope in one slot (Redis Cluster), so one Lua
    // script can touch all of a scope's window counters atomically.
    return `budget:{${scope}}:reserved`;
  }

  /** The committed counter for a window: calendar windows get their own key per
   *  window id; lifetime and fixed windows share the pre-0.7 key. */
  private committedKey(scope: string, period: BudgetPeriod, nowMs: number): string {
    return isCalendar(period)
      ? `budget:{${scope}}:committed:${windowId(period, nowMs)}`
      : `budget:{${scope}}:committed`;
  }

  /** TTL to stamp on a window's counter at commit time. */
  private commitTtl(period: BudgetPeriod, nowMs: number): { mode: string; ttl: number } {
    if (isCalendar(period)) {
      return { mode: 'calendar', ttl: secondsUntilReset(period, nowMs) + CALENDAR_GRACE_SECONDS };
    }
    if (period.kind === 'fixed') return { mode: 'fixed', ttl: period.seconds };
    return { mode: 'none', ttl: 0 };
  }

  /** TTL for the reserved hash: the longest window; 0 = no expiry (lifetime). */
  private reservedTtl(period: BudgetPeriod, nowMs: number): number {
    return this.commitTtl(period, nowMs).ttl;
  }

  async reserve(
    scope: string,
    requestId: string,
    worstCaseMicroUsd: number,
  ): Promise<BudgetDecision | null> {
    const budget = await this.capFor(scope);
    if (!budget) return null;
    const spec = normalizeBudget(budget);
    const nowMs = this.now();
    const keys = [
      this.reservedKey(scope),
      ...spec.windows.map((w) => this.committedKey(scope, w.period, nowMs)),
    ];
    const args: string[] = [
      String(worstCaseMicroUsd),
      requestId,
      String(nowMs),
      String(this.maxReservationLifetimeMs),
      String(spec.windows.length),
    ];
    for (const w of spec.windows) {
      args.push(String(w.capMicroUsd), String(this.reservedTtl(w.period, nowMs)));
    }
    const res = (await RESERVE_LUA.run(this.redis, keys.length, ...keys, ...args)) as [
      number,
      number,
      number,
      number,
    ];
    const w = spec.windows[res[1] - 1] as BudgetWindow;
    if (res[0] === 1) {
      // Remember the exact counters this reservation was admitted against: commit
      // credits THOSE (the window the request was admitted in), independent of the cap
      // resolver — a resolver outage at commit time used to drop the spend into a
      // lifetime key that calendar admission never reads (a cap under-enforced by every
      // such commit) and PERSIST a fixed-window counter (spurious 402s after).
      this.remember(scope, requestId, {
        windows: spec.windows.map((win) => ({
          key: this.committedKey(scope, win.period, nowMs),
          ...this.commitTtl(win.period, nowMs),
        })),
        at: nowMs,
      });
    }
    return {
      allowed: res[0] === 1,
      capMicroUsd: res[3],
      usedMicroUsd: res[2],
      window: isCalendar(w.period)
        ? { period: w.period, resetsAtMs: windowEnd(w.period, nowMs) }
        : { period: w.period },
    };
  }

  /** Push a live reservation's expiry to now + maxReservationLifetimeMs. Cheap; call
   *  it throttled (never per-chunk) from the stream path so a legitimately long stream
   *  is never mistaken for an orphan and swept while still in flight. */
  async refresh(scope: string, requestId: string): Promise<void> {
    await REFRESH_LUA.run(
      this.redis,
      1,
      this.reservedKey(scope),
      requestId,
      String(this.now() + this.maxReservationLifetimeMs),
    );
  }

  private remember(scope: string, requestId: string, layout: ReserveLayout): void {
    if (this.layouts.size >= MAX_LAYOUTS) {
      // Prune by age (insertion order = reserve order): anything past the reservation
      // lifetime was swept server-side and will never be committed from here.
      const horizon = layout.at - this.maxReservationLifetimeMs;
      for (const [k, v] of this.layouts) {
        if (v.at > horizon && this.layouts.size < MAX_LAYOUTS) break;
        this.layouts.delete(k);
      }
    }
    this.layouts.set(`${scope}\u0000${requestId}`, layout);
  }

  /** The counters a commit credits, in order of trust: the reserve-time layout (what
   *  the request was admitted against); else the resolver's current windows (a commit
   *  for a reservation this replica did not take — a rollback after failover, a heal);
   *  else — resolver down AND no layout — the shared lifetime key in `keep` mode, which
   *  credits the spend without touching any TTL. A resolver failure never blocks the
   *  commit (a Postgres blip used to strand every in-flight reservation until the
   *  orphan sweep), and it never changes WHERE the spend lands for a known reservation. */
  private async commitLayout(
    scope: string,
    requestId: string,
    nowMs: number,
  ): Promise<ReserveLayout['windows']> {
    const key = `${scope}\u0000${requestId}`;
    const remembered = this.layouts.get(key);
    if (remembered) {
      this.layouts.delete(key);
      return remembered.windows;
    }
    try {
      const budget = await this.capFor(scope);
      if (budget) {
        return normalizeBudget(budget).windows.map((w) => ({
          key: this.committedKey(scope, w.period, nowMs),
          ...this.commitTtl(w.period, nowMs),
        }));
      }
    } catch {
      /* resolver down: fall through */
    }
    return [{ key: this.committedKey(scope, { kind: 'none' }, nowMs), mode: 'keep', ttl: 0 }];
  }

  async commit(scope: string, requestId: string, actualMicroUsd: number): Promise<void> {
    const nowMs = this.now();
    const windows = await this.commitLayout(scope, requestId, nowMs);
    // One self-expiring idempotency key PER request (never a shared, ever-growing set);
    // same {scope} hash-tag slot as the other keys (Redis Cluster).
    const commitIdKey = `budget:{${scope}}:cid:${requestId}`;
    // Dedup window: a lost-reply retry lands within seconds, so the reservation lifetime is
    // an ample TTL for the per-request idempotency key (which then expires on its own).
    const dedupTtl = Math.max(1, Math.ceil(this.maxReservationLifetimeMs / 1000));
    const keys = [this.reservedKey(scope), commitIdKey, ...windows.map((w) => w.key)];
    const args: string[] = [
      requestId,
      String(Math.max(0, Math.round(actualMicroUsd))),
      String(dedupTtl),
      String(windows.length),
    ];
    for (const w of windows) args.push(w.mode, String(w.ttl));
    await COMMIT_LUA.run(this.redis, keys.length, ...keys, ...args);
  }

  async healCommitted(
    scope: string,
    ledgerMicroUsd: number,
    period: number | BudgetPeriod,
  ): Promise<{ healed: boolean; committedMicroUsd: number }> {
    const nowMs = this.now();
    const p: BudgetPeriod =
      typeof period === 'number' ? (parsePeriod(period) ?? { kind: 'none' }) : period;
    const key = this.committedKey(scope, p, nowMs);
    const res = (await HEAL_LUA.run(
      this.redis,
      1,
      key,
      String(Math.max(0, Math.round(ledgerMicroUsd))),
      String(this.commitTtl(p, nowMs).ttl),
    )) as [number, number];
    return { healed: res[0] === 1, committedMicroUsd: res[1] };
  }
}
