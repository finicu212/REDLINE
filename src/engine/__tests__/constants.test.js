import { describe, it, expect } from 'vitest';
import {
  IDLE_RPM, REDLINE_RPM, REV_CUT_RPM, MAX_RPM,
  TACHO_MAX_RPM, TACHO_REDLINE_RPM, normalizeRPM,
} from '../constants.js';

describe('RPM constants', () => {
  it('IDLE_RPM is 850', () => {
    expect(IDLE_RPM).toBe(850);
  });

  it('REDLINE_RPM is 7200', () => {
    expect(REDLINE_RPM).toBe(7200);
  });

  it('REV_CUT_RPM is below REDLINE_RPM (hysteresis)', () => {
    expect(REV_CUT_RPM).toBeLessThan(REDLINE_RPM);
    expect(REV_CUT_RPM).toBeGreaterThan(IDLE_RPM);
  });

  it('MAX_RPM equals REDLINE_RPM', () => {
    expect(MAX_RPM).toBe(REDLINE_RPM);
  });

  it('TACHO_MAX_RPM exceeds REDLINE_RPM for visual headroom', () => {
    expect(TACHO_MAX_RPM).toBeGreaterThan(REDLINE_RPM);
  });

  it('TACHO_REDLINE_RPM equals REDLINE_RPM', () => {
    expect(TACHO_REDLINE_RPM).toBe(REDLINE_RPM);
  });
});

describe('normalizeRPM', () => {
  it('returns 0 at idle', () => {
    expect(normalizeRPM(IDLE_RPM)).toBe(0);
  });

  it('returns 1 at redline', () => {
    expect(normalizeRPM(REDLINE_RPM)).toBe(1);
  });

  it('returns ~0.5 at midpoint', () => {
    const mid = IDLE_RPM + (REDLINE_RPM - IDLE_RPM) / 2;
    expect(normalizeRPM(mid)).toBeCloseTo(0.5, 5);
  });

  it('returns negative for below idle', () => {
    expect(normalizeRPM(0)).toBeLessThan(0);
  });

  it('returns >1 for above redline', () => {
    expect(normalizeRPM(8000)).toBeGreaterThan(1);
  });

  it('is linear (midpoint check)', () => {
    const a = 2000, b = 5000;
    const nA = normalizeRPM(a);
    const nB = normalizeRPM(b);
    const nMid = normalizeRPM((a + b) / 2);
    expect(nMid).toBeCloseTo((nA + nB) / 2, 10);
  });
});
