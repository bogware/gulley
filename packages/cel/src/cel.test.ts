import { describe, expect, it } from 'vitest';
import { CelEvalError } from './eval';
import { CelParseError } from './parse';
import { compile } from './program';

function ev(src: string, root: Record<string, unknown> = {}): unknown {
  return compile(src).eval(root);
}

describe('CEL literals & operators', () => {
  it('evaluates arithmetic, comparison, and logic', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 % 3')).toBe(1);
    expect(ev('2 < 3 && 3 <= 3')).toBe(true);
    expect(ev('1 == 1 && 1 != 2')).toBe(true);
    expect(ev('true || false')).toBe(true);
    expect(ev('!false')).toBe(true);
    expect(ev('"a" + "b"')).toBe('ab');
    expect(ev('-5 + 2')).toBe(-3);
  });

  it('short-circuits && and ||', () => {
    // right side would error (undefined var) but is never evaluated
    expect(ev('false && missing')).toBe(false);
    expect(ev('true || missing')).toBe(true);
  });

  it('ternary and in', () => {
    expect(ev('2 > 1 ? "yes" : "no"')).toBe('yes');
    expect(ev('2 in [1, 2, 3]')).toBe(true);
    expect(ev('"k" in {"k": 1}')).toBe(true);
    expect(ev('"q" in "text"')).toBe(false);
    expect(ev('"ex" in "text"')).toBe(true);
  });

  it('lists, maps, member and index', () => {
    expect(ev('[1, 2, 3][1]')).toBe(2);
    expect(ev('{"a": 1, "b": 2}["b"]')).toBe(2);
    expect(ev('{"a": {"b": 42}}.a.b')).toBe(42);
    expect(ev('[1, 2] + [3]')).toEqual([1, 2, 3]);
  });
});

describe('CEL variables & has()', () => {
  const root = { request: { model: 'gpt-4o', headers: { 'x-team': 'blue' } } };
  it('reads variables and nested fields', () => {
    expect(ev('request.model', root)).toBe('gpt-4o');
    expect(ev('request.headers["x-team"]', root)).toBe('blue');
  });
  it('has() tests field presence without erroring', () => {
    expect(ev('has(request.model)', root)).toBe(true);
    expect(ev('has(request.temperature)', root)).toBe(false);
    expect(ev('has(request.headers["x-team"])', root)).toBe(true);
  });
  it('errors on an undefined variable', () => {
    expect(() => ev('nope')).toThrow(CelEvalError);
  });
});

describe('CEL string methods & functions', () => {
  it('string methods', () => {
    expect(ev('"hello".startsWith("he")')).toBe(true);
    expect(ev('"hello".endsWith("lo")')).toBe(true);
    expect(ev('"hello".contains("ell")')).toBe(true);
    expect(ev('"a,b,c".split(",")')).toEqual(['a', 'b', 'c']);
    expect(ev('"Hello".lowerAscii()')).toBe('hello');
    expect(ev('"  x  ".trim()')).toBe('x');
    expect(ev('"claude-3-5-haiku".matches("^claude-3")')).toBe(true);
  });
  it('global functions: size, type, jsonField, base64', () => {
    expect(ev('size([1,2,3])')).toBe(3);
    expect(ev('size("abc")')).toBe(3);
    expect(ev('type("x")')).toBe('string');
    expect(ev('type(123)')).toBe('number');
    expect(ev('jsonField({"a": {"b": 7}}, "a.b")')).toBe(7);
    expect(ev('base64Decode(base64Encode("hi"))')).toBe('hi');
  });
  it('ip / cidr helpers', () => {
    expect(ev('cidr("10.0.0.0/8").containsIP("10.1.2.3")')).toBe(true);
    expect(ev('cidr("10.0.0.0/8").containsIP("11.0.0.1")')).toBe(false);
    expect(ev('ipInCidr("192.168.1.5", "192.168.0.0/16")')).toBe(true);
    expect(() => ev('ip("999.1.1.1")')).toThrow();
  });
});

describe('CEL comprehension macros', () => {
  const root = { xs: [1, 2, 3, 4], models: ['gpt-4o', 'claude-3', 'gpt-4o-mini'] };
  it('all / exists / exists_one', () => {
    expect(ev('xs.all(x, x > 0)', root)).toBe(true);
    expect(ev('xs.all(x, x > 2)', root)).toBe(false);
    expect(ev('xs.exists(x, x == 3)', root)).toBe(true);
    expect(ev('xs.exists_one(x, x == 3)', root)).toBe(true);
    expect(ev('models.exists_one(m, m.startsWith("gpt"))', root)).toBe(false);
  });
  it('filter / map', () => {
    expect(ev('xs.filter(x, x % 2 == 0)', root)).toEqual([2, 4]);
    expect(ev('xs.map(x, x * 10)', root)).toEqual([10, 20, 30, 40]);
    expect(ev('models.filter(m, m.startsWith("gpt"))', root)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });
});

describe('CEL compile: attribute inference & strict mode', () => {
  it('infers root variables and second-level attributes', () => {
    const p = compile('request.model == "x" && principal.scope.orgId != "" && request.body.stream');
    expect([...p.roots].sort()).toEqual(['principal', 'request']);
    expect(p.attributes).toContain('request.model');
    expect(p.attributes).toContain('request.body');
    expect(p.attributes).toContain('principal.scope');
    expect(p.reads('request.body')).toBe(true);
    expect(p.reads('request.headers')).toBe(false);
  });
  it('excludes macro-bound variables from roots', () => {
    const p = compile('items.all(x, x.ok)');
    expect(p.roots).toEqual(['items']); // x is bound, not a root
  });
  it('strict compile rejects undeclared roots', () => {
    expect(() => compile('request.model', { declaredVars: ['principal'] })).toThrow(CelParseError);
    expect(() => compile('request.model', { declaredVars: ['request'] })).not.toThrow();
  });
});

describe('CEL user functions & tracing', () => {
  it('supports user-defined functions', () => {
    const p = compile('double(21)');
    expect(p.eval({}, { functions: { double: (a) => Number(a[0]) * 2 } })).toBe(42);
  });
  it('bounds evaluation cost', () => {
    // A huge comprehension exceeds the step cap.
    const p = compile('xs.map(x, x).map(y, y)');
    const xs = Array.from({ length: 100 }, (_, i) => i);
    expect(() => p.eval({ xs }, { maxSteps: 50 })).toThrow(/step limit/);
  });
  it('parse errors are reported', () => {
    expect(() => compile('1 +')).toThrow(CelParseError);
    expect(() => compile('a b c')).toThrow(CelParseError);
  });
});
