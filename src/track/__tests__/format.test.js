import { describe, it, expect } from 'vitest';
import { fmtLap, fmtDelta } from '../format.js';

describe('fmtLap / fmtDelta', () => {
  it('formats minutes, seconds and millis', () => {
    expect(fmtLap(83.4567)).toBe('1:23.457');
    expect(fmtLap(5.1, 2)).toBe('0:05.10');
  });
  it('carries rounding into the minute (no 0:60.000)', () => {
    expect(fmtLap(59.9996)).toBe('1:00.000');
    expect(fmtLap(119.996, 2)).toBe('2:00.00');
  });
  it('placeholders for missing values', () => {
    expect(fmtLap(null)).toBe('–:––.–––');
    expect(fmtLap(NaN, 2)).toBe('–:––.––');
    expect(fmtDelta(null)).toBe('');
  });
  it('signed deltas', () => {
    expect(fmtDelta(-0.4234)).toBe('−0.42');
    expect(fmtDelta(0.1)).toBe('+0.10');
  });
});
