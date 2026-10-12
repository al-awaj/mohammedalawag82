import { describe, expect, it } from 'vitest';
import { fromUnits, mulDiv, percentOf, roundToMinor, sum, toUnits } from '../src/lib/money.js';

describe('money', () => {
  it('parses and formats exactly', () => {
    expect(fromUnits(toUnits('1500'))).toBe('1500.0000');
    expect(fromUnits(toUnits('0.1'))).toBe('0.1000');
    expect(fromUnits(toUnits('12.3450'))).toBe('12.3450');
    expect(() => toUnits('1.23456')).toThrow();
    expect(() => toUnits('abc')).toThrow();
  });

  it('avoids floating point drift', () => {
    expect(fromUnits(sum([toUnits('0.1'), toUnits('0.2')]))).toBe('0.3000');
  });

  it('multiplies by rational factors with half-up rounding', () => {
    expect(fromUnits(mulDiv(toUnits('100'), 90, 60))).toBe('150.0000'); // 90 minutes at 100/hour
    expect(fromUnits(mulDiv(toUnits('10'), 1, 3))).toBe('3.3333');
    expect(fromUnits(mulDiv(toUnits('20'), 1, 3))).toBe('6.6667');
  });

  it('computes percentages and rounds to currency minor units', () => {
    expect(fromUnits(percentOf(toUnits('20000'), '25'))).toBe('5000.0000');
    expect(fromUnits(roundToMinor(percentOf(toUnits('333.33'), '12.5'), 2))).toBe('41.6700'); // 41.666…
    expect(fromUnits(roundToMinor(toUnits('1.2345'), 3))).toBe('1.2350'); // KWD-style 3 decimals
    expect(fromUnits(roundToMinor(toUnits('1.005'), 2))).toBe('1.0100');
  });
});
