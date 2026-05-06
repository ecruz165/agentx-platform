import { describe, expect, it } from 'vitest';
import { compactNum, formatTokenHistory, formatTokens } from './token-format.ts';

describe('compactNum', () => {
  it('returns plain digits below 1000', () => {
    expect(compactNum(0)).toBe('0');
    expect(compactNum(7)).toBe('7');
    expect(compactNum(340)).toBe('340');
    expect(compactNum(999)).toBe('999');
  });

  it('uses k with one decimal in 1k–10k range', () => {
    expect(compactNum(1000)).toBe('1.0k');
    expect(compactNum(1234)).toBe('1.2k');
    expect(compactNum(9999)).toBe('10.0k');
  });

  it('rounds k from 10k upward', () => {
    expect(compactNum(10_000)).toBe('10k');
    expect(compactNum(12_500)).toBe('13k');
    expect(compactNum(99_999)).toBe('100k');
  });

  it('uses m with decimals/rounding above 1m', () => {
    expect(compactNum(1_500_000)).toBe('1.5m');
    expect(compactNum(15_000_000)).toBe('15m');
  });
});

describe('formatTokens', () => {
  it('renders the up/down arrow pair', () => {
    expect(formatTokens({ in: 1234, out: 340 })).toBe('↑1.2k ↓340');
  });

  it('handles zero values', () => {
    expect(formatTokens({ in: 0, out: 0 })).toBe('↑0 ↓0');
  });
});

describe('formatTokenHistory', () => {
  it('returns empty string for undefined or empty history', () => {
    expect(formatTokenHistory(undefined, 50)).toBe('');
    expect(formatTokenHistory([], 50)).toBe('');
  });

  it('renders one entry', () => {
    expect(formatTokenHistory([{ in: 1234, out: 340 }], 50)).toBe('↑1.2k ↓340');
  });

  it('joins multiple entries with single-space separator', () => {
    const out = formatTokenHistory(
      [
        { in: 1234, out: 340 },
        { in: 1500, out: 220 },
      ],
      50,
    );
    expect(out).toBe('↑1.2k ↓340 ↑1.5k ↓220');
  });

  it('truncates with +N when more entries exist than fit', () => {
    // Each "↑1.2k ↓340" is ~10 chars; reserve 4 for "+N" tail. Width
    // 14 fits exactly one entry then "+N".
    const history = [
      { in: 1234, out: 340 },
      { in: 1500, out: 220 },
      { in: 1700, out: 100 },
      { in: 2000, out: 80 },
    ];
    const out = formatTokenHistory(history, 14);
    expect(out).toMatch(/^↑1\.2k ↓340 \+\d+$/);
    expect(out).toContain('+3'); // 3 remaining after the first
  });

  it('renders all entries when width is generous', () => {
    const history = [
      { in: 1, out: 1 },
      { in: 2, out: 2 },
      { in: 3, out: 3 },
    ];
    const out = formatTokenHistory(history, 100);
    expect(out).toBe('↑1 ↓1 ↑2 ↓2 ↑3 ↓3');
  });

  it('the last entry does not need to reserve "+N" space', () => {
    // Width that just barely fits the second entry but no "+N" tail.
    // First "↑1 ↓1" = 5 chars; sep 1; second "↑1 ↓1" = 5 chars. Total
    // 11. With width=11, both fit because the last entry doesn't
    // reserve tail space.
    const out = formatTokenHistory(
      [
        { in: 1, out: 1 },
        { in: 1, out: 1 },
      ],
      11,
    );
    expect(out).toBe('↑1 ↓1 ↑1 ↓1');
  });
});
