import { createHash, randomBytes } from 'node:crypto';
import { InMemoryAesCipher, InMemorySubjectKeyStore, ShreddableCipher } from '@gulley/crypto';
import type {
  MaskDirection,
  MaskVaultRecord,
  MaskVaultStore,
  MaskVaultView,
} from '@gulley/storage';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createInMemoryControlContext, type ControlContext } from './context';
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
let ctx: ControlContext;
let gadm: string;
let master: InMemoryAesCipher;
let subjectKeys: InMemorySubjectKeyStore;
let store: MemMaskVault;
let orgId: string;
let workspaceId: string;

const auth = () => ({ authorization: `Bearer ${gadm}`, 'content-type': 'application/json' });
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: JSON.stringify(payload) });
const get = (url: string, token = gadm) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const shred = (subject: string, token = gadm) =>
  app.inject({
    method: 'POST',
    url: `/admin/crypto-shred/${subject}`,
    headers: { authorization: `Bearer ${token}` },
  });

/** Seed a mask-vault record encrypted per-subject (the way the gateway writes it). */
async function seedVault(requestId: string, subject: string, entries: Array<[string, string]>) {
  const cipher = new ShreddableCipher(master, subjectKeys);
  const ct = await cipher.encrypt(Buffer.from(JSON.stringify(entries), 'utf8'), {
    keyClass: 'mask-vault',
    aad: `${requestId}:${workspaceId}:output`,
    subject,
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
  master = new InMemoryAesCipher();
  subjectKeys = new InMemorySubjectKeyStore();
  store = new MemMaskVault();
  ctx = createInMemoryControlContext({
    pepper: 'crypto-shred-pepper-16chars!!!!!',
    bootstrapEnabled: true,
    bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
    sessionSecrets: ['crypto-shred-session-secret-32byteslong'],
    maxSessionTtlMs: 900_000,
    maskVault: store,
    maskVaultEncryptor: master,
    subjectKeys,
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

describe('POST/GET /admin/crypto-shred/:subject', () => {
  it('reports active before, shreds, then reports inactive', async () => {
    await seedVault('req_1', 'user-alice', [['<<GULLEY_EMAIL_1>>', 'alice@example.com']]);

    const before = await get('/admin/crypto-shred/user-alice');
    expect(before.statusCode).toBe(200);
    expect((before.json() as { active: boolean }).active).toBe(true);

    const res = await shred('user-alice');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subject: 'user-alice', shredded: true });

    const after = await get('/admin/crypto-shred/user-alice');
    expect((after.json() as { active: boolean }).active).toBe(false);
  });

  it('makes a subsequent mask-vault reveal fail as crypto-shredded (410)', async () => {
    await seedVault('req_reveal', 'user-bob', [['<<GULLEY_EMAIL_1>>', 'bob@example.com']]);

    // Reveal works before the shred.
    const ok = await get('/admin/mask-vault/req_reveal');
    expect(ok.statusCode).toBe(200);
    expect(
      (ok.json() as { reveals: Array<{ tokens: Record<string, string> }> }).reveals[0]?.tokens[
        '<<GULLEY_EMAIL_1>>'
      ],
    ).toBe('bob@example.com');

    expect((await shred('user-bob')).statusCode).toBe(200);

    // After the shred the record's key is gone → provable erasure, distinct 410.
    const gone = await get('/admin/mask-vault/req_reveal');
    expect(gone.statusCode).toBe(410);
    expect((gone.json() as { error: { type: string } }).error.type).toBe('crypto_shredded');
  });

  it('records a crypto.shred entry in the tamper-evident audit chain', async () => {
    await seedVault('req_audit', 'user-carol', [['<<T_1>>', 'secret']]);
    await shred('user-carol');
    const rows = (await ctx.auditRows?.()) ?? [];
    const entry = rows.find((r) => r.action === 'crypto.shred' && r.target === 'user-carol');
    expect(entry).toBeDefined();
    // The audit payload carries the subject id only — never PII values.
    expect(JSON.stringify(entry?.payload)).not.toContain('secret');
    expect(JSON.stringify(entry?.payload)).toContain('user-carol');
  });

  it('403s a caller lacking the owner-only permission', async () => {
    const sess = (await post('/admin/sessions', {
      memberships: [{ role: 'admin', orgId, workspaceId }],
    }).then((r) => r.json())) as { token: string };
    expect((await shred('user-alice', sess.token)).statusCode).toBe(403);
    expect((await get('/admin/crypto-shred/user-alice', sess.token)).statusCode).toBe(403);
  });

  it('401s without an admin token', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/crypto-shred/user-alice' });
    expect(res.statusCode).toBe(401);
  });

  it('501s when crypto-shred is not wired', async () => {
    const bare = createInMemoryControlContext({
      pepper: 'crypto-shred-pepper-16chars!!!!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
      sessionSecrets: ['crypto-shred-session-secret-32byteslong'],
      maxSessionTtlMs: 900_000,
    });
    const app2 = buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), bare);
    const res = await app2.inject({
      method: 'POST',
      url: '/admin/crypto-shred/user-alice',
      headers: { authorization: `Bearer ${gadm}` },
    });
    expect(res.statusCode).toBe(501);
    await app2.close();
  });
});
