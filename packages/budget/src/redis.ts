import type { BudgetDecision, BudgetStore, CapResolver } from './types';

/** Minimal Redis surface (ioredis satisfies this) so this package needn't
 *  depend on ioredis directly. */
export interface EvalRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomic reserve: reject if reserved+committed+worst would breach the cap.
const RESERVE_LUA = `
local reservedKey = KEYS[1]
local committedKey = KEYS[2]
local cap = tonumber(ARGV[1])
local worst = tonumber(ARGV[2])
local field = ARGV[3]
local ttl = tonumber(ARGV[4])
local reserved = tonumber(redis.call('HGET', reservedKey, '__total') or '0')
local committed = tonumber(redis.call('GET', committedKey) or '0')
if reserved + committed + worst > cap then
  return {0, reserved + committed}
end
redis.call('HSET', reservedKey, field, worst)
redis.call('HINCRBY', reservedKey, '__total', worst)
if ttl > 0 then redis.call('EXPIRE', reservedKey, ttl) end
return {1, reserved + committed + worst}
`;

// Atomic commit: release the reservation, add the actual spend (refund = diff).
const COMMIT_LUA = `
local reservedKey = KEYS[1]
local committedKey = KEYS[2]
local field = ARGV[1]
local actual = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local worst = tonumber(redis.call('HGET', reservedKey, field) or '0')
redis.call('HDEL', reservedKey, field)
redis.call('HINCRBY', reservedKey, '__total', -worst)
redis.call('INCRBY', committedKey, actual)
if ttl > 0 then redis.call('EXPIRE', committedKey, ttl); redis.call('EXPIRE', reservedKey, ttl) end
return redis.call('GET', committedKey)
`;

export class RedisBudgetStore implements BudgetStore {
  constructor(
    private readonly redis: EvalRedis,
    private readonly capFor: CapResolver,
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
    )) as [number, number];
    return { allowed: res[0] === 1, capMicroUsd: budget.capMicroUsd, usedMicroUsd: res[1] };
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
}
