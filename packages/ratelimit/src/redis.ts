import type { RateLimit, RateLimitOutcome, RateLimitStore, RuleDecision } from './types';
import { finalizeOutcome, resetSecondsUntil } from './util';

/** Minimal Redis surface (ioredis satisfies this) so this package needn't depend
 *  on ioredis directly — same shape used by `@gulley/budget`. */
export interface EvalRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomic multi-rule reserve. All rule counters share the `{scope}` hash slot so
// one script can touch them under Redis Cluster. Request-rule counters are only
// incremented when EVERY rule passes (all-or-nothing) so a later rejection never
// leaves an earlier rule over-counted. Token rules are checked but not charged
// here — their real cost is added at commit once the response is metered.
// ARGV: scope, nowMs, ruleCount, then [id, limit, windowSeconds, unit] per rule.
// Returns: [allowed, (used, limit, resetMs) per rule...].
const RESERVE_LUA = `
local scope = ARGV[1]
local now = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local idx = 4
local rules = {}
local allowed = 1
for r = 1, n do
  local id = ARGV[idx]
  local limit = tonumber(ARGV[idx + 1])
  local win = tonumber(ARGV[idx + 2]) * 1000
  local unit = ARGV[idx + 3]
  idx = idx + 4
  local wstart = math.floor(now / win) * win
  local key = 'ratelimit:{' .. scope .. '}:' .. id .. ':' .. wstart
  local cur = tonumber(redis.call('GET', key) or '0')
  local ok
  if unit == 'requests' then ok = (cur + 1 <= limit) else ok = (cur < limit) end
  if not ok then allowed = 0 end
  rules[r] = { key = key, cur = cur, limit = limit, win = win, unit = unit, reset = wstart + win }
end
local out = { allowed }
for r = 1, n do
  local c = rules[r]
  local used = c.cur
  if allowed == 1 and c.unit == 'requests' then
    used = redis.call('INCRBY', c.key, 1)
    redis.call('PEXPIRE', c.key, (c.reset - now) + 1000)
  end
  out[#out + 1] = used
  out[#out + 1] = c.limit
  out[#out + 1] = c.reset
end
return out
`;

// Add the metered token count to each token rule's current window.
// ARGV: scope, nowMs, actualTokens, ruleCount, then [id, windowSeconds] per token rule.
const COMMIT_LUA = `
local scope = ARGV[1]
local now = tonumber(ARGV[2])
local actual = tonumber(ARGV[3])
local n = tonumber(ARGV[4])
local idx = 5
for r = 1, n do
  local id = ARGV[idx]
  local win = tonumber(ARGV[idx + 1]) * 1000
  idx = idx + 2
  local wstart = math.floor(now / win) * win
  local key = 'ratelimit:{' .. scope .. '}:' .. id .. ':' .. wstart
  redis.call('INCRBY', key, actual)
  redis.call('PEXPIRE', key, (wstart + win - now) + 1000)
end
return 1
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: EvalRedis,
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(scope: string, rules: RateLimit[], _requestId: string): Promise<RateLimitOutcome> {
    if (rules.length === 0) return finalizeOutcome([]);
    const nowMs = this.now();
    const argv: (string | number)[] = [scope, String(nowMs), String(rules.length)];
    for (const r of rules) argv.push(r.id, String(r.limit), String(r.windowSeconds), r.unit);

    const res = (await this.redis.eval(RESERVE_LUA, 0, ...argv)) as number[];
    const allowed = res[0] === 1;
    const decisions: RuleDecision[] = rules.map((rule, i) => {
      const used = Number(res[1 + i * 3]);
      const limit = Number(res[2 + i * 3]);
      const resetMs = Number(res[3 + i * 3]);
      // When rejected nothing was incremented, so recompute per-rule admission.
      const ok =
        rule.unit === 'requests' ? (allowed ? used <= limit : used + 1 <= limit) : used < limit;
      return {
        rule,
        allowed: ok,
        used,
        remaining: Math.max(0, limit - used),
        resetSeconds: resetSecondsUntil(nowMs, resetMs),
      };
    });
    return finalizeOutcome(decisions);
  }

  async commit(
    scope: string,
    rules: RateLimit[],
    _requestId: string,
    actualTokens: number,
  ): Promise<void> {
    const tokenRules = rules.filter((r) => r.unit === 'tokens');
    if (tokenRules.length === 0 || actualTokens <= 0) return;
    const nowMs = this.now();
    const argv: (string | number)[] = [
      scope,
      String(nowMs),
      String(actualTokens),
      String(tokenRules.length),
    ];
    for (const r of tokenRules) argv.push(r.id, String(r.windowSeconds));
    await this.redis.eval(COMMIT_LUA, 0, ...argv);
  }
}
