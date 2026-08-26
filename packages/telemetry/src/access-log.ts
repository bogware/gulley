import { compile, type Program } from '@gulley/cel';

/**
 * A config-driven access-log field engine. An operator shapes the per-request
 * access record: drop built-in fields, add computed fields (each a CEL
 * expression over the record), keep only records matching a CEL filter, and
 * optionally flatten nested values to dotted keys. Everything is fail-open — a
 * bad field expression leaves that field unset and a bad filter keeps the record
 * — so observability config can never break or silently drop the request log.
 *
 * SECURITY: the engine computes over whatever record it is given and does NOT
 * redact. The caller MUST pass a credential-free record (no Authorization /
 * x-api-key values, secrets as ARNs only) — the field engine must never be the
 * thing that puts a secret into the log stream.
 */
export interface AccessLogConfig {
  /** name → CEL expression, evaluated over the record; result becomes the field. */
  add?: Record<string, string>;
  /** Built-in field names to drop from the record. */
  remove?: string[];
  /** CEL boolean expression; a record for which it is false is dropped (null). */
  filter?: string;
  /** Flatten nested objects/arrays into dotted-key scalars. */
  flatten?: boolean;
}

export type AccessRecord = Record<string, unknown>;

interface CompiledField {
  name: string;
  program: Program;
}

export class AccessLogFieldEngine {
  private readonly adds: CompiledField[];
  private readonly removes: Set<string>;
  private readonly filter: Program | undefined;
  private readonly doFlatten: boolean;

  constructor(cfg: AccessLogConfig) {
    // Non-strict compile: an expression may reference any record key (missing ⇒
    // undefined at eval), since the available fields are data, not a fixed schema.
    this.adds = Object.entries(cfg.add ?? {}).map(([name, expr]) => ({
      name,
      program: compile(expr, { strict: false }),
    }));
    this.removes = new Set(cfg.remove ?? []);
    this.filter = cfg.filter ? compile(cfg.filter, { strict: false }) : undefined;
    this.doFlatten = cfg.flatten === true;
  }

  /** Shape one record. Returns the field map, or null if the filter drops it. */
  build(record: AccessRecord): AccessRecord | null {
    if (this.filter) {
      try {
        if (!this.filter.evalBool(record)) return null;
      } catch {
        /* a broken filter keeps the record (deliberate fail-open) */
      }
    }

    const out: AccessRecord = {};
    for (const [k, v] of Object.entries(record)) {
      if (!this.removes.has(k)) out[k] = v;
    }
    for (const f of this.adds) {
      try {
        out[f.name] = f.program.eval(record);
      } catch {
        /* fail-open per field: leave it unset */
      }
    }
    return this.doFlatten ? flatten(out) : out;
  }
}

/** Flatten nested objects/arrays to dotted / bracketed scalar keys. */
export function flatten(obj: AccessRecord, prefix = ''): AccessRecord {
  const out: AccessRecord = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as AccessRecord, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          Object.assign(out, flatten(item as AccessRecord, `${key}.${i}`));
        } else {
          out[`${key}.${i}`] = item;
        }
      });
    } else {
      out[key] = v;
    }
  }
  return out;
}
