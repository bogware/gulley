import { type BinaryOp, type Expr, isMacroName } from './ast';

export class CelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CelParseError';
  }
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bytes'; v: Uint8Array }
  | { t: 'ident'; v: string }
  | { t: 'kw'; v: 'true' | 'false' | 'null' | 'in' }
  | { t: 'op'; v: string };

const OPS3 = ['==='];
const OPS2 = ['==', '!=', '<=', '>=', '&&', '||'];
const OPS1 = [
  '?',
  ':',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const err = (m: string): never => {
    throw new CelParseError(`${m} at position ${i}`);
  };

  while (i < n) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // string / bytes / raw string with optional prefix
    if (
      c === '"' ||
      c === "'" ||
      ((c === 'r' || c === 'b') && (src[i + 1] === '"' || src[i + 1] === "'"))
    ) {
      let raw = false;
      let bytes = false;
      if (c === 'r') {
        raw = true;
        i++;
      } else if (c === 'b') {
        bytes = true;
        i++;
      }
      const quote = src[i] as string;
      i++;
      let s = '';
      while (i < n && src[i] !== quote) {
        const ch = src[i] as string;
        if (ch === '\\' && !raw) {
          i++;
          const e = src[i] as string;
          if (e === 'n') s += '\n';
          else if (e === 't') s += '\t';
          else if (e === 'r') s += '\r';
          else if (e === '\\') s += '\\';
          else if (e === '"') s += '"';
          else if (e === "'") s += "'";
          else if (e === '0') s += '\0';
          else if (e === 'u') {
            const hex = src.slice(i + 1, i + 5);
            s += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else if (e === 'x') {
            const hex = src.slice(i + 1, i + 3);
            s += String.fromCharCode(parseInt(hex, 16));
            i += 2;
          } else s += e;
          i++;
        } else {
          s += ch;
          i++;
        }
      }
      if (i >= n) err('unterminated string');
      i++; // closing quote
      if (bytes) toks.push({ t: 'bytes', v: new TextEncoder().encode(s) });
      else toks.push({ t: 'str', v: s });
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(src[j] as string)) j++;
        toks.push({ t: 'num', v: parseInt(src.slice(i, j), 16) });
        i = j;
        continue;
      }
      while (j < n && /[0-9]/.test(src[j] as string)) j++;
      if (src[j] === '.') {
        j++;
        while (j < n && /[0-9]/.test(src[j] as string)) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && /[0-9]/.test(src[j] as string)) j++;
      }
      let end = j;
      if (src[end] === 'u' || src[end] === 'U') end++; // uint suffix — treated as number
      toks.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = end;
      continue;
    }
    // identifier / keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j] as string)) j++;
      const word = src.slice(i, j);
      if (word === 'true' || word === 'false' || word === 'null' || word === 'in') {
        toks.push({ t: 'kw', v: word });
      } else {
        toks.push({ t: 'ident', v: word });
      }
      i = j;
      continue;
    }
    // operators
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) {
      toks.push({ t: 'op', v: three });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    err(`unexpected character '${c}'`);
  }
  return toks;
}

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new CelParseError('unexpected end of input');
    this.pos++;
    return t;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === 'op' && t.v === v;
  }
  private eatOp(v: string): boolean {
    if (this.isOp(v)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectOp(v: string): void {
    if (!this.eatOp(v)) throw new CelParseError(`expected '${v}'`);
  }

  parse(): Expr {
    const e = this.ternary();
    if (this.pos !== this.toks.length) throw new CelParseError('trailing tokens after expression');
    return e;
  }

  private ternary(): Expr {
    const cond = this.or();
    if (this.eatOp('?')) {
      const then = this.ternary();
      this.expectOp(':');
      const otherwise = this.ternary();
      return { kind: 'ternary', cond, then, otherwise };
    }
    return cond;
  }

  private or(): Expr {
    let left = this.and();
    while (this.isOp('||')) {
      this.next();
      left = { kind: 'binary', op: '||', left, right: this.and() };
    }
    return left;
  }
  private and(): Expr {
    let left = this.rel();
    while (this.isOp('&&')) {
      this.next();
      left = { kind: 'binary', op: '&&', left, right: this.rel() };
    }
    return left;
  }
  private rel(): Expr {
    let left = this.add();
    for (;;) {
      const t = this.peek();
      const op =
        t?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)
          ? (t.v as BinaryOp)
          : t?.t === 'kw' && t.v === 'in'
            ? ('in' as BinaryOp)
            : undefined;
      if (!op) break;
      this.next();
      left = { kind: 'binary', op, left, right: this.add() };
    }
    return left;
  }
  private add(): Expr {
    let left = this.mul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { v: string }).v as BinaryOp;
      left = { kind: 'binary', op, left, right: this.mul() };
    }
    return left;
  }
  private mul(): Expr {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.next() as { v: string }).v as BinaryOp;
      left = { kind: 'binary', op, left, right: this.unary() };
    }
    return left;
  }
  private unary(): Expr {
    if (this.isOp('!') || this.isOp('-')) {
      const op = (this.next() as { v: string }).v as '!' | '-';
      return { kind: 'unary', op, operand: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.eatOp('.')) {
        const nameTok = this.next();
        if (nameTok.t !== 'ident') throw new CelParseError('expected field name after "."');
        const name = nameTok.v;
        if (this.isOp('(')) {
          if (isMacroName(name)) {
            e = this.macroCall(e, name);
          } else {
            e = { kind: 'method', target: e, method: name, args: this.args() };
          }
        } else {
          e = { kind: 'member', object: e, field: name };
        }
      } else if (this.eatOp('[')) {
        const index = this.ternary();
        this.expectOp(']');
        e = { kind: 'index', object: e, index };
      } else {
        break;
      }
    }
    return e;
  }

  private macroCall(target: Expr, macro: string): Expr {
    this.expectOp('(');
    const v = this.next();
    if (v.t !== 'ident') throw new CelParseError(`macro ${macro} expects an identifier binding`);
    this.expectOp(',');
    const body = this.ternary();
    this.expectOp(')');
    if (!isMacroName(macro)) throw new CelParseError(`unknown macro ${macro}`);
    return { kind: 'macro', target, macro, varName: v.v, body };
  }

  private args(): Expr[] {
    this.expectOp('(');
    const out: Expr[] = [];
    if (!this.isOp(')')) {
      out.push(this.ternary());
      while (this.eatOp(',')) out.push(this.ternary());
    }
    this.expectOp(')');
    return out;
  }

  private primary(): Expr {
    const t = this.peek();
    if (!t) throw new CelParseError('unexpected end of input');
    if (t.t === 'num') {
      this.next();
      return { kind: 'lit', value: t.v };
    }
    if (t.t === 'str') {
      this.next();
      return { kind: 'lit', value: t.v };
    }
    if (t.t === 'bytes') {
      this.next();
      return { kind: 'lit', value: t.v };
    }
    if (t.t === 'kw') {
      this.next();
      if (t.v === 'true') return { kind: 'lit', value: true };
      if (t.v === 'false') return { kind: 'lit', value: false };
      if (t.v === 'null') return { kind: 'lit', value: null };
      throw new CelParseError(`unexpected keyword '${t.v}'`);
    }
    if (t.t === 'ident') {
      this.next();
      if (this.isOp('(')) return { kind: 'call', func: t.v, args: this.args() };
      return { kind: 'ident', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      this.next();
      const e = this.ternary();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'op' && t.v === '[') {
      this.next();
      const elements: Expr[] = [];
      if (!this.isOp(']')) {
        elements.push(this.ternary());
        while (this.eatOp(',')) {
          if (this.isOp(']')) break; // trailing comma
          elements.push(this.ternary());
        }
      }
      this.expectOp(']');
      return { kind: 'list', elements };
    }
    if (t.t === 'op' && t.v === '{') {
      this.next();
      const entries: Array<{ key: Expr; value: Expr }> = [];
      if (!this.isOp('}')) {
        for (;;) {
          const key = this.ternary();
          this.expectOp(':');
          const value = this.ternary();
          entries.push({ key, value });
          if (!this.eatOp(',')) break;
          if (this.isOp('}')) break;
        }
      }
      this.expectOp('}');
      return { kind: 'map', entries };
    }
    throw new CelParseError(`unexpected token '${JSON.stringify(t)}'`);
  }
}

export function parse(source: string): Expr {
  return new Parser(lex(source)).parse();
}
