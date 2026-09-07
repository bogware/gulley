import { describe, expect, it } from 'vitest';
import {
  isEmptyResidencyPolicy,
  residencyAllowedRegions,
  residencyPolicyFromEnv,
} from './residency-policy';

describe('residencyPolicyFromEnv', () => {
  it('returns undefined when nothing is constrained', () => {
    expect(residencyPolicyFromEnv('', false)).toBeUndefined();
    expect(residencyPolicyFromEnv('  , ,', false)).toBeUndefined();
  });

  it('parses a comma-separated region allowlist (trimmed, blanks dropped)', () => {
    expect(residencyPolicyFromEnv('eu-central-1, eu-west-1 ,', false)).toEqual({
      allowedRegions: ['eu-central-1', 'eu-west-1'],
      requireZdr: false,
    });
  });

  it('is meaningful with requireZdr alone (ZDR-only, no region restriction)', () => {
    const p = residencyPolicyFromEnv('', true);
    expect(p).toEqual({ allowedRegions: [], requireZdr: true });
    expect(isEmptyResidencyPolicy(p)).toBe(false);
  });
});

describe('isEmptyResidencyPolicy', () => {
  it('is empty only when neither region nor ZDR constrains anything', () => {
    expect(isEmptyResidencyPolicy(undefined)).toBe(true);
    expect(isEmptyResidencyPolicy({ allowedRegions: [], requireZdr: false })).toBe(true);
    expect(isEmptyResidencyPolicy({ allowedRegions: ['eu'], requireZdr: false })).toBe(false);
    expect(isEmptyResidencyPolicy({ allowedRegions: [], requireZdr: true })).toBe(false);
  });
});

describe('residencyAllowedRegions', () => {
  it('is a Set of regions, or undefined when unrestricted', () => {
    expect(residencyAllowedRegions(undefined)).toBeUndefined();
    expect(residencyAllowedRegions({ allowedRegions: [], requireZdr: true })).toBeUndefined();
    const set = residencyAllowedRegions({ allowedRegions: ['eu-central-1'], requireZdr: false });
    expect(set?.has('eu-central-1')).toBe(true);
    expect(set?.has('us-east-1')).toBe(false);
  });
});
