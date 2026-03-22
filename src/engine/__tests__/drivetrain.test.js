import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Drivetrain, GEAR_RATIOS, FINAL_DRIVE } from '../drivetrain.js';
import { IDLE_RPM, REDLINE_RPM, REV_CUT_RPM, MAX_RPM } from '../constants.js';

// Mock performance.now for shift timing
let mockNow = 0;
vi.stubGlobal('performance', { now: () => mockNow });

function advanceTime(ms) {
  mockNow += ms;
}

describe('Drivetrain — construction', () => {
  it('starts at idle RPM in neutral', () => {
    const dt = new Drivetrain();
    expect(dt.rpm).toBe(IDLE_RPM);
    expect(dt.gear).toBe(0);
    expect(dt.speed).toBe(0);
  });

  it('isNeutral is true in gear 0', () => {
    const dt = new Drivetrain();
    expect(dt.isNeutral).toBe(true);
  });

  it('gearLabel is "N" in neutral', () => {
    const dt = new Drivetrain();
    expect(dt.gearLabel).toBe('N');
  });

  it('revLimiter is inactive', () => {
    const dt = new Drivetrain();
    expect(dt.revLimiterActive).toBe(false);
  });

  it('shift oscillation starts at 0', () => {
    const dt = new Drivetrain();
    expect(dt.shiftOscillation).toBe(0);
    expect(dt.shiftOscAmplitude).toBe(0);
  });
});

describe('Drivetrain — gear shifting', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
  });

  it('can shift from neutral to 1st', () => {
    expect(dt.shiftUp()).toBe(true);
    // During shift, gearLabel is "-"
    expect(dt.gearLabel).toBe('-');
    expect(dt._shifting).toBe(true);
  });

  it('cannot shift up past 5th', () => {
    dt.gear = 5;
    expect(dt.shiftUp()).toBe(false);
  });

  it('cannot shift down from neutral', () => {
    expect(dt.shiftDown()).toBe(false);
  });

  it('cannot double-shift while shifting', () => {
    dt.shiftUp(); // N -> 1
    expect(dt.shiftUp()).toBe(false); // already shifting
  });

  it('completes shift after SHIFT_DURATION', () => {
    dt.shiftUp(); // N -> 1
    advanceTime(200); // > 150ms shift duration
    dt.update(0.016, false);
    expect(dt._shifting).toBe(false);
    expect(dt.gear).toBe(1);
    expect(dt.gearLabel).toBe('1');
  });

  it('shifts through all gears sequentially', () => {
    for (let g = 1; g <= 5; g++) {
      dt.shiftUp();
      advanceTime(200);
      dt.update(0.016, true);
      expect(dt.gear).toBe(g);
    }
  });

  it('shifts down from 3rd to 2nd', () => {
    // Get to 3rd gear
    dt.gear = 3;
    dt.rpm = 4000;
    dt.speed = 60;
    expect(dt.shiftDown()).toBe(true);
    advanceTime(200);
    dt.update(0.016, false);
    expect(dt.gear).toBe(2);
  });

  it('over-rev protection blocks dangerous downshifts', () => {
    dt.gear = 5;
    dt.speed = 200; // very high speed
    dt.rpm = 6000;
    // Downshift to 4th at 200 km/h would exceed MAX_RPM
    const result = dt.shiftDown();
    // If projected RPM > MAX_RPM, should be blocked
    const newRatio = GEAR_RATIOS[4] * FINAL_DRIVE;
    const wheelRPS = (200 / 3.6) / 1.88;
    const projectedRPM = wheelRPS * 60 * newRatio;
    if (projectedRPM > MAX_RPM) {
      expect(result).toBe(false);
    } else {
      expect(result).toBe(true);
    }
  });

  it('allows downshift to neutral regardless of speed', () => {
    dt.gear = 1;
    dt.speed = 100;
    dt.rpm = 6000;
    expect(dt.shiftDown()).toBe(true);
    advanceTime(200);
    dt.update(0.016, false);
    expect(dt.gear).toBe(0);
  });
});

describe('Drivetrain — physics update', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
  });

  it('RPM stays at idle with no throttle in neutral', () => {
    dt.update(0.016, false);
    // Should stay at idle (friction brings it down, clamped to idle)
    expect(dt.rpm).toBe(IDLE_RPM);
  });

  it('RPM increases with throttle in neutral', () => {
    dt.update(0.1, true);
    expect(dt.rpm).toBeGreaterThan(IDLE_RPM);
  });

  it('RPM increases with throttle in gear', () => {
    dt.gear = 1;
    const startRPM = IDLE_RPM;
    dt.update(0.05, true);
    expect(dt.rpm).toBeGreaterThan(startRPM);
  });

  it('RPM never drops below IDLE_RPM', () => {
    dt.rpm = IDLE_RPM;
    dt.update(0.1, false); // no throttle, friction
    expect(dt.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
  });

  it('RPM never exceeds MAX_RPM', () => {
    dt.rpm = MAX_RPM - 10;
    // Many rapid throttle updates
    for (let i = 0; i < 100; i++) {
      dt.update(0.05, true);
    }
    expect(dt.rpm).toBeLessThanOrEqual(MAX_RPM);
  });

  it('dt is clamped to 50ms to prevent physics explosions', () => {
    dt.gear = 1;
    const rpm1 = dt.rpm;
    dt.update(5.0, true); // 5 seconds in one call — should be clamped
    const jump = dt.rpm - rpm1;

    dt.rpm = rpm1;
    dt.update(0.05, true); // 50ms (the clamp)
    const clampedJump = dt.rpm - rpm1;

    // 5s update should produce same result as 50ms (clamped)
    expect(jump).toBeCloseTo(clampedJump, 3);
  });

  it('speed increases when in gear with throttle', () => {
    dt.gear = 1;
    dt.rpm = 3000;
    dt.update(0.05, true);
    expect(dt.speed).toBeGreaterThan(0);
  });

  it('speed decreases with drag in neutral', () => {
    dt.speed = 100;
    dt.update(0.05, false);
    expect(dt.speed).toBeLessThan(100);
  });
});

describe('Drivetrain — rev limiter', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
  });

  it('activates at REDLINE_RPM', () => {
    dt.rpm = REDLINE_RPM;
    dt.update(0.016, true);
    expect(dt.revLimiterActive).toBe(true);
  });

  it('deactivates below REV_CUT_RPM (hysteresis)', () => {
    dt.revLimiterActive = true;
    dt.rpm = REV_CUT_RPM - 1;
    dt.update(0.016, false);
    expect(dt.revLimiterActive).toBe(false);
  });

  it('stays active between REV_CUT and REDLINE (hysteresis band)', () => {
    dt.revLimiterActive = true;
    dt.rpm = (REV_CUT_RPM + REDLINE_RPM) / 2;
    dt.update(0.016, true);
    expect(dt.revLimiterActive).toBe(true);
  });

  it('blocks drive torque when active', () => {
    dt.rpm = REDLINE_RPM - 50;
    dt.revLimiterActive = true;
    const rpmBefore = dt.rpm;
    dt.update(0.016, true); // throttle ON but limiter blocks it
    // RPM should decrease or stay (resistance torque > 0, drive torque = 0)
    expect(dt.rpm).toBeLessThanOrEqual(rpmBefore);
  });
});

describe('Drivetrain — braking', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
  });

  it('reduces speed when braking', () => {
    dt.speed = 100;
    dt.gear = 3;
    dt.rpm = 4000;
    dt.update(0.05, false, true); // braking = true
    expect(dt.speed).toBeLessThan(100);
  });

  it('speed does not go negative', () => {
    dt.speed = 1;
    dt.update(0.5, false, true);
    expect(dt.speed).toBeGreaterThanOrEqual(0);
  });

  it('RPM syncs to braked wheel speed when in gear', () => {
    dt.gear = 3;
    dt.rpm = 5000;
    dt.speed = 100;
    dt.update(0.05, false, true);
    // RPM should drop along with speed
    expect(dt.rpm).toBeLessThan(5000);
    expect(dt.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
  });

  it('braking in neutral only slows car, not engine', () => {
    dt.gear = 0;
    dt.rpm = 3000;
    dt.speed = 80;
    dt.update(0.05, false, true);
    expect(dt.speed).toBeLessThan(80);
    // In neutral, RPM decays from friction but not from braking directly
  });
});

describe('Drivetrain — shift oscillation', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
    dt.gear = 2;
    dt.rpm = 5000;
    dt.speed = 80;
  });

  it('triggers on gear change with significant RPM delta', () => {
    dt.shiftUp(); // 2 -> 3
    advanceTime(200);
    dt.update(0.016, true);
    // Oscillation should be active after shift completes
    expect(dt._oscActive).toBe(true);
  });

  it('does not trigger from neutral', () => {
    dt.gear = 0;
    dt.rpm = 3000;
    dt.speed = 0;
    dt.shiftUp(); // N -> 1
    advanceTime(200);
    dt.update(0.016, true);
    // oldGear was 0, so oscillation should NOT trigger
    expect(dt._oscActive).toBe(false);
  });

  it('amplitude scales with RPM delta', () => {
    dt.rpm = 6500;
    dt.speed = 100;
    dt.shiftUp(); // 2 -> 3, big RPM drop
    advanceTime(200);
    dt.update(0.016, true);
    const bigAmp = dt.shiftOscAmplitude;

    // Reset
    mockNow = 0;
    const dt2 = new Drivetrain();
    dt2.gear = 2;
    dt2.rpm = 2500;
    dt2.speed = 40;
    dt2.shiftUp();
    advanceTime(200);
    dt2.update(0.016, true);
    const smallAmp = dt2.shiftOscAmplitude;

    // Bigger RPM delta should produce bigger amplitude
    expect(bigAmp).toBeGreaterThan(smallAmp);
  });

  it('decays over time', () => {
    dt.shiftUp();
    advanceTime(200);
    dt.update(0.016, true);
    const amp1 = dt.shiftOscAmplitude;

    advanceTime(300);
    dt.update(0.016, true);
    const amp2 = dt.shiftOscAmplitude;

    expect(amp2).toBeLessThan(amp1);
  });

  it('stops after OSCILLATION_DURATION', () => {
    dt.shiftUp();
    advanceTime(200);
    dt.update(0.016, true);
    expect(dt._oscActive).toBe(true);

    advanceTime(1200); // > 1.0s oscillation duration
    dt.update(0.016, true);
    expect(dt._oscActive).toBe(false);
    expect(dt.shiftOscillation).toBe(0);
    expect(dt.shiftOscAmplitude).toBe(0);
  });

  it('oscillation value swings positive and negative', () => {
    dt.shiftUp();
    advanceTime(200);

    const values = [];
    for (let i = 0; i < 20; i++) {
      advanceTime(15);
      dt.update(0.016, true);
      values.push(dt.shiftOscillation);
    }

    const hasPositive = values.some(v => v > 0.001);
    const hasNegative = values.some(v => v < -0.001);
    expect(hasPositive).toBe(true);
    expect(hasNegative).toBe(true);
  });
});

describe('Drivetrain — getState', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
  });

  it('returns display RPM with oscillation offset', () => {
    dt.gear = 2;
    dt.rpm = 5000;
    dt.speed = 80;
    dt.shiftUp();
    advanceTime(200);
    dt.update(0.016, true);

    // Physics RPM and display RPM should differ during oscillation
    const state = dt.getState();
    const physicsRPM = dt.rpm;
    // Display RPM includes oscillation offset
    if (dt._oscActive && dt.shiftOscillation !== 0) {
      expect(state.rpm).not.toBe(physicsRPM);
    }
  });

  it('display RPM is clamped to [IDLE, MAX]', () => {
    dt.rpm = IDLE_RPM + 50;
    dt._oscActive = true;
    dt._oscRPMDelta = -5000;
    dt.shiftOscillation = -1; // maximum negative swing

    const state = dt.getState();
    expect(state.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
    expect(state.rpm).toBeLessThanOrEqual(MAX_RPM);
  });

  it('includes all expected fields', () => {
    const state = dt.getState();
    expect(state).toHaveProperty('rpm');
    expect(state).toHaveProperty('speed');
    expect(state).toHaveProperty('gear');
    expect(state).toHaveProperty('gearLabel');
    expect(state).toHaveProperty('shifting');
    expect(state).toHaveProperty('revLimiterActive');
    expect(state).toHaveProperty('throttle');
    expect(state).toHaveProperty('totalRatio');
    expect(state).toHaveProperty('effectiveInertia');
    expect(state).toHaveProperty('torqueNm');
    expect(state).toHaveProperty('shiftOscillation');
    expect(state).toHaveProperty('shiftOscAmplitude');
    expect(state).toHaveProperty('shiftOscRPMDelta');
  });

  it('totalRatio is 0 in neutral', () => {
    expect(dt.getState().totalRatio).toBe(0);
  });

  it('totalRatio is gear_ratio * final_drive in gear', () => {
    dt.gear = 3;
    const expected = GEAR_RATIOS[3] * FINAL_DRIVE;
    expect(dt.getState().totalRatio).toBeCloseTo(expected, 5);
  });

  it('effectiveInertia increases with lower gear ratio (higher load)', () => {
    dt.gear = 1; // tallest ratio
    const inertia1 = dt.getState().effectiveInertia;
    dt.gear = 5; // shortest ratio
    const inertia5 = dt.getState().effectiveInertia;
    // Lower gear = higher ratio = more vehicle inertia reflected
    expect(inertia1).toBeLessThan(inertia5);
  });
});

describe('Drivetrain — gear ratios', () => {
  it('has 6 entries (neutral + 5 gears)', () => {
    expect(GEAR_RATIOS).toHaveLength(6);
  });

  it('neutral ratio is 0', () => {
    expect(GEAR_RATIOS[0]).toBe(0);
  });

  it('ratios decrease from 1st to 5th', () => {
    for (let i = 2; i <= 5; i++) {
      expect(GEAR_RATIOS[i]).toBeLessThan(GEAR_RATIOS[i - 1]);
    }
  });

  it('final drive is positive', () => {
    expect(FINAL_DRIVE).toBeGreaterThan(0);
  });
});
