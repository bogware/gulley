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

  it('errors on prod mask-vault persistence without KMS (loadConfig now refuses it outright)', () => {
    // The schema refinement rejects this combination at boot; the doctor keeps its own
    // check for a config assembled by other means (e.g. a dev config promoted to prod).
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: 'silent',
        ANTHROPIC_UPSTREAM_API_KEY: 'sk-x',
        MASK_VAULT_PERSIST: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/GULLEY_KMS_KEY_ARN/);
    const fs = runDoctor({
      ...loadConfig({
        LOG_LEVEL: 'silent',
        ANTHROPIC_UPSTREAM_API_KEY: 'sk-x',
      } as NodeJS.ProcessEnv),
      NODE_ENV: 'production',
      MASK_VAULT_PERSIST: true,
    });
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

describe('gulley doctor: air-gapped readiness', () => {
  const airFindings = (fs: DoctorFinding[]) => fs.filter((f) => f.check === 'air-gapped');

  it('emits nothing air-gap-related when AIR_GAPPED is off', () => {
    expect(airFindings(runDoctor(cfg({ ANTHROPIC_UPSTREAM_API_KEY: 'sk-x' })))).toHaveLength(0);
  });

  it('reports the posture (info) and warns without a pinned catalog', () => {
    const fs = airFindings(
      runDoctor(cfg({ ANTHROPIC_UPSTREAM_API_KEY: 'sk-x', AIR_GAPPED: 'true' })),
    );
    expect(fs.some((f) => f.level === 'info')).toBe(true);
    expect(fs.some((f) => f.level === 'warn' && /MODELS_CATALOG_FILE/.test(f.detail))).toBe(true);
  });

  it('warns about a public-reaching DLP webhook and managed guardrail plugins', () => {
    const fs = airFindings(
      runDoctor(
        cfg({
          ANTHROPIC_UPSTREAM_API_KEY: 'sk-x',
          AIR_GAPPED: 'true',
          MODELS_CATALOG_FILE: './cat.json',
          GUARDRAILS_WEBHOOK_URL: 'https://dlp.public.example/scan',
          GUARDRAILS_MODERATION_BASE_URL: 'https://api.openai.com/v1',
        }),
      ),
    );
    expect(fs.some((f) => /DLP webhook/.test(f.detail))).toBe(true);
    expect(fs.some((f) => /managed guardrail/.test(f.detail))).toBe(true);
    // A pinned catalog silences that particular warning.
    expect(fs.some((f) => /MODELS_CATALOG_FILE/.test(f.detail))).toBe(false);
  });

  it('an internal (ALLOW_INTERNAL) DLP webhook does not warn', () => {
    const fs = airFindings(
      runDoctor(
        cfg({
          ANTHROPIC_UPSTREAM_API_KEY: 'sk-x',
          AIR_GAPPED: 'true',
          MODELS_CATALOG_FILE: './cat.json',
          GUARDRAILS_WEBHOOK_URL: 'https://dlp.acme.internal/scan',
          GUARDRAILS_WEBHOOK_ALLOW_INTERNAL: 'true',
        }),
      ),
    );
    expect(fs.some((f) => /DLP webhook/.test(f.detail))).toBe(false);
    expect(fs.filter((f) => f.level === 'warn')).toHaveLength(0);
  });
});
