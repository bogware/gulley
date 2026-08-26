import { describe, expect, it } from 'vitest';
import { applyHeaderRules } from './headers';

describe('applyHeaderRules', () => {
  it('sets and removes headers case-insensitively', () => {
    const h: Record<string, string> = { 'x-keep': 'y', 'x-drop': 'z' };
    applyHeaderRules(h, { set: { 'X-Added': 'v' }, remove: ['X-Drop'] });
    expect(h).toEqual({ 'x-keep': 'y', 'x-added': 'v' });
  });

  it('set wins over remove for the same name, and undefined rules are a no-op', () => {
    const h: Record<string, string> = { 'x-a': '1' };
    applyHeaderRules(h, { set: { 'x-b': '2' }, remove: ['x-b'] });
    expect(h['x-b']).toBe('2');
    expect(applyHeaderRules({ a: '1' }, undefined)).toEqual({ a: '1' });
  });
});
