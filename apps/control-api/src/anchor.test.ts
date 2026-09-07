import { createHash, randomBytes } from 'node:crypto';
import { LocalKeypairSigner } from '@gulley/crypto';
import {
  type AuditRow,
  attestAuditChain,
  InMemoryAuditSink,
  type SignedAttestation,
} from '@gulley/pipeline';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChainRewrite, HttpAnchor, InMemoryAnchor } from './anchor';
import { loadConfig } from './config';
import { createInMemoryControlContext } from './context';
import { buildServer } from './server';

const HMAC = 'anchor-hmac-key-16+chars!!!!!!!!';
const AT = { toolVersion: '9.9.9', generatedAt: '2026-01-01T00:00:00.000Z' };

async function chainRows(n: number): Promise<AuditRow[]> {
  let t = 1_700_000_000_000;
  const sink = new InMemoryAuditSink(() => new Date((t += 1000)));
  for (let i = 0; i < n; i++) await sink.append({ actor: 'admin', action: `act.${i}` });
  return sink.rows;
}

/** A signed checkpoint over the first `head` rows of a chain. */
function checkpoint(rows: AuditRow[], head: number): SignedAttestation {
  return attestAuditChain(rows.slice(0, head), { key: HMAC, ...AT });
}

describe('InMemoryAnchor', () => {
  it('is idempotent by head seq and lists oldest-first', async () => {
    const rows = await chainRows(5);
    const anchor = new InMemoryAnchor();
    await anchor.publish(checkpoint(rows, 3));
    await anchor.publish(checkpoint(rows, 3)); // same head → no-op
    await anchor.publish(checkpoint(rows, 5));
    const list = await anchor.list();
    expect(list.map((a) => a.attestation.chain.lastSeq)).toEqual([3, 5]);
  });
});

describe('detectChainRewrite', () => {
  it('reports ok when every anchored head still matches the current chain', async () => {
    const rows = await chainRows(6);
    const anchored = [checkpoint(rows, 3), checkpoint(rows, 6)];
    expect(detectChainRewrite(anchored, rows)).toEqual({ ok: true, anchors: 2, conflicts: [] });
  });

  it('flags a head whose hash changed (history rewritten in place)', async () => {
    const rows = await chainRows(4);
    const anchored = [checkpoint(rows, 4)];
    // Rewrite the current chain: swap the head rowHash.
    const rewritten = rows.map((r) => (r.seq === 4 ? { ...r, rowHash: 'tampered' } : r));
    const report = detectChainRewrite(anchored, rewritten);
    expect(report.ok).toBe(false);
    expect(report.conflicts[0]).toMatchObject({ lastSeq: 4, currentHash: 'tampered' });
  });

  it('flags a head that no longer exists (chain truncated)', async () => {
    const rows = await chainRows(5);
    const anchored = [checkpoint(rows, 5)];
    const truncated = rows.slice(0, 3); // seq 5 is gone
    const report = detectChainRewrite(anchored, truncated);
    expect(report.ok).toBe(false);
    expect(report.conflicts[0]).toMatchObject({ lastSeq: 5, currentHash: null });
  });

  it('skips an empty-chain checkpoint', () => {
    const empty = attestAuditChain([], { key: HMAC, ...AT });
    expect(detectChainRewrite([empty], [])).toEqual({ ok: true, anchors: 1, conflicts: [] });
  });
});

describe('HttpAnchor', () => {
  const allow = ['anchor.test'];

  it('POSTs a checkpoint and reads the list back (array and { anchors } shapes)', async () => {
    const rows = await chainRows(2);
    const cp = checkpoint(rows, 2);
    const calls: Array<{ method?: string; body?: unknown }> = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return {
        ok: true,
        status: 200,
        json: async () => [cp],
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const anchor = new HttpAnchor('https://anchor.test/gulley', { allowlist: allow, fetchImpl });
    const ref = await anchor.publish(cp);
    expect(ref.location).toBe('https://anchor.test/gulley');
    expect(calls[0]?.method).toBe('POST');
    expect((calls[0]?.body as SignedAttestation).attestation.chain.lastSeq).toBe(2);

    const list = await anchor.list();
    expect(list).toHaveLength(1);

    // Also accepts a { anchors: [...] } wrapper.
    const wrapped = new HttpAnchor('https://anchor.test/gulley', {
      allowlist: allow,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ anchors: [cp] }),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(await wrapped.list()).toHaveLength(1);
  });

  it('is SSRF-guarded: a host outside the allowlist is refused', async () => {
    const rows = await chainRows(1);
    const anchor = new HttpAnchor('https://evil.test/x', { allowlist: allow });
    await expect(anchor.publish(checkpoint(rows, 1))).rejects.toThrow();
  });
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe('anchor routes', () => {
  function build(withAnchor: boolean): {
    app: FastifyInstance;
    gadm: string;
    anchor: InMemoryAnchor;
  } {
    const gadm = `gadm_${randomBytes(24).toString('base64url')}`;
    const anchor = new InMemoryAnchor();
    const ctx = createInMemoryControlContext({
      pepper: 'anchor-routes-pepper-16chars!!!!',
      bootstrapEnabled: true,
      bootstrapTokenSha256: createHash('sha256').update(gadm).digest('hex'),
      sessionSecrets: ['anchor-routes-session-secret-32bytes'],
      maxSessionTtlMs: 900_000,
      auditSigner: new LocalKeypairSigner(),
      ...(withAnchor ? { anchor } : {}),
    });
    return {
      app: buildServer(loadConfig({ LOG_LEVEL: 'silent' } as NodeJS.ProcessEnv), ctx),
      gadm,
      anchor,
    };
  }

  it('501s when no anchor sink is configured', async () => {
    const built = build(false);
    app = built.app;
    const res = await app.inject({
      method: 'POST',
      url: '/audit/anchor',
      headers: { authorization: `Bearer ${built.gadm}` },
    });
    expect(res.statusCode).toBe(501);
  });

  it('anchors the head, lists it, and verifies no rewrite', async () => {
    const built = build(true);
    app = built.app;
    const h = { authorization: `Bearer ${built.gadm}` };
    await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: { ...h, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Acme' }),
    });

    const anchored = await app.inject({ method: 'POST', url: '/audit/anchor', headers: h });
    expect(anchored.statusCode).toBe(200);
    expect((anchored.json() as { id: string }).id).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: '/audit/anchors', headers: h });
    expect((list.json() as { anchors: unknown[] }).anchors).toHaveLength(1);

    const verify = await app.inject({ method: 'GET', url: '/audit/anchor/verify', headers: h });
    expect(verify.json()).toMatchObject({ signaturesValid: true, ok: true, anchors: 1 });
  });
});
