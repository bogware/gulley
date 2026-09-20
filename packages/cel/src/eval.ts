import type { BinaryOp, Expr } from './ast';
import { type Cidr, cidrContains, ipv4ToInt, parseCidr } from './ip';

export class CelEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CelEvalError';
  }
}

/** A user-supplied global function (deterministic, side-effect free). */
export type CelFunction = (args: unknown[]) => unknown;

export interface EvalOptions {
  /** Extra global functions available to expressions. */
  functions?: Record<string, CelFunction>;
  /** Cap total AST-node evaluations to bound cost (comprehensions). */
  maxSteps?: number;
  /** Collect a per-node evaluation trace (for debugging policies). */
  trace?: Array<{ expr: string; value: unknown }>;
}

interface Scope {
  vars: Map<string, unknown>;
  parent?: Scope;
  root: Record<string, unknown>;
}

const CIDR_TAG = Symbol('cidr');
interface CidrValue {
  [CIDR_TAG]: Cidr;
}
function isCidr(v: unknown): v is CidrValue {
  return typeof v === 'object' && v !== null && CIDR_TAG in v;
}

function lookup(scope: Scope, name: string): { has: boolean; value: unknown } {
  let s: Scope | undefined = scope;
  while (s) {
    if (s.vars.has(name)) return { has: true, value: s.vars.get(name) };
    s = s.parent;
  }
  if (Object.prototype.hasOwnProperty.call(scope.root, name)) {
    return { has: true, value: scope.root[name] };
  }
  return { has: false, value: undefined };
}

function child(scope: Scope, name: string, value: unknown): Scope {
  return { vars: new Map([[name, value]]), parent: scope, root: scope.root };
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (v instanceof Uint8Array) return 'bytes';
  if (Array.isArray(v)) return 'list';
  if (isCidr(v)) return 'cidr';
  if (typeof v === 'object') return 'map';
  return typeof v;
}

function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equals(x, b[i]));
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => equals(a[k], b[k]));
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array) &&
    !isCidr(v)
  );
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw new CelEvalError(`cannot compare ${typeName(a)} and ${typeName(b)}`);
}

function requireBool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new CelEvalError(`${what} requires bool, got ${typeName(v)}`);
  return v;
}

/** Code-point length without materialising an array (a 32 MiB body field spread
 *  into `[...v]` allocated tens of millions of elements per evaluation). */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i++;
    n++;
  }
  return n;
}

/** Bounded cache of compiled `matches()` patterns. Patterns come from POLICY text
 *  (operator-authored), but were re-compiled on every evaluation; they are capped
 *  in length so a pathological pattern cannot cost unbounded compile time. */
const MAX_PATTERN_LENGTH = 512;
const REGEX_CACHE_MAX = 256;
const regexCache = new Map<string, RegExp>();
function cachedRegex(pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new CelEvalError(`matches() pattern longer than ${MAX_PATTERN_LENGTH} chars`);
  }
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    if (regexCache.size >= REGEX_CACHE_MAX) {
      const oldest = regexCache.keys().next().value;
      if (oldest !== undefined) regexCache.delete(oldest);
    }
    regexCache.set(pattern, re);
  }
  re.lastIndex = 0;
  return re;
}

function sizeOf(v: unknown): number {
  if (typeof v === 'string') return codePointLength(v);
  if (Array.isArray(v)) return v.length;
  if (v instanceof Uint8Array) return v.length;
  if (isPlainObject(v)) return Object.keys(v).length;
  throw new CelEvalError(`size() not defined for ${typeName(v)}`);
}

export class Evaluator {
  private steps = 0;
  private readonly maxSteps: number;
  private readonly userFns: Record<string, CelFunction>;
  private readonly trace?: EvalOptions['trace'];

  constructor(opts: EvalOptions = {}) {
    this.maxSteps = opts.maxSteps ?? 100_000;
    this.userFns = opts.functions ?? {};
    this.trace = opts.trace;
  }

  run(expr: Expr, root: Record<string, unknown>): unknown {
    this.steps = 0;
    return this.eval(expr, { vars: new Map(), root });
  }

  private tick(): void {
    if (++this.steps > this.maxSteps) throw new CelEvalError('evaluation step limit exceeded');
  }

  private eval(expr: Expr, scope: Scope): unknown {
    this.tick();
    const v = this.evalInner(expr, scope);
    if (this.trace) this.trace.push({ expr: expr.kind, value: v });
    return v;
  }

  private evalInner(expr: Expr, scope: Scope): unknown {
    switch (expr.kind) {
      case 'lit':
        return expr.value;
      case 'ident': {
        const r = lookup(scope, expr.name);
        if (!r.has) throw new CelEvalError(`undefined variable '${expr.name}'`);
        return r.value;
      }
      case 'list':
        return expr.elements.map((e) => this.eval(e, scope));
      case 'map': {
        const out: Record<string, unknown> = {};
        for (const { key, value } of expr.entries) {
          const k = this.eval(key, scope);
          out[String(k)] = this.eval(value, scope);
        }
        return out;
      }
      case 'unary': {
        const x = this.eval(expr.operand, scope);
        if (expr.op === '!') return !requireBool(x, 'operator !');
        if (typeof x !== 'number') throw new CelEvalError('unary - requires number');
        return -x;
      }
      case 'ternary': {
        const c = requireBool(this.eval(expr.cond, scope), 'ternary condition');
        return c ? this.eval(expr.then, scope) : this.eval(expr.otherwise, scope);
      }
      case 'binary':
        return this.binary(expr.op, expr.left, expr.right, scope);
      case 'member':
        return this.member(this.eval(expr.object, scope), expr.field);
      case 'index': {
        const obj = this.eval(expr.object, scope);
        const idx = this.eval(expr.index, scope);
        return this.index(obj, idx);
      }
      case 'call':
        return this.call(expr.func, expr.args, scope);
      case 'method':
        return this.method(this.eval(expr.target, scope), expr.method, expr.args, scope);
      case 'macro':
        return this.macro(expr, scope);
    }
  }

  private binary(op: BinaryOp, l: Expr, r: Expr, scope: Scope): unknown {
    if (op === '&&') {
      return requireBool(this.eval(l, scope), '&&')
        ? requireBool(this.eval(r, scope), '&&')
        : false;
    }
    if (op === '||') {
      return requireBool(this.eval(l, scope), '||') ? true : requireBool(this.eval(r, scope), '||');
    }
    const a = this.eval(l, scope);
    const b = this.eval(r, scope);
    switch (op) {
      case '==':
        return equals(a, b);
      case '!=':
        return !equals(a, b);
      case '<':
        return compare(a, b) < 0;
      case '<=':
        return compare(a, b) <= 0;
      case '>':
        return compare(a, b) > 0;
      case '>=':
        return compare(a, b) >= 0;
      case 'in':
        return this.inOp(a, b);
      case '+':
        return this.plus(a, b);
      case '-':
        return this.numOp(a, b, (x, y) => x - y);
      case '*':
        return this.numOp(a, b, (x, y) => x * y);
      case '/':
        if (b === 0) throw new CelEvalError('division by zero');
        return this.numOp(a, b, (x, y) => x / y);
      case '%':
        if (b === 0) throw new CelEvalError('modulo by zero');
        return this.numOp(a, b, (x, y) => x % y);
    }
  }

  private plus(a: unknown, b: unknown): unknown {
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    if (typeof a === 'string' && typeof b === 'string') return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (a instanceof Uint8Array && b instanceof Uint8Array) return new Uint8Array([...a, ...b]);
    throw new CelEvalError(`operator + not defined for ${typeName(a)} and ${typeName(b)}`);
  }
  private numOp(a: unknown, b: unknown, f: (x: number, y: number) => number): number {
    if (typeof a !== 'number' || typeof b !== 'number') {
      throw new CelEvalError(`arithmetic requires numbers, got ${typeName(a)} and ${typeName(b)}`);
    }
    return f(a, b);
  }
  private inOp(a: unknown, b: unknown): boolean {
    if (Array.isArray(b)) return b.some((x) => equals(x, a));
    if (isPlainObject(b)) return Object.prototype.hasOwnProperty.call(b, String(a));
    if (typeof b === 'string' && typeof a === 'string') return b.includes(a);
    throw new CelEvalError(`operator in not defined for ${typeName(b)}`);
  }

  private member(obj: unknown, field: string): unknown {
    if (isPlainObject(obj)) {
      if (!Object.prototype.hasOwnProperty.call(obj, field)) {
        throw new CelEvalError(`no such field '${field}'`);
      }
      return obj[field];
    }
    throw new CelEvalError(`cannot access field '${field}' on ${typeName(obj)}`);
  }
  private index(obj: unknown, idx: unknown): unknown {
    if (Array.isArray(obj)) {
      if (typeof idx !== 'number') throw new CelEvalError('list index must be a number');
      if (idx < 0 || idx >= obj.length) throw new CelEvalError('index out of bounds');
      return obj[idx];
    }
    if (isPlainObject(obj)) {
      const k = String(idx);
      if (!Object.prototype.hasOwnProperty.call(obj, k))
        throw new CelEvalError(`no such key '${k}'`);
      return obj[k];
    }
    throw new CelEvalError(`cannot index ${typeName(obj)}`);
  }

  private call(func: string, argExprs: Expr[], scope: Scope): unknown {
    // has() and type() need special handling.
    if (func === 'has') {
      const arg = argExprs[0];
      if (!arg || (arg.kind !== 'member' && arg.kind !== 'index')) {
        throw new CelEvalError('has() requires a field selection, e.g. has(a.b)');
      }
      const obj = this.eval(arg.kind === 'member' ? arg.object : arg.object, scope);
      const key = arg.kind === 'member' ? arg.field : String(this.eval(arg.index, scope));
      if (isPlainObject(obj)) return Object.prototype.hasOwnProperty.call(obj, key);
      if (Array.isArray(obj)) return Number(key) >= 0 && Number(key) < obj.length;
      throw new CelEvalError('has() target is not a map or list');
    }
    const args = argExprs.map((e) => this.eval(e, scope));
    if (func === 'type') return typeName(args[0]);
    if (func in this.userFns) return (this.userFns[func] as CelFunction)(args);
    return this.builtinCall(func, args);
  }

  private builtinCall(func: string, args: unknown[]): unknown {
    const a0 = args[0];
    switch (func) {
      case 'size':
        return sizeOf(a0);
      case 'int':
        return Math.trunc(Number(a0));
      case 'double':
        return Number(a0);
      case 'string':
        return a0 instanceof Uint8Array ? new TextDecoder().decode(a0) : String(a0);
      case 'bool':
        return a0 === true || a0 === 'true';
      case 'bytes':
        return typeof a0 === 'string' ? new TextEncoder().encode(a0) : a0;
      case 'dyn':
        return a0;
      case 'matches':
        return typeof a0 === 'string' && cachedRegex(String(args[1])).test(a0);
      case 'ip':
        if (typeof a0 !== 'string' || ipv4ToInt(a0) === null) {
          throw new CelEvalError(`ip() invalid address: ${String(a0)}`);
        }
        return a0;
      case 'cidr': {
        const c = typeof a0 === 'string' ? parseCidr(a0) : null;
        if (!c) throw new CelEvalError(`cidr() invalid: ${String(a0)}`);
        return { [CIDR_TAG]: c } as CidrValue;
      }
      case 'ipInCidr': {
        const c = typeof args[1] === 'string' ? parseCidr(args[1]) : null;
        return typeof a0 === 'string' && c !== null && cidrContains(c, a0);
      }
      case 'jsonField':
        return jsonField(a0, String(args[1]));
      case 'base64Encode':
        return Buffer.from(
          a0 instanceof Uint8Array ? a0 : new TextEncoder().encode(String(a0)),
        ).toString('base64');
      case 'base64Decode':
        return new TextDecoder().decode(Buffer.from(String(a0), 'base64'));
      case 'lowerAscii':
        return String(a0).toLowerCase();
      case 'upperAscii':
        return String(a0).toUpperCase();
      default:
        throw new CelEvalError(`unknown function '${func}'`);
    }
  }

  private method(target: unknown, name: string, argExprs: Expr[], scope: Scope): unknown {
    const args = argExprs.map((e) => this.eval(e, scope));
    if (isCidr(target) && name === 'containsIP') {
      return typeof args[0] === 'string' && cidrContains(target[CIDR_TAG], args[0]);
    }
    if (typeof target === 'string') return this.stringMethod(target, name, args);
    if (Array.isArray(target)) {
      if (name === 'size') return target.length;
      if (name === 'contains') return target.some((x) => equals(x, args[0]));
      if (name === 'join') return target.map((x) => String(x)).join(String(args[0] ?? ''));
    }
    if (isPlainObject(target) && name === 'size') return Object.keys(target).length;
    throw new CelEvalError(`no such method '${name}' on ${typeName(target)}`);
  }

  private stringMethod(s: string, name: string, args: unknown[]): unknown {
    const a0 = args[0];
    switch (name) {
      case 'startsWith':
        return s.startsWith(String(a0));
      case 'endsWith':
        return s.endsWith(String(a0));
      case 'contains':
        return s.includes(String(a0));
      case 'matches':
        return cachedRegex(String(a0)).test(s);
      case 'size':
        return codePointLength(s);
      case 'lowerAscii':
        return s.toLowerCase();
      case 'upperAscii':
        return s.toUpperCase();
      case 'trim':
        return s.trim();
      case 'indexOf':
        return s.indexOf(String(a0));
      case 'replace':
        return s.split(String(a0)).join(String(args[1] ?? ''));
      case 'split':
        return s.split(String(a0));
      case 'substring':
        return s.substring(Number(a0), args[1] === undefined ? undefined : Number(args[1]));
      default:
        throw new CelEvalError(`no such string method '${name}'`);
    }
  }

  private macro(expr: Extract<Expr, { kind: 'macro' }>, scope: Scope): unknown {
    const target = this.eval(expr.target, scope);
    const items: unknown[] = Array.isArray(target)
      ? target
      : isPlainObject(target)
        ? Object.keys(target)
        : (() => {
            throw new CelEvalError(`macro ${expr.macro} requires a list or map`);
          })();

    if (expr.macro === 'map') {
      return items.map((it) => this.eval(expr.body, child(scope, expr.varName, it)));
    }
    if (expr.macro === 'filter') {
      return items.filter((it) =>
        requireBool(this.eval(expr.body, child(scope, expr.varName, it)), 'filter'),
      );
    }
    if (expr.macro === 'all') {
      return items.every((it) =>
        requireBool(this.eval(expr.body, child(scope, expr.varName, it)), 'all'),
      );
    }
    if (expr.macro === 'exists') {
      return items.some((it) =>
        requireBool(this.eval(expr.body, child(scope, expr.varName, it)), 'exists'),
      );
    }
    // exists_one
    let count = 0;
    for (const it of items) {
      if (requireBool(this.eval(expr.body, child(scope, expr.varName, it)), 'exists_one')) count++;
    }
    return count === 1;
  }
}

/** Extract a dotted-path field from a value (map/list). Returns undefined when
 *  any segment is missing — for use inside expressions with `has`-like guards. */
export function jsonField(value: unknown, path: string): unknown {
  let cur = value;
  for (const seg of path.split('.')) {
    // Own properties only: `__proto__.toString` must not walk the prototype chain
    // (the transformer would otherwise stringify a Function into a header).
    if (isPlainObject(cur)) cur = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    else if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else return undefined;
  }
  return cur;
}
