import { describe, expect, it, vi } from 'vitest';
import { ApiError, GulleyAdminApi, isNotConfigured, parseErrorBody } from './api';

describe('isNotConfigured', () => {
  it('detects a 501 status in the thrown error string', () => {
    expect(isNotConfigured('GET /admin/observability/metrics → 501: {"error":...}')).toBe(true);
  });
  it('detects the not_configured / not_supported / not enabled bodies', () => {
    expect(isNotConfigured('POST /x → 501: {"error":{"type":"not_configured"}}')).toBe(true);
    expect(isNotConfigured('GET /y → 501: chargeback requires a database (not_supported)')).toBe(
      true,
    );
    expect(isNotConfigured('gateway metrics not enabled')).toBe(true);
  });
  it('is false for other errors and undefined', () => {
    expect(isNotConfigured('GET /x → 403: forbidden')).toBe(false);
    expect(isNotConfigured('GET /x → 500: boom')).toBe(false);
    expect(isNotConfigured(undefined)).toBe(false);
    expect(isNotConfigured('')).toBe(false);
  });
});

describe('ApiError classification + timeouts', () => {
  it('parses the API error envelope and truncates arbitrary bodies', () => {
    expect(
      parseErrorBody('{"error":{"type":"audit_unavailable","message":"m","requestId":"req_1"}}'),
    ).toEqual({ type: 'audit_unavailable', message: 'm', requestId: 'req_1' });
    expect(parseErrorBody('{"error":"invalid_grant","error_description":"nope"}')).toEqual({
      type: 'invalid_grant',
      message: 'nope',
    });
    expect(parseErrorBody(`<html>${'x'.repeat(1000)}</html>`).message.length).toBeLessThanOrEqual(
      300,
    );
  });

  it('throws a typed ApiError, fires onUnauthorized on 401, and classifies 501', async () => {
    const seen: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/auth/me'))
          return new Response('{"error":{"type":"authentication_error","message":"x"}}', {
            status: 401,
          });
        return new Response('{"error":{"type":"not_configured","message":"off"}}', {
          status: 501,
        });
      }),
    );
    const api = new GulleyAdminApi('/control', 't', { onUnauthorized: () => seen.push(401) });
    await expect(api.me()).rejects.toMatchObject({ status: 401, unauthorized: true });
    expect(seen).toEqual([401]);
    let err: unknown;
    try {
      await api.wormStatus();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).notConfigured).toBe(true);
    expect(isNotConfigured(err)).toBe(true);
    expect(isNotConfigured((err as ApiError).message)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('a hung control API surfaces as a timeout ApiError (status 0)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'TimeoutError';
              reject(e);
            });
          }),
      ),
    );
    const api = new GulleyAdminApi('/control', 't', { timeoutMs: 20 });
    await expect(api.orgs()).rejects.toMatchObject({ status: 0, timeout: true });
    vi.unstubAllGlobals();
  });
});
