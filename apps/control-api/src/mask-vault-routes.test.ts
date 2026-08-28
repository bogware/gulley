import { createHash, randomBytes } from 'node:crypto';
import { InMemoryAesCipher } from '@gulley/crypto';
import type {
  MaskDirection,
  MaskVaultRecord,
  MaskVaultStore,
  MaskVaultView,
} from '@gulley/storage';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

/** In-memory MaskVaultStore holding the (already-encrypted) records. */
class MemMaskVault implements MaskVaultStore {
  private readonly rows = new Map<string, MaskVaultView[]>();
  async put(r: MaskVaultRecord): Promise<void> {
    const view: MaskVaultView = {
      requestId: r.requestId,
      direction: r.direction,
      workspaceId: r.workspaceId,
      orgId: r.orgId,
      ciphertext: r.ciphertext,
      tokenCount: r.tokenCount,
    };
    const list = (this.rows.get(r.requestId) ?? []).filter((x) => x.direction !== r.direction);
    list.push(view);
    this.rows.set(r.requestId, list);
  }
  async get(requestId: string, direction: MaskDirection): Promise<MaskVaultView | undefined> {
    return this.rows.get(requestId)?.find((x) => x.direction === direction);
  }
  async list(requestId: string): Promise<MaskVaultView[]> {
    return this.rows.get(requestId) ?? [];
  }
  async sweepExpired(): Promise<number> {
    return 0;
  }
}

let app: FastifyInstance;
let gadm: string;
let cipher: InMemoryAesCipher;
let store: MemMaskVault;
let orgId: string;
let workspaceId: string;

const auth = () => ({ authorization: `Bearer ${gadm}`, 'content-type': 'application/json' });
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: JSON.stringify(payload) });

async function seedVault(requestId: string, entries: Array<[string, string]>, useCipher = cipher) {
  const ct = await useCipher.encrypt(Buffer.from(JSON.stringify(entries), 'utf8'), {
    keyClass: 'mask-vault',
    aad: `${requestId}:${workspaceId}:output`,
  });
  await store.put({
    requestId,
    direction: 'output',
    workspaceId,
    orgId,
    ciphertext: ct,
    tokenCount: entries.length,
    ttlSeconds: 3600,
  });
}

beforeEach(async () => {
  gadm = `gadm_${randomBytes(24).toString('base64url')}`;
  cipher = new InMemoryAesCipher();
  store = new MemMaskVault();
  const ctx = createInMemoryControlContext({
    pepper: 'mask-vault-pepper-16chars!!!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['mask-vault-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
    maskVault: store,
    maskVaultEncryptor: cipher,
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx);
  orgId = ((await post('/orgs', { name: 'Acme' }).then((r) => r.json())) as { org: { id: string } })
    .org.id;
  workspaceId = (
    (await post('/workspaces', { orgId, name: 'prod' }).then((r) => r.json())) as {
      workspace: { id: string };
    }
  ).workspace.id;
});

afterEach(async () => {
  await app.close();
});

describe('GET /admin/mask-vault/:requestId', () => {
  it('decrypts and returns the token→original map for an authorized admin', async () => {
    const entries: Array<[string, string]> = [['<<GULLEY_EMAIL_1>>', 'jane@example.com']];
    await seedVault('req_reveal', entries);

    const res = await app.inject({
      method: 'GET',
      url: '/admin/mask-vault/req_reveal',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reveals: Array<{ direction: string; tokens: Record<string, string> }>;
    };
    expect(body.reveals[0]?.direction).toBe('output');
    expect(body.reveals[0]?.tokens['<<GULLEY_EMAIL_1>>']).toBe('jane@example.com');
  });

  it('404s an unknown requestId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/mask-vault/nope',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('fails closed (502) when the record was encrypted under a different key', async () => {
    await seedVault('req_wrongkey', [['<<T_1>>', 'secret']], new InMemoryAesCipher());
    const res = await app.inject({
      method: 'GET',
      url: '/admin/mask-vault/req_wrongkey',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(res.statusCode).toBe(502);
  });

  it('401s without an admin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/mask-vault/req_reveal' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 (not 403) for a caller lacking guardrail:reveal — no existence oracle', async () => {
    await seedVault('req_exists', [['<<GULLEY_EMAIL_1>>', 'jane@example.com']]);
    // An editor session lacks the owner-only guardrail:reveal permission.
    const sess = (await post('/admin/sessions', {
      memberships: [{ role: 'editor', orgId, workspaceId }],
    }).then((r) => r.json())) as { token: string };
    // An EXISTING record and a NON-existent one must be indistinguishable to them.
    const onExisting = await app.inject({
      method: 'GET',
      url: '/admin/mask-vault/req_exists',
      headers: { authorization: `Bearer ${sess.token}` },
    });
    const onMissing = await app.inject({
      method: 'GET',
      url: '/admin/mask-vault/req_absent',
      headers: { authorization: `Bearer ${sess.token}` },
    });
    expect(onExisting.statusCode).toBe(404);
    expect(onMissing.statusCode).toBe(404);
  });

  it('501s when no encryptor/store is wired', async () => {
    const bare = createInMemoryControlContext({
      pepper: 'mask-vault-pepper-16chars!!!!!!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
      sessionSecrets: ['mask-vault-session-secret-32byteslong'],
      maxSessionTtlMs: 900_000,
    });
    const app2 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), bare);
    const res = await app2.inject({
      method: 'GET',
      url: '/admin/mask-vault/x',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(res.statusCode).toBe(501);
    await app2.close();
  });
});
