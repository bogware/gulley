import { describe, expect, it } from 'vitest';
import { formatMs, formatNum, formatTokens, formatUsd } from './format';

describe('format helpers', () => {
  it('formatUsd renders micro-USD to 4dp', () => {
    expect(formatUsd(1_234_500)).toBe('$1.2345');
    expect(formatUsd(0)).toBe('$0.0000');
  });
  it('formatTokens compacts thousands/millions', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
  it('formatMs switches to seconds at 1000ms', () => {
    expect(formatMs(250)).toBe('250ms');
    expect(formatMs(1500)).toBe('1.5s');
  });
  it('formatNum groups with locale separators', () => {
    expect(formatNum(1234567)).toBe('1,234,567');
  });
});
