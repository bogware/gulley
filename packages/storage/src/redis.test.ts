import { afterEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisClient } from './redis';

// Point at a closed port; lazyConnect means nothing connects until first command,
// so these tests exercise ONLY the error-handling wiring, never a live Redis.
const DEAD_URL = 'redis://127.0.0.1:1';

describe('createRedisClient', () => {
  const clients: Redis[] = [];
  afterEach(() => {
    for (const c of clients.splice(0)) c.disconnect();
  });

  it('does not throw when the client emits a connection error (no uncaught crash)', () => {
    const client = createRedisClient(DEAD_URL);
    clients.push(client);
    // An ioredis client is an EventEmitter that THROWS on an 'error' event with no
    // listener — that would surface as a process-fatal uncaughtException. The factory
    // must attach a swallowing listener so a Redis blip degrades, never crashes.
    expect(() => client.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
  });

  it('routes connection errors to the injected logger (throttled)', () => {
    const seen: Error[] = [];
    const client = createRedisClient(DEAD_URL, (err) => seen.push(err));
    clients.push(client);
    client.emit('error', new Error('boom-1'));
    client.emit('error', new Error('boom-2')); // within the throttle window
    expect(seen).toHaveLength(1); // second is throttled, not lost-and-crashing
    expect(seen[0]?.message).toBe('boom-1');
  });
});
