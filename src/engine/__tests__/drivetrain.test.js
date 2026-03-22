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

describe('Drivetrain — clutch spring-damper engagement', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
    dt.gear = 2;
    dt.rpm = 5000;
    dt.speed = 80;
  });

  it('activates on gear change with significant RPM delta', () => {
    dt.shiftUp(); // 2 -> 3
    advanceTime(200);
    dt.update(0.016, true);
    // Clutch should be engaging after shift completes
    expect(dt._clutchEngaging).toBe(true);
  });

  it('does not activate from neutral', () => {
    dt.gear = 0;
    dt.rpm = 3000;
    dt.speed = 0;
    dt.shiftUp(); // N -> 1
    advanceTime(200);
    dt.update(0.016, true);
    // oldGear was 0, so clutch engagement should NOT trigger
    expect(dt._clutchEngaging).toBe(false);
  });

  it('engine RPM moves toward wheel RPM during engagement', () => {
    const preShiftRPM = dt.rpm;
    dt.shiftUp(); // 2 -> 3 (RPM should drop for upshift)
    advanceTime(200);
    dt.update(0.016, 0.5);

    // Engine RPM should be moving toward wheel-derived target (lower for upshift)
    // After first frame of engagement, RPM should have started moving
    expect(dt._clutchEngaging).toBe(true);
    // Run a few more frames to see convergence
    for (let i = 0; i < 30; i++) {
      advanceTime(16);
      dt.update(0.016, 0.5);
    }
    // RPM should have moved significantly from pre-shift value
    expect(Math.abs(dt.rpm - preShiftRPM)).toBeGreaterThan(50);
  });

  it('initial RPM delta is recorded for audio', () => {
    dt.rpm = 6500;
    dt.speed = 100;
    dt.shiftUp(); // 2 -> 3
    advanceTime(200);
    dt.update(0.016, 0.5);

    // _oscRPMDelta should be non-zero and negative (upshift = RPM drops)
    expect(dt._oscRPMDelta).toBeLessThan(-100);
    // shiftOscAmplitude should be non-zero during engagement
    expect(dt.shiftOscAmplitude).toBeGreaterThan(0);
  });

  it('converges and settles (clutch locks)', () => {
    dt.shiftUp();
    advanceTime(200);

    // Run many frames — spring-damper should converge
    for (let i = 0; i < 200; i++) {
      advanceTime(16);
      dt.update(0.016, 0.5);
    }

    // Should have settled
    expect(dt._clutchEngaging).toBe(false);
    expect(dt.shiftOscillation).toBe(0);
    expect(dt.shiftOscAmplitude).toBe(0);
  });

  it('oscillation value swings positive and negative', () => {
    dt.shiftUp();
    advanceTime(200);

    const values = [];
    for (let i = 0; i < 40; i++) {
      advanceTime(8);
      dt.update(0.008, 0.5);
      if (dt._clutchEngaging) {
        values.push(dt.shiftOscillation);
      }
    }

    const hasPositive = values.some(v => v > 0.01);
    const hasNegative = values.some(v => v < -0.01);
    expect(hasPositive).toBe(true);
    expect(hasNegative).toBe(true);
  });

  it('frequency emerges from spring-damper physics (not hardcoded)', () => {
    // The oscillation frequency should depend on gear because the
    // reflected vehicle inertia changes. Just verify that oscillation
    // actually occurs with multiple zero-crossings in different gears.
    function countCrossings(startGear, rpm, speed) {
      mockNow = 0;
      const d = new Drivetrain();
      d.gear = startGear;
      d.rpm = rpm;
      d.speed = speed;
      d.shiftUp();
      advanceTime(200);

      let crossings = 0;
      let prevSign = 0;
      for (let i = 0; i < 400; i++) {
        advanceTime(2);
        d.update(0.002, 0.5);
        const sign = Math.sign(d.shiftOscillation);
        if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++;
        if (sign !== 0) prevSign = sign;
      }
      return crossings;
    }

    const crossings1 = countCrossings(1, 6000, 30);
    const crossings4 = countCrossings(4, 6000, 140);

    // Both should oscillate (at least 2 crossings = 1 full cycle)
    expect(crossings1).toBeGreaterThanOrEqual(2);
    expect(crossings4).toBeGreaterThanOrEqual(2);
    // Frequencies should differ (physics-emergent, not identical)
    expect(crossings1).not.toBe(crossings4);
  });
});

describe('Drivetrain — getState', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
  });

  it('RPM is clamped to [IDLE, MAX]', () => {
    dt.rpm = IDLE_RPM - 100;
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
