import type { BudgetDecision, BudgetStore, CapResolver } from './types';

/** Minimal Redis surface (ioredis satisfies this) so this package needn't
 *  depend on ioredis directly. */
export interface EvalRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomic reserve. Each reservation field holds "amount:expiryMs"; before checking
// the cap we SWEEP fields whose expiry has passed (a request that crashed between
// reserve and commit would otherwise strand its worst-case forever), rebuild the
// authoritative __total from the live fields, then reserve if it still fits.
const RESERVE_LUA = `
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
      local exp = tonumber(string.sub(v, sep + 1))
      if exp and exp <= now then
        redis.call('HDEL', reservedKey, k)
      else
        reserved = reserved + amt
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
redis.call('HSET', reservedKey, field, worst .. ':' .. (now + maxLifetime))
redis.call('HSET', reservedKey, '__total', reserved + worst)
if ttl > 0 then redis.call('EXPIRE', reservedKey, ttl) end
return {1, reserved + committed + worst}
`;

// Atomic commit: release the reservation, add the actual spend. The committed
// counter's TTL is set only when the key is first created, so the budget period
// is a fixed window from first spend — not an idle-timeout that never rolls over
// under continuous traffic.
const COMMIT_LUA = `
local reservedKey = KEYS[1]
local committedKey = KEYS[2]
local field = ARGV[1]
local actual = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local raw = redis.call('HGET', reservedKey, field)
local worst = 0
if raw then
  local sep = string.find(raw, ':')
  if sep then worst = tonumber(string.sub(raw, 1, sep - 1)) else worst = tonumber(raw) or 0 end
end
redis.call('HDEL', reservedKey, field)
redis.call('HINCRBY', reservedKey, '__total', -worst)
local existed = redis.call('EXISTS', committedKey)
redis.call('INCRBY', committedKey, actual)
if ttl > 0 then
  if existed == 0 then redis.call('EXPIRE', committedKey, ttl) end
  redis.call('EXPIRE', reservedKey, ttl)
end
return redis.call('GET', committedKey)
`;

// Re-stamp a live reservation's expiry (amount unchanged) so a long stream isn't
// reaped by the RESERVE sweep. Idempotent; a no-op if the field is already gone
// (committed/expired). Does not touch __total (the reserved amount is unchanged).
const REFRESH_LUA = `
local reservedKey = KEYS[1]
local field = ARGV[1]
local newExp = ARGV[2]
local raw = redis.call('HGET', reservedKey, field)
if not raw then return 0 end
local sep = string.find(raw, ':')
local amt = raw
if sep then amt = string.sub(raw, 1, sep - 1) end
redis.call('HSET', reservedKey, field, amt .. ':' .. newExp)
return 1
`;

// Self-heal a LOST committed counter from the durable ledger. A live counter is
// AUTHORITATIVE for its fixed window and is never overwritten: the ledger sum is
// taken over a sliding window that would include prior-window spend and thus
// OVER-enforce a healthy counter. So this only rebuilds an ABSENT counter (a
// counters-Redis flush, where committed was reset to 0) — flush recovery, not an
// every-boot rewrite. On rebuild it seeds the ledger sum and a fresh window TTL
// (the original window start isn't durable; the sliding sum is a conservative,
// never-under-enforcing approximation). Raise-only: a heal can only restore
// enforcement, never weaken it.
const HEAL_LUA = `
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
`;

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
    const res = (await this.redis.eval(
      RESERVE_LUA,
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
    await this.redis.eval(
      REFRESH_LUA,
      1,
      reservedKey,
      requestId,
      String(Date.now() + this.maxReservationLifetimeMs),
    );
  }

  async commit(workspaceId: string, requestId: string, actualMicroUsd: number): Promise<void> {
    const budget = await this.capFor(workspaceId);
    const [reservedKey, committedKey] = this.keys(workspaceId);
    const ttl = budget?.periodSeconds ?? 0;
    await this.redis.eval(
      COMMIT_LUA,
      2,
      reservedKey,
      committedKey,
      requestId,
      String(actualMicroUsd),
      String(ttl),
    );
  }

  async healCommitted(
    workspaceId: string,
    ledgerMicroUsd: number,
    periodSeconds: number,
  ): Promise<{ healed: boolean; committedMicroUsd: number }> {
    const [, committedKey] = this.keys(workspaceId);
    const res = (await this.redis.eval(
      HEAL_LUA,
      1,
      committedKey,
      String(Math.max(0, Math.round(ledgerMicroUsd))),
      String(periodSeconds),
    )) as [number, number];
    return { healed: res[0] === 1, committedMicroUsd: res[1] };
  }
}
