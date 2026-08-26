import { describe, expect, it } from 'vitest';
import { AccessLogFieldEngine, flatten } from './access-log';

const base = () => ({
  requestId: 'req_1',
  provider: 'anthropic',
  statusCode: 200,
  costMicroUsd: 12_500,
  streamed: true,
  principal: { id: 'vk_1', orgId: 'org_1' },
});

describe('AccessLogFieldEngine', () => {
  it('passes the base record through with no config', () => {
    const eng = new AccessLogFieldEngine({});
    expect(eng.build(base())).toMatchObject({ requestId: 'req_1', provider: 'anthropic' });
  });

  it('throws at CONSTRUCTION on a malformed CEL expression', () => {
    // The gateway wiring must catch this so a bad observability knob never downs
    // the data plane (buildAccessLog in context.ts is fail-open around it).
    expect(() => new AccessLogFieldEngine({ add: { bad: 'costMicroUsd / ' } })).toThrow();
    expect(() => new AccessLogFieldEngine({ filter: 'statusCode >=' })).toThrow();
  });

  it('removes fields and adds CEL-computed fields', () => {
    const eng = new AccessLogFieldEngine({
      remove: ['costMicroUsd', 'principal'],
      add: {
        cost_usd: 'costMicroUsd / 1000000.0',
        ok: 'statusCode < 400',
        who: 'principal.orgId',
      },
    });
    const out = eng.build(base());
    expect(out).not.toHaveProperty('costMicroUsd');
    expect(out).not.toHaveProperty('principal');
    expect(out).toMatchObject({ cost_usd: 0.0125, ok: true, who: 'org_1' });
  });

  it('drops a record failing the filter, keeps a passing one', () => {
    const errorsOnly = new AccessLogFieldEngine({ filter: 'statusCode >= 400' });
    expect(errorsOnly.build(base())).toBeNull(); // 200 → dropped
    expect(errorsOnly.build({ ...base(), statusCode: 503 })).not.toBeNull();
  });

  it('is fail-open: a bad field expr is skipped, a bad filter keeps the record', () => {
    const eng = new AccessLogFieldEngine({
      add: { bad: 'nonexistent.deeply.nested', good: 'provider' },
      filter: 'alsoNonexistent.field > 5',
    });
    const out = eng.build(base());
    expect(out).not.toBeNull(); // broken filter → kept
    expect(out).toMatchObject({ good: 'anthropic' }); // good field applied
    // The broken field is simply absent (or undefined), never throws.
    expect(out?.['bad']).toBeUndefined();
  });

  it('flattens nested values to dotted keys when enabled', () => {
    const eng = new AccessLogFieldEngine({ flatten: true });
    const out = eng.build(base());
    expect(out).toMatchObject({ 'principal.id': 'vk_1', 'principal.orgId': 'org_1' });
    expect(out).not.toHaveProperty('principal');
  });

  it('removes a nested field by its flattened name (remove runs after flatten)', () => {
    const eng = new AccessLogFieldEngine({ flatten: true, remove: ['principal.orgId'] });
    const out = eng.build(base());
    expect(out).toHaveProperty('principal.id');
    expect(out).not.toHaveProperty('principal.orgId'); // the nested sub-field is dropped
  });

  it('keeps a present-but-empty field under flatten (never silently absent)', () => {
    const eng = new AccessLogFieldEngine({ flatten: true, add: { tags: '[]' } });
    const out = eng.build(base());
    expect(out).toHaveProperty('tags');
    expect(out?.['tags']).toEqual([]);
  });
});

describe('flatten', () => {
  it('flattens nested objects and arrays', () => {
    expect(flatten({ a: 1, b: { c: 2, d: { e: 3 } }, list: ['x', { y: 4 }] })).toEqual({
      a: 1,
      'b.c': 2,
      'b.d.e': 3,
      'list.0': 'x',
      'list.1.y': 4,
    });
  });

  it('preserves empty objects and arrays instead of dropping them', () => {
    expect(flatten({ a: 1, empty_obj: {}, empty_arr: [] })).toEqual({
      a: 1,
      empty_obj: {},
      empty_arr: [],
    });
  });
});
