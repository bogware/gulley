/**
 * CEL (Common Expression Language) AST. A compact, sandboxed subset: literals,
 * identifiers, member/index access, unary/binary/ternary operators, lists, maps,
 * function + method calls, the `has()` macro, and the comprehension macros
 * (all/exists/exists_one/filter/map). No statements, no assignment, no loops —
 * expressions only, so evaluation is bounded and side-effect free.
 */
export type LiteralValue = number | string | boolean | null | Uint8Array;

export type Expr =
  | { kind: 'lit'; value: LiteralValue }
  | { kind: 'ident'; name: string }
  | { kind: 'list'; elements: Expr[] }
  | { kind: 'map'; entries: Array<{ key: Expr; value: Expr }> }
  | { kind: 'unary'; op: '!' | '-'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'ternary'; cond: Expr; then: Expr; otherwise: Expr }
  | { kind: 'member'; object: Expr; field: string }
  | { kind: 'index'; object: Expr; index: Expr }
  | { kind: 'call'; func: string; args: Expr[] }
  | { kind: 'method'; target: Expr; method: string; args: Expr[] }
  | { kind: 'macro'; target: Expr; macro: MacroName; varName: string; body: Expr };

export type BinaryOp =
  '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | 'in';

export const MACROS = ['all', 'exists', 'exists_one', 'filter', 'map'] as const;
export type MacroName = (typeof MACROS)[number];

export function isMacroName(s: string): s is MacroName {
  return (MACROS as readonly string[]).includes(s);
}
