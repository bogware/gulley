import { describe, expect, it } from 'vitest';
import { affectedRows } from './affected-rows';

/**
 * Regression for the generation-guarded CAS bug: the prod postgres-js driver returns a
 * Result that is an Array subclass with `.count` and NO `.rowCount`, so the old
 * `rowCount === 1 || Array.isArray(res)` heuristic reported a 0-row (lost-race) UPDATE as
 * a success. `affectedRows` must read the count from either driver — the pglite tests
 * (which have rowCount) could never catch this.
 */
describe('affectedRows (driver-portable CAS row count)', () => {
  it('reads .rowCount (pglite) and .count (postgres-js Array Result)', () => {
    expect(affectedRows({ rowCount: 1 })).toBe(1);
    expect(affectedRows({ rowCount: 0 })).toBe(0);
    // postgres-js: Result extends Array; a 1-row and a 0-row UPDATE are both Arrays.
    const oneRow = Object.assign([], { count: 1 });
    const zeroRow = Object.assign([], { count: 0 });
    expect(affectedRows(oneRow)).toBe(1);
    expect(affectedRows(zeroRow)).toBe(0);
    // The OLD heuristic Array.isArray(res) would have returned true for BOTH of these.
    expect(Array.isArray(zeroRow) && affectedRows(zeroRow) === 0).toBe(true);
  });

  it('defaults to 0 for a shapeless/undefined result (fail-closed CAS)', () => {
    expect(affectedRows(undefined)).toBe(0);
    expect(affectedRows({})).toBe(0);
  });
});
