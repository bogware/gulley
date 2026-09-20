import { LuaScript, type ScriptRedis } from '@gulley/core';
import type { BudgetDecision, BudgetStore, CapResolver } from './types';

/** Minimal Redis surface (ioredis satisfies this) so this package needn't
 *  depend on ioredis directly. `evalsha` is optional (EVALSHA fast path). */
export type EvalRedis = ScriptRedis;

// Atomic reserve. Each reservation field holds "amount:expiryMs:ttlSeconds" (older
// rows may carry only "amount:expiryMs"); before checking the cap we SWEEP fields
// whose expiry has passed (a request that crashed between reserve and commit would
// otherwise strand its worst-case forever), rebuild the authoritative __total from
// the live fields, then reserve if it still fits. The period (ttl) rides on the
// field so commit needs no resolver round-trip to know the window length.
const RESERVE_LUA = new LuaScript(`
local reservedKey = KEYS[1]
local committedKey = KEYS[2]
local cap = tonumber(ARGV[1])
local worst = tonumber(ARGV[2])
local field = ARGV[3]
local ttl = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local maxLifetime = tonumber(ARGV[6])
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
local committed = tonumber(redis.call('GET', committedKey) or '0')
if reserved + committed + worst > cap then
  redis.call('HSET', reservedKey, '__total', reserved)
  return {0, reserved + committed}
end
redis.call('HSET', reservedKey, field, worst .. ':' .. (now + maxLifetime) .. ':' .. ttl)
redis.call('HSET', reservedKey, '__total', reserved + worst)
if ttl > 0 then redis.call('EXPIRE', reservedKey, ttl) end
return {1, reserved + committed + worst}
`);

// Atomic commit: release the reservation, add the actual spend. The committed
// counter's TTL is set when the key is first created, so the budget period is a
// fixed window from first spend — not an idle-timeout that never rolls over under
// continuous traffic. Ordering + guards matter:
//  * the spend is added BEFORE the reservation bookkeeping, so a fault in the
//    __total arithmetic can never drop real spend;
//  * `HINCRBY … -0` is skipped — Redis 7.0 rejects the "-0" Lua renders for a
//    negative zero, which aborted the script (spend silently never committed)
//    whenever the reservation field was already gone (expired / swept / failover);
//  * a $0 commit against an ABSENT counter (a rollback) does not create the key, so
//    it neither starts a budget window nor blocks the boot-time heal;
//  * a period change is applied to a live key (lifetime→periodic gets its TTL,
//    periodic→lifetime is PERSISTed) instead of only on first creation.
const COMMIT_LUA = new LuaScript(`
local reservedKey = KEYS[1]
local committedKey = KEYS[2]
local field = ARGV[1]
local actual = tonumber(ARGV[2])
local ttlArg = tonumber(ARGV[3])
local raw = redis.call('HGET', reservedKey, field)
local worst = 0
local ttl = ttlArg or 0
if raw then
  local sep = string.find(raw, ':')
  if sep then
    worst = tonumber(string.sub(raw, 1, sep - 1)) or 0
    local rest = string.sub(raw, sep + 1)
    local sep2 = string.find(rest, ':')
    if sep2 then
      local fieldTtl = tonumber(string.sub(rest, sep2 + 1))
      if fieldTtl and ttlArg == nil then ttl = fieldTtl end
    end
  else
    worst = tonumber(raw) or 0
  end
end
local existed = redis.call('EXISTS', committedKey)
if actual > 0 or existed == 1 then
  redis.call('INCRBY', committedKey, actual)
end
if raw then
  redis.call('HDEL', reservedKey, field)
  if worst > 0 then redis.call('HINCRBY', reservedKey, '__total', -worst) end
end
if ttl > 0 then
  local remaining = redis.call('TTL', committedKey)
  if remaining == -1 then redis.call('EXPIRE', committedKey, ttl) end
  if redis.call('EXISTS', reservedKey) == 1 then redis.call('EXPIRE', reservedKey, ttl) end
elseif ttlArg == 0 then
  if redis.call('TTL', committedKey) > 0 then redis.call('PERSIST', committedKey) end
end
return redis.call('GET', committedKey) or '0'
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
// AUTHORITATIVE for its fixed window and is never overwritten: the ledger sum is
// taken over a sliding window that would include prior-window spend and thus
// OVER-enforce a healthy counter. So this only rebuilds an ABSENT counter (a
// counters-Redis flush, where committed was reset to 0) — flush recovery, not an
// every-boot rewrite. On rebuild it seeds the ledger sum and a fresh window TTL
// (the original window start isn't durable; the sliding sum is a conservative,
// never-under-enforcing approximation). Raise-only: a heal can only restore
// enforcement, never weaken it.
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

export class RedisBudgetStore implements BudgetStore {
  constructor(
    private readonly redis: EvalRedis,
    private readonly capFor: CapResolver,
    /** Max lifetime of a reservation before it is swept as orphaned (ms). */
    private readonly maxReservationLifetimeMs = 600_000,
  ) {}

  private keys(workspaceId: string): [string, string] {
    // Hash-tag keeps both keys in one slot (Redis Cluster).
    return [`budget:{${workspaceId}}:reserved`, `budget:{${workspaceId}}:committed`];
  }

  async reserve(
    workspaceId: string,
    requestId: string,
    worstCaseMicroUsd: number,
  ): Promise<BudgetDecision | null> {
    const budget = await this.capFor(workspaceId);
    if (!budget) return null;
    const [reservedKey, committedKey] = this.keys(workspaceId);
    const ttl = budget.periodSeconds ?? 0;
    const res = (await RESERVE_LUA.run(
      this.redis,
      2,
      reservedKey,
      committedKey,
      String(budget.capMicroUsd),
      String(worstCaseMicroUsd),
      requestId,
      String(ttl),
      String(Date.now()),
      String(this.maxReservationLifetimeMs),
    )) as [number, number];
    return { allowed: res[0] === 1, capMicroUsd: budget.capMicroUsd, usedMicroUsd: res[1] };
  }

  /** Push a live reservation's expiry to now + maxReservationLifetimeMs. Cheap; call
   *  it throttled (never per-chunk) from the stream path so a legitimately long stream
   *  is never mistaken for an orphan and swept while still in flight. */
  async refresh(workspaceId: string, requestId: string): Promise<void> {
    const [reservedKey] = this.keys(workspaceId);
    await REFRESH_LUA.run(
      this.redis,
      1,
      reservedKey,
      requestId,
      String(Date.now() + this.maxReservationLifetimeMs),
    );
  }

  /** The period is read from the reservation field written at reserve time; the
   *  resolver is consulted only as a fallback (a period change since reserve, or a
   *  reservation already swept) and its failure never blocks the commit — a Postgres
   *  blip used to strand every in-flight reservation until the orphan sweep. */
  async commit(workspaceId: string, requestId: string, actualMicroUsd: number): Promise<void> {
    const [reservedKey, committedKey] = this.keys(workspaceId);
    let ttlArg = '';
    try {
      const budget = await this.capFor(workspaceId);
      if (budget) ttlArg = String(budget.periodSeconds ?? 0);
    } catch {
      /* fall back to the period carried on the reservation field */
    }
    await COMMIT_LUA.run(
      this.redis,
      2,
      reservedKey,
      committedKey,
      requestId,
      String(Math.max(0, Math.round(actualMicroUsd))),
      ttlArg,
    );
  }

  async healCommitted(
    workspaceId: string,
    ledgerMicroUsd: number,
    periodSeconds: number,
  ): Promise<{ healed: boolean; committedMicroUsd: number }> {
    const [, committedKey] = this.keys(workspaceId);
    const res = (await HEAL_LUA.run(
      this.redis,
      1,
      committedKey,
      String(Math.max(0, Math.round(ledgerMicroUsd))),
      String(periodSeconds),
    )) as [number, number];
    return { healed: res[0] === 1, committedMicroUsd: res[1] };
  }
}
