import { assertEgressAllowed } from '@gulley/egress';
import type { AuditRow, SignedAttestation } from '@gulley/pipeline';

/**
 * Anchoring — publish periodic SIGNED checkpoints of the audit chain head to an
 * append-only sink OUTSIDE the operator's own database (a transparency log, an
 * Object-Lock bucket behind a small HTTP shim, a notary service). This closes the
 * last gap in the tamper-evidence story: WORM + signing prove no one ELSE rewrote the
 * log, but the OPERATOR still controls both Postgres and WORM. An external anchor they
 * cannot retroactively edit means a later rewrite is detectable — a previously
 * published head hash that the current chain no longer contains at that seq is proof
 * of tampering ({@link detectChainRewrite}).
 *
 * The checkpoint is just the signed attestation (its chain.lastSeq / lastHash / count
 * pin the head), so anchoring reuses the same signing + offline verification.
 */
export interface AnchorRef {
  id: string;
  location?: string;
}

export interface Anchor {
  publish(att: SignedAttestation): Promise<AnchorRef>;
  /** The anchored checkpoints, oldest first — read back for rewrite detection. */
  list(): Promise<SignedAttestation[]>;
}

function headSeq(att: SignedAttestation): number {
  return att.attestation.chain.lastSeq ?? 0;
}

/** In-memory anchor twin (dev/CI). Idempotent by head seq: re-anchoring the same head
 *  is a no-op, so an overlapping timer/manual publish is safe. */
export class InMemoryAnchor implements Anchor {
  private readonly byKey = new Map<string, SignedAttestation>();

  private keyFor(att: SignedAttestation): string {
    return String(headSeq(att)).padStart(12, '0');
  }

  async publish(att: SignedAttestation): Promise<AnchorRef> {
    const id = this.keyFor(att);
    if (!this.byKey.has(id)) this.byKey.set(id, att);
    return { id };
  }

  async list(): Promise<SignedAttestation[]> {
    return [...this.byKey.keys()].sort().map((k) => this.byKey.get(k)!);
  }
}

export interface HttpAnchorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowlist?: ReadonlySet<string> | readonly string[];
  /** Extra headers (e.g. an auth token for the sink). */
  headers?: Record<string, string>;
}

/**
 * HTTP anchor: POST each checkpoint to an external append-only sink, and GET the list
 * back for verification. Egress is SSRF-guarded (the URL is operator config). The sink
 * is expected to be append-only/immutable on its side — that property, not this code,
 * is what makes an anchored head un-rewritable.
 */
export class HttpAnchor implements Anchor {
  constructor(
    private readonly url: string,
    private readonly opts: HttpAnchorOptions = {},
  ) {}

  private async fetchJson(method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    assertEgressAllowed(this.url, { allowlist: this.opts.allowlist });
    const doFetch = this.opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    timer.unref?.();
    try {
      const res = await doFetch(this.url, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...this.opts.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`anchor sink returned ${res.status}`);
      return method === 'GET' ? ((await res.json()) as unknown) : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async publish(att: SignedAttestation): Promise<AnchorRef> {
    await this.fetchJson('POST', att);
    return { id: String(headSeq(att)).padStart(12, '0'), location: this.url };
  }

  async list(): Promise<SignedAttestation[]> {
    const json = await this.fetchJson('GET');
    const arr = Array.isArray(json)
      ? json
      : json && typeof json === 'object' && Array.isArray((json as { anchors?: unknown[] }).anchors)
        ? (json as { anchors: SignedAttestation[] }).anchors
        : [];
    return arr as SignedAttestation[];
  }
}

export interface RewriteConflict {
  lastSeq: number;
  anchoredHash: string;
  currentHash: string | null;
}

export interface RewriteReport {
  ok: boolean;
  anchors: number;
  /** Anchored heads the current chain no longer matches — evidence of a rewrite. */
  conflicts: RewriteConflict[];
}

/**
 * Cross-check anchored checkpoints against the CURRENT chain: every anchored head hash
 * must still appear at its seq. A mismatch (or a missing row at that seq) means history
 * was rewritten AFTER it was anchored. Callers should verify each attestation's
 * signature first (a tampered sink entry is not evidence of a rewrite). Pure.
 */
export function detectChainRewrite(
  anchored: readonly SignedAttestation[],
  currentRows: readonly AuditRow[],
): RewriteReport {
  const bySeq = new Map<number, string>();
  for (const r of currentRows) bySeq.set(r.seq, r.rowHash);
  const conflicts: RewriteConflict[] = [];
  for (const att of anchored) {
    const lastSeq = att.attestation.chain.lastSeq;
    const anchoredHash = att.attestation.chain.lastHash;
    if (lastSeq === null || anchoredHash === null) continue; // an empty-chain checkpoint
    const currentHash = bySeq.get(lastSeq) ?? null;
    if (currentHash !== anchoredHash) conflicts.push({ lastSeq, anchoredHash, currentHash });
  }
  return { ok: conflicts.length === 0, anchors: anchored.length, conflicts };
}
