import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, localized, roundDecimal, toQueryString } from '../src/index';

describe('formatting', () => {
  it('formats exact decimal amounts without floating point', () => {
    expect(formatMoney('15000.0000', 'SAR')).toBe('15,000.00 SAR');
    expect(formatMoney('1234567.125', 'KWD')).toBe('1,234,567.125 KWD');
    expect(formatMoney('0.005', 'SAR')).toBe('0.01 SAR');
    expect(formatMoney('-2608.6956', 'SAR')).toBe('-2,608.70 SAR');
    expect(formatMoney('99999999999999.9950', 'SAR')).toBe('100,000,000,000,000.00 SAR');
    expect(formatMoney(null, 'SAR')).toBe('—');
    expect(roundDecimal('-0.001', 2)).toBe('0.00');
  });
  it('keeps calendar dates on their day and picks the language', () => {
    expect(formatDate('2027-05-01', 'en')).toBe('1 May 2027');
    expect(localized({ ar: 'قاعة', en: 'Hall' }, 'en')).toBe('Hall');
    expect(localized({ ar: 'قاعة' }, 'en')).toBe('قاعة');
    expect(toQueryString({ a: 1, b: undefined, c: '', d: ['x', 'y'] })).toBe('?a=1&d=x&d=y');
  });
});
