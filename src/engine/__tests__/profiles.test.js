import { describe, it, expect } from 'vitest';
import { PROFILES, PROFILE_LIST, DEFAULT_PROFILE, getProfile } from '../profiles.js';

const REQUIRED_FIELDS = [
  'id', 'name', 'description', 'cylinders', 'layout',
  'idleRPM', 'redlineRPM', 'revCutRPM', 'maxRPM', 'tachoMaxRPM',
  'torqueCurve', 'gearRatios', 'finalDrive', 'tireCircumference',
  'engineInertia', 'vehicleInertia', 'frictionTorque', 'engineBrakingFactor',
  'brakeDecel', 'shiftDuration', 'exhaust', 'audio',
];

const REQUIRED_AUDIO_KEYS = [
  'on_low', 'on_high', 'off_low', 'off_high',
  'off_mid', 'off_veryhigh', 'rev', 'limiter', 'trany', 'tranyDecel',
];

describe('Engine profiles — structure', () => {
  it('PROFILE_LIST has at least 3 profiles', () => {
    expect(PROFILE_LIST.length).toBeGreaterThanOrEqual(3);
  });

  it('PROFILES object keys match profile ids', () => {
    for (const p of PROFILE_LIST) {
      expect(PROFILES[p.id]).toBe(p);
    }
  });

  it('getProfile returns correct profile', () => {
    for (const p of PROFILE_LIST) {
      expect(getProfile(p.id)).toBe(p);
    }
  });

  it('getProfile returns undefined for unknown id', () => {
    expect(getProfile('nonexistent')).toBeUndefined();
  });

  it('DEFAULT_PROFILE is the I4 NA', () => {
    expect(DEFAULT_PROFILE.id).toBe('i4_na');
  });
});

describe('Engine profiles — field validation', () => {
  for (const profile of PROFILE_LIST) {
    describe(profile.id, () => {
      it('has all required fields', () => {
        for (const field of REQUIRED_FIELDS) {
          expect(profile).toHaveProperty(field);
        }
      });

      it('has all required audio keys', () => {
        for (const key of REQUIRED_AUDIO_KEYS) {
          expect(profile.audio).toHaveProperty(key);
        }
      });

      it('audio.tranyDecel has 4 entries', () => {
        expect(profile.audio.tranyDecel).toHaveLength(4);
        for (const entry of profile.audio.tranyDecel) {
          expect(entry).toHaveProperty('band');
          expect(entry).toHaveProperty('file');
        }
      });

      it('torque curve is sorted by RPM', () => {
        for (let i = 1; i < profile.torqueCurve.length; i++) {
          expect(profile.torqueCurve[i][0]).toBeGreaterThan(profile.torqueCurve[i - 1][0]);
        }
      });

      it('gear ratios start with 0 (neutral)', () => {
        expect(profile.gearRatios[0]).toBe(0);
      });

      it('gear ratios are positive after neutral', () => {
        for (let i = 1; i < profile.gearRatios.length; i++) {
          expect(profile.gearRatios[i]).toBeGreaterThan(0);
        }
      });

      it('RPM invariants: idle < revCut < redline <= max', () => {
        expect(profile.idleRPM).toBeLessThan(profile.revCutRPM);
        expect(profile.revCutRPM).toBeLessThan(profile.redlineRPM);
        expect(profile.redlineRPM).toBeLessThanOrEqual(profile.maxRPM);
      });

      it('tachoMaxRPM > redlineRPM', () => {
        expect(profile.tachoMaxRPM).toBeGreaterThan(profile.redlineRPM);
      });

      it('exhaust has pipeLength, diameter, wet', () => {
        expect(profile.exhaust.pipeLength).toBeGreaterThan(0);
        expect(profile.exhaust.diameter).toBeGreaterThan(0);
        expect(profile.exhaust.wet).toBeGreaterThanOrEqual(0);
        expect(profile.exhaust.wet).toBeLessThanOrEqual(1);
      });

      it('has valid cylinder count and layout', () => {
        expect([4, 6, 8]).toContain(profile.cylinders);
        expect(['inline', 'v']).toContain(profile.layout);
      });
    });
  }
});
