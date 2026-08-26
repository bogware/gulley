import { describe, expect, it } from 'vitest';
import { AuthMode, ProviderKind, err, isErr, isOk, ok } from './index';

describe('result', () => {
  it('constructs and narrows ok/err', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(err('boom'))).toBe(true);
  });
});

describe('providers', () => {
  it('accepts known providers and rejects unknown ones', () => {
    expect(ProviderKind.parse('anthropic')).toBe('anthropic');
    expect(() => ProviderKind.parse('nope')).toThrow();
  });

  it('enumerates the client auth modes', () => {
    expect(AuthMode.options).toEqual(['oauth-broker', 'virtual-key', 'passthrough', 'basic']);
  });
});
