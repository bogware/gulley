import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { type DoctorFinding, runDoctor } from './doctor';

const cfg = (env: Record<string, string>): ReturnType<typeof loadConfig> =>
  loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env } as NodeJS.ProcessEnv);

const find = (fs: DoctorFinding[], check: string): DoctorFinding | undefined =>
  fs.find((f) => f.check === check);

describe('gulley doctor', () => {
  it('errors when an env-config gateway has no route source', () => {
    const fs = runDoctor(cfg({ CONFIG_SOURCE: 'env' }));
    expect(find(fs, 'providers')?.level).toBe('error');
  });

  it('passes providers when an upstream key is present', () => {
    const fs = runDoctor(cfg({ ANTHROPIC_UPSTREAM_API_KEY: 'sk-x' }));
    expect(find(fs, 'providers')?.level).toBe('ok');
  });

  it('errors when CONFIG_SOURCE=db without a DATABASE_URL', () => {
    const fs = runDoctor(cfg({ CONFIG_SOURCE: 'db', ANTHROPIC_UPSTREAM_API_KEY: 'sk-x' }));
    expect(find(fs, 'config-source')?.level).toBe('error');
  });

  it('warns when a DB is set but config is read from env', () => {
    const fs = runDoctor(
      cfg({ DATABASE_URL: 'postgres://x/y', ANTHROPIC_UPSTREAM_API_KEY: 'sk-x' }),
    );
    expect(find(fs, 'config-source')?.level).toBe('warn');
  });

  it('flags the pgvector/exact-backend FK footgun', () => {
    const fs = runDoctor(
      cfg({
        ANTHROPIC_UPSTREAM_API_KEY: 'sk-x',
        CACHE_ENABLED: 'true',
        CACHE_SEMANTIC_ENABLED: 'true',
        EMBEDDINGS_API_KEY: 'sk-e',
        CACHE_VECTOR_BACKEND: 'pgvector',
        CACHE_EXACT_BACKEND: 'memory',
      }),
    );
    expect(find(fs, 'cache-backends')?.level).toBe('error');
  });

  it('errors on prod mask-vault persistence without KMS', () => {
    const fs = runDoctor(
      loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: 'silent',
        ANTHROPIC_UPSTREAM_API_KEY: 'sk-x',
        MASK_VAULT_PERSIST: 'true',
      } as NodeJS.ProcessEnv),
    );
    expect(find(fs, 'mask-vault')?.level).toBe('error');
  });

  it('warns on a CEL rule with a bare trustProxy=true', () => {
    const fs = runDoctor(
      cfg({
        ANTHROPIC_UPSTREAM_API_KEY: 'sk-x',
        TRUST_PROXY: 'true',
        CEL_AUTHZ: '[{"effect":"deny","expr":"request.source_ip == \\"1.2.3.4\\""}]',
      }),
    );
    expect(find(fs, 'trust-proxy')?.level).toBe('warn');
  });

  it('is clean (no errors) for a coherent single-provider config', () => {
    const fs = runDoctor(cfg({ ANTHROPIC_UPSTREAM_API_KEY: 'sk-x' }));
    expect(fs.filter((f) => f.level === 'error')).toHaveLength(0);
  });
});
