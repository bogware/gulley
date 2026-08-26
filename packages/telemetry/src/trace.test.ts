import { describe, expect, it } from 'vitest';
import { nextTraceContext, parseTraceparent } from './trace';

describe('parseTraceparent', () => {
  it('parses a valid header and rejects malformed / all-zero ones', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(parseTraceparent(tp)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
    // Not sampled (flags 00).
    expect(
      parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')?.sampled,
    ).toBe(false);
  });
});

describe('nextTraceContext', () => {
  it('continues an inbound trace (same trace-id, new span-id, honors sampled)', () => {
    const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const ctx = nextTraceContext(inbound);
    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx.spanId).not.toBe('00f067aa0ba902b7'); // our own span
    expect(ctx.sampled).toBe(true);
    expect(ctx.traceparent).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it('starts a fresh trace when none is supplied', () => {
    const ctx = nextTraceContext(undefined, 1);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.sampled).toBe(true);
    // A distinct request gets a distinct trace id.
    expect(nextTraceContext(undefined, 1).traceId).not.toBe(ctx.traceId);
  });

  it('never samples a fresh trace at ratio 0', () => {
    for (let i = 0; i < 10; i++) {
      const ctx = nextTraceContext(undefined, 0);
      expect(ctx.sampled).toBe(false);
      expect(ctx.traceparent.endsWith('-00')).toBe(true);
    }
  });
});
