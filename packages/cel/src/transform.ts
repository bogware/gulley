import { type CompileOptions, compile, Program } from './program';

/** One header mutation: set `name` to the string result of `value` (a CEL
 *  expression), or remove it. */
export interface HeaderMutation {
  name: string;
  /** CEL expression whose (stringified) result becomes the header value. */
  value?: string;
  remove?: boolean;
}

/** Set a top-level request-body field to the result of a CEL expression. */
export interface BodyMutation {
  field: string;
  value: string;
}

export interface CelTransformConfig {
  requestHeaders?: HeaderMutation[];
  responseHeaders?: HeaderMutation[];
  requestBody?: BodyMutation[];
}

export interface HeaderChanges {
  set: Record<string, string>;
  remove: string[];
}

interface CompiledHeader {
  name: string;
  program?: Program;
  remove: boolean;
}
interface CompiledBody {
  field: string;
  program: Program;
}

/**
 * CEL-driven request/response transformation: set or remove headers and set
 * top-level request-body fields, with each value computed by a CEL expression
 * over the request/principal (and, for responses, response) activation. A value
 * expression that errors leaves that mutation unapplied (fail-open) so a bad
 * transform never breaks the proxied request. `needsBody` reports whether any
 * expression reads `request.body`, so the gateway can keep the fast path when it
 * doesn't.
 */
export class CelTransformer {
  private readonly reqHeaders: CompiledHeader[];
  private readonly respHeaders: CompiledHeader[];
  private readonly bodyOps: CompiledBody[];
  readonly needsBody: boolean;

  constructor(cfg: CelTransformConfig, opts?: CompileOptions) {
    const h = (m: HeaderMutation): CompiledHeader => ({
      name: m.name.toLowerCase(),
      program: m.value !== undefined ? compile(m.value, opts) : undefined,
      remove: m.remove === true,
    });
    this.reqHeaders = (cfg.requestHeaders ?? []).map(h);
    this.respHeaders = (cfg.responseHeaders ?? []).map(h);
    this.bodyOps = (cfg.requestBody ?? []).map((b) => ({
      field: b.field,
      program: compile(b.value, opts),
    }));

    const all = [
      ...this.reqHeaders,
      ...this.respHeaders,
      ...this.bodyOps.map((b) => ({ program: b.program })),
    ];
    this.needsBody = all.some((x) => x.program?.reads('request.body'));
  }

  get active(): boolean {
    return this.reqHeaders.length + this.respHeaders.length + this.bodyOps.length > 0;
  }

  requestHeaderChanges(act: Record<string, unknown>): HeaderChanges {
    return this.headerChanges(this.reqHeaders, act);
  }

  responseHeaderChanges(act: Record<string, unknown>): HeaderChanges {
    return this.headerChanges(this.respHeaders, act);
  }

  /** Field → value patch to merge into the parsed request body. */
  requestBodyPatch(act: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const op of this.bodyOps) {
      try {
        patch[op.field] = op.program.eval(act);
      } catch {
        /* leave the field unchanged on a transform error */
      }
    }
    return patch;
  }

  private headerChanges(headers: CompiledHeader[], act: Record<string, unknown>): HeaderChanges {
    const set: Record<string, string> = {};
    const remove: string[] = [];
    for (const h of headers) {
      if (h.remove) {
        remove.push(h.name);
        continue;
      }
      if (!h.program) continue;
      try {
        set[h.name] = stringify(h.program.eval(act));
      } catch {
        /* skip a mutation whose value expression errored */
      }
    }
    return { set, remove };
  }
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
