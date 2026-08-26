import type { Expr } from './ast';
import { type CelFunction, type EvalOptions, Evaluator } from './eval';
import { CelParseError, parse } from './parse';

export interface CompileOptions {
  /** Root variables the expression may reference. In strict mode any other root
   *  identifier is a compile error; omit for permissive compilation. */
  declaredVars?: readonly string[];
  /** Reject a reference to a root identifier not in `declaredVars`. Default true
   *  when `declaredVars` is provided. */
  strict?: boolean;
}

/**
 * A compiled CEL expression: parse + validate + static attribute inference done
 * once, evaluated many times. `roots` are the top-level variables it reads;
 * `attributes` are the second-level paths (e.g. `request.body`, `principal.id`)
 * — the gateway uses this to decide whether a policy needs the (buffered) body,
 * so a policy that never touches `request.body` keeps the raw-pipe fast path.
 */
export class Program {
  constructor(
    readonly source: string,
    readonly ast: Expr,
    readonly roots: readonly string[],
    readonly attributes: readonly string[],
  ) {}

  /** Evaluate against a root activation (plain object of variables). */
  eval(root: Record<string, unknown>, opts?: EvalOptions): unknown {
    return new Evaluator(opts).run(this.ast, root);
  }

  /** Evaluate and require a boolean result (for predicates / authz rules). */
  evalBool(root: Record<string, unknown>, opts?: EvalOptions): boolean {
    const v = this.eval(root, opts);
    if (typeof v !== 'boolean') throw new CelParseError('expression did not evaluate to a bool');
    return v;
  }

  /** True if the expression reads any attribute under one of `rootsToCheck`
   *  (e.g. `program.reads('request.body')`). */
  reads(path: string): boolean {
    return this.attributes.includes(path) || this.roots.includes(path);
  }
}

function inferAttributes(
  expr: Expr,
  bound: ReadonlySet<string>,
  roots: Set<string>,
  paths: Set<string>,
): void {
  const rec = (e: Expr, b: ReadonlySet<string>): void => inferAttributes(e, b, roots, paths);
  switch (expr.kind) {
    case 'lit':
      return;
    case 'ident':
      if (!bound.has(expr.name)) roots.add(expr.name);
      return;
    case 'list':
      expr.elements.forEach((e) => rec(e, bound));
      return;
    case 'map':
      expr.entries.forEach(({ key, value }) => {
        rec(key, bound);
        rec(value, bound);
      });
      return;
    case 'unary':
      rec(expr.operand, bound);
      return;
    case 'binary':
      rec(expr.left, bound);
      rec(expr.right, bound);
      return;
    case 'ternary':
      rec(expr.cond, bound);
      rec(expr.then, bound);
      rec(expr.otherwise, bound);
      return;
    case 'member':
      if (expr.object.kind === 'ident' && !bound.has(expr.object.name)) {
        paths.add(`${expr.object.name}.${expr.field}`);
      }
      rec(expr.object, bound);
      return;
    case 'index':
      rec(expr.object, bound);
      rec(expr.index, bound);
      return;
    case 'call':
      expr.args.forEach((e) => rec(e, bound));
      return;
    case 'method':
      rec(expr.target, bound);
      expr.args.forEach((e) => rec(e, bound));
      return;
    case 'macro': {
      rec(expr.target, bound);
      const inner = new Set(bound);
      inner.add(expr.varName);
      inferAttributes(expr.body, inner, roots, paths);
      return;
    }
  }
}

export function compile(source: string, opts: CompileOptions = {}): Program {
  const ast = parse(source);
  const roots = new Set<string>();
  const paths = new Set<string>();
  inferAttributes(ast, new Set(), roots, paths);

  const strict = opts.strict ?? opts.declaredVars !== undefined;
  if (strict && opts.declaredVars) {
    const declared = new Set(opts.declaredVars);
    for (const r of roots) {
      if (!declared.has(r)) {
        throw new CelParseError(`unknown variable '${r}' (declared: ${[...declared].join(', ')})`);
      }
    }
  }
  return new Program(source, ast, [...roots], [...paths]);
}

export type { CelFunction };
