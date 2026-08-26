import { randomBytes } from 'node:crypto';

/**
 * Minimal W3C Trace Context (traceparent) handling for outbound propagation.
 * The gateway continues a client-supplied trace when present (same trace-id, our
 * span becomes the new parent) or starts a fresh one, applies a sampling
 * decision, and injects the header upstream so a provider call joins the caller's
 * distributed trace. We deliberately hand-roll the wire format rather than stand
 * up a full OpenTelemetry context — there is no live active span on the raw-pipe
 * hot path, and a single header is all propagation needs.
 */
export interface TraceContext {
  traceparent: string;
  /** 32-hex trace id — stamped on the span + access log so everything correlates. */
  traceId: string;
  /** 16-hex id of the span this request represents. */
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** Parse an inbound `traceparent`, or undefined if absent/malformed/all-zero. */
export function parseTraceparent(
  value: string | undefined,
): { traceId: string; parentId: string; sampled: boolean } | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!m) return undefined;
  const [, traceId, parentId, flags] = m;
  if (traceId === ZERO_TRACE || parentId === ZERO_SPAN) return undefined;
  return {
    traceId: traceId as string,
    parentId: parentId as string,
    sampled: (parseInt(flags as string, 16) & 1) === 1,
  };
}

/**
 * Build the outbound trace context. Continues `inbound`'s trace when valid (and
 * honors its sampled flag), else starts a fresh trace sampled with probability
 * `sampleRatio` (0..1). Randomness is a per-call decision — never on the hot path
 * in a way that must be deterministic.
 */
export function nextTraceContext(inbound: string | undefined, sampleRatio = 1): TraceContext {
  const parent = parseTraceparent(inbound);
  const traceId = parent?.traceId ?? randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const sampled = parent ? parent.sampled : Math.random() < sampleRatio;
  return {
    traceId,
    spanId,
    sampled,
    traceparent: `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`,
  };
}
