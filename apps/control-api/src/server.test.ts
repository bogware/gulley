import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { buildServer } from './server';

describe('control-api server', () => {
  it('responds ok on /health', async () => {
    const app = buildServer(
      loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv),
    );
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'control-api' });
    await app.close();
  });
});
