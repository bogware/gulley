import { describe, expect, it, vi } from 'vitest';

import { ControlApiError, ControlClient, ControlNetworkError } from './client';
import { controlApiOpenApi } from './openapi';

/** A fetch stub that records the last call and returns a canned JSON response. */
function stubFetch(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe('ControlClient', () => {
  const opts = (f: typeof fetch) => ({ baseUrl: 'http://api.test/', token: 'gadm_x', fetch: f });

  it('sends the bearer token and JSON body on a write', async () => {
    const { f, calls } = stubFetch(201, { org: { id: 'o1', name: 'Acme' } });
    const c = new ControlClient(opts(f));
    const res = await c.createOrg('Acme');
    expect(res.org.id).toBe('o1');
    const call = calls[0]!;
    expect(call.url).toBe('http://api.test/orgs'); // trailing slash normalized
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer gadm_x');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({ name: 'Acme' });
  });

  it('omits a body and content-type on GET/DELETE', async () => {
    const { f, calls } = stubFetch(200, { deleted: true });
    const c = new ControlClient(opts(f));
    await c.deleteWorkspace('ws 1');
    const call = calls[0]!;
    expect(call.url).toBe('http://api.test/workspaces/ws%201'); // id encoded
    expect(call.init.method).toBe('DELETE');
    expect(call.init.body).toBeUndefined();
    expect((call.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('encodes query params for list endpoints', async () => {
    const { f, calls } = stubFetch(200, { keys: [] });
    const c = new ControlClient(opts(f));
    await c.listKeys('ws/withslash');
    expect(calls[0]!.url).toBe('http://api.test/keys?workspaceId=ws%2Fwithslash');
  });

  it('routes collection CRUD to the right verb + path', async () => {
    const { f, calls } = stubFetch(200, { entity: {} });
    const c = new ControlClient(opts(f));
    await c.updateCollectionEntity('rate-limits', 'e1', { name: 'n' });
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.url).toBe('http://api.test/rate-limits/e1');
  });

  it('throws ControlApiError with the status and parsed body on non-2xx', async () => {
    const { f } = stubFetch(409, { error: { type: 'conflict' } });
    const c = new ControlClient(opts(f));
    await expect(c.createPrompt({ workspaceId: 'w', name: 'n', body: 'b' })).rejects.toMatchObject({
      status: 409,
      body: { error: { type: 'conflict' } },
    });
    await expect(c.createPrompt({ workspaceId: 'w', name: 'n', body: 'b' })).rejects.toBeInstanceOf(
      ControlApiError,
    );
  });
});

describe('controlApiOpenApi document', () => {
  it('is a valid 3.1 document with tagged, secured operations', () => {
    expect(controlApiOpenApi.openapi).toBe('3.1.0');
    expect(controlApiOpenApi.info.title).toBe('Gulley Control API');
    expect(controlApiOpenApi.components.securitySchemes['bearerAuth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });

    const knownTags = new Set(controlApiOpenApi.tags.map((t) => t.name));
    const operationIds = new Set<string>();
    let opCount = 0;
    for (const [path, item] of Object.entries(controlApiOpenApi.paths)) {
      expect(path.startsWith('/')).toBe(true);
      for (const method of ['get', 'post', 'put', 'delete'] as const) {
        const o = item[method];
        if (!o) continue;
        opCount++;
        // Unique operationIds (codegen relies on this).
        expect(operationIds.has(o.operationId)).toBe(false);
        operationIds.add(o.operationId);
        // Every operation tags into the declared tag set.
        for (const t of o.tags) expect(knownTags.has(t)).toBe(true);
        // Path params are declared.
        const paramCount = (path.match(/\{/g) ?? []).length;
        const declared = (o.parameters ?? []).filter((p) => p.in === 'path').length;
        expect(declared).toBe(paramCount);
      }
    }
    expect(opCount).toBeGreaterThan(25);
  });

  it('covers the governed prompt registry and full collection CRUD', () => {
    expect(controlApiOpenApi.paths['/prompts/{id}/verify']?.get).toBeDefined();
    expect(controlApiOpenApi.paths['/prompts/{id}/render']?.post).toBeDefined();
    // Each collection has get/post on the base and put/delete on the item path.
    for (const c of [
      'routes',
      'policies',
      'budgets',
      'rate-limits',
      'guardrails',
      'model-aliases',
    ]) {
      expect(controlApiOpenApi.paths[`/${c}`]?.get).toBeDefined();
      expect(controlApiOpenApi.paths[`/${c}`]?.post).toBeDefined();
      expect(controlApiOpenApi.paths[`/${c}/{id}`]?.put).toBeDefined();
      expect(controlApiOpenApi.paths[`/${c}/{id}`]?.delete).toBeDefined();
    }
  });

  it('marks /health public and everything else bearer-secured', () => {
    expect(controlApiOpenApi.paths['/health']?.get?.security).toEqual([]);
    expect(controlApiOpenApi.paths['/orgs']?.post?.security).toEqual([{ bearerAuth: [] }]);
  });
});

describe('ControlClient — deadlines and non-JSON answers (refine cycle 2026-09)', () => {
  it('a non-JSON error page keeps the status and carries the raw text (no SyntaxError)', async () => {
    const f = vi.fn(
      async () =>
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof fetch;
    const c = new ControlClient({ baseUrl: 'http://api.test', token: 't', fetch: f });
    await expect(c.listOrgs()).rejects.toMatchObject({
      name: 'ControlApiError',
      status: 502,
      body: { raw: '<html>502 Bad Gateway</html>' },
    });
  });

  it('lifts type / message / requestId from the API error envelope', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'audit_unavailable', message: 'm', requestId: 'req_1' },
          }),
          { status: 500 },
        ),
    ) as unknown as typeof fetch;
    const c = new ControlClient({ baseUrl: 'http://api.test', token: 't', fetch: f });
    let err: unknown;
    try {
      await c.listOrgs();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ControlApiError);
    expect((err as ControlApiError).type).toBe('audit_unavailable');
    expect((err as ControlApiError).requestId).toBe('req_1');
    expect((err as Error).message).toBe('control API 500: m');
  });

  it('a hung control API surfaces as a ControlNetworkError timeout; network errors are wrapped', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'TimeoutError';
            reject(e);
          });
        }),
    ) as unknown as typeof fetch;
    const c = new ControlClient({
      baseUrl: 'http://api.test',
      token: 't',
      fetch: hang,
      timeoutMs: 20,
    });
    await expect(c.listOrgs()).rejects.toMatchObject({
      name: 'ControlNetworkError',
      timeout: true,
    });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const c2 = new ControlClient({ baseUrl: 'http://api.test', token: 't', fetch: down });
    await expect(c2.listOrgs()).rejects.toBeInstanceOf(ControlNetworkError);
  });
});
