import { describe, expect, it } from 'vitest';
import { onDay, shift, viewRange, zoned, type CalendarBlock } from '../src/ui/calendar';

const block = (start: string, end: string, blockedStart = start, blockedEnd = end, timezone = 'Asia/Riyadh'): CalendarBlock => ({
  id: 'b', kind: 'booking', start, end, blockedStart, blockedEnd, timezone, serviceTitle: { en: 'Hall' }, units: 1, bookingRef: null, reason: null,
});

describe('calendar layout', () => {
  it('reads instants in the block country timezone', () => {
    expect(zoned('2028-01-01T21:30:00Z', 'Asia/Riyadh')).toEqual({ day: '2028-01-02', minute: 30 });
    expect(zoned('2028-01-01T21:30:00Z', 'UTC')).toEqual({ day: '2028-01-01', minute: 1290 });
  });

  it('computes whole weeks for the month view and Sunday-based weeks', () => {
    expect(viewRange('month', '2028-02-15')).toEqual({ from: '2028-01-30', to: '2028-03-04' });
    expect(viewRange('week', '2028-02-16')).toEqual({ from: '2028-02-13', to: '2028-02-19' });
    expect(viewRange('day', '2028-02-16')).toEqual({ from: '2028-02-16', to: '2028-02-16' });
    expect(shift('month', '2028-01-31', 1)).toBe('2028-02-01');
    expect(shift('week', '2028-02-16', -1)).toBe('2028-02-09');
  });

  it('clips a block and its buffers to each local day', () => {
    // 16:00-23:00 Riyadh with a one-hour buffer either side (ends at 00:00 next day).
    const b = block('2028-01-01T13:00:00Z', '2028-01-01T20:00:00Z', '2028-01-01T12:00:00Z', '2028-01-01T21:00:00Z');
    expect(onDay(b, '2028-01-01')).toEqual({ from: 960, to: 1380, bufFrom: 900, bufTo: 1440 });
    expect(onDay(b, '2028-01-02')).toBeNull();
    // A full-day booking spanning two local days covers both whole days.
    const two = block('2027-12-31T21:00:00Z', '2028-01-02T21:00:00Z');
    expect(onDay(two, '2028-01-01')).toEqual({ from: 0, to: 1440, bufFrom: 0, bufTo: 1440 });
    expect(onDay(two, '2028-01-02')).toEqual({ from: 0, to: 1440, bufFrom: 0, bufTo: 1440 });
    expect(onDay(two, '2028-01-03')).toBeNull();
  });
});
