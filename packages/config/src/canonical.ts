import { createHash } from 'node:crypto';
import type { ConfigDocument } from './document';

/** Recursively sort object keys for a deterministic, stable serialization.
 *  (Symbol keys — e.g. the SecretRef brand — are dropped, leaving the ref's
 *  {secretArn, secretVersion} plain fields.) */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

export function canonicalJson(doc: ConfigDocument): string {
  return JSON.stringify(canonicalize(doc));
}

export function contentHash(doc: ConfigDocument): string {
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

export interface DiffSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function walk(a: unknown, b: unknown, path: string, s: DiffSummary): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) s.added.push(`${path}.${k}`);
      else if (!(k in b)) s.removed.push(`${path}.${k}`);
      else walk(a[k], b[k], `${path}.${k}`, s);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) s.added.push(`${path}[${i}]`);
      else if (i >= b.length) s.removed.push(`${path}[${i}]`);
      else walk(a[i], b[i], `${path}[${i}]`, s);
    }
    return;
  }
  s.changed.push(path);
}

/** Path-addressed diff between two documents (current → desired). */
export function diffDocuments(current: ConfigDocument, desired: ConfigDocument): DiffSummary {
  const s: DiffSummary = { added: [], removed: [], changed: [] };
  walk(canonicalize(current), canonicalize(desired), '$', s);
  return s;
}

export function isEmptyDiff(d: DiffSummary): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}
