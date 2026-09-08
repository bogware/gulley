import { describe, expect, it } from 'vitest';
import { isNotConfigured } from './api';

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
