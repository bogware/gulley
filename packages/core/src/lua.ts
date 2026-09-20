import { createHash } from 'node:crypto';

/** The subset of ioredis the Lua helpers need. `evalsha` is optional so a test fake
 *  that only implements `eval` keeps working. */
export interface ScriptRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  evalsha?(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * A Redis Lua script run via EVALSHA with a transparent EVAL fallback on NOSCRIPT, so
 * the hot path ships a 40-byte digest per call instead of the whole script body
 * (~1-2 KB per reserve/commit). The script is (re)loaded implicitly by the EVAL
 * fallback after a Redis restart/flush, and any other error propagates unchanged.
 */
export class LuaScript {
  readonly sha: string;
  constructor(readonly body: string) {
    this.sha = createHash('sha1').update(body).digest('hex');
  }

  async run(redis: ScriptRedis, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (!redis.evalsha) return redis.eval(this.body, numKeys, ...args);
    try {
      return await redis.evalsha(this.sha, numKeys, ...args);
    } catch (err) {
      if (!/NOSCRIPT/i.test((err as Error).message ?? '')) throw err;
      return redis.eval(this.body, numKeys, ...args);
    }
  }
}
