import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Drivetrain, GEAR_RATIOS, FINAL_DRIVE } from '../drivetrain.js';
import { IDLE_RPM, REDLINE_RPM, REV_CUT_RPM, MAX_RPM } from '../constants.js';

// Mock performance.now for timing
let mockNow = 0;
vi.stubGlobal('performance', { now: () => mockNow });

function advanceTime(ms) {
  mockNow += ms;
}

/** Helper: hold clutch, shift, release clutch, run frames until settled. */
function clutchShift(dt, direction, throttle = 0.5, frames = 200) {
  dt.clutchHeld = true;
  dt.update(0.001, throttle); // one frame with clutch held
  if (direction > 0) dt.shiftUp();
  else dt.shiftDown();
  dt.clutchHeld = false;
  dt.update(0.001, throttle); // release triggers engagement
  for (let i = 0; i < frames; i++) {
    advanceTime(8);
    dt.update(0.008, throttle);
  }
}

describe('Drivetrain — construction', () => {
  it('starts at idle RPM in neutral', () => {
    const dt = new Drivetrain();
    expect(dt.rpm).toBe(IDLE_RPM);
    expect(dt.gear).toBe(0);
    expect(dt.speed).toBe(0);
  });

  it('isDecoupled is true in neutral', () => {
    const dt = new Drivetrain();
    expect(dt.isDecoupled).toBe(true);
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

describe('Drivetrain — clutch and shifting', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
  });

  it('cannot shift without clutch when in gear', () => {
    // Get into 1st gear first
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp(); // N -> 1 (from neutral, ok)
    dt.clutchHeld = false;
    dt.update(0.001, 0);

    // Now in 1st, try to shift without clutch
    expect(dt.gear).toBe(1);
    expect(dt.shiftUp()).toBe(false);
  });

  it('can shift from neutral without clutch', () => {
    expect(dt.shiftUp()).toBe(true);
    expect(dt.gear).toBe(1);
  });

  it('can shift with clutch held', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp(); // N -> 1
    expect(dt.gear).toBe(1);
    dt.shiftUp(); // 1 -> 2
    expect(dt.gear).toBe(2);
  });

  it('cannot shift up past 5th', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    for (let i = 0; i < 5; i++) dt.shiftUp();
    expect(dt.gear).toBe(5);
    expect(dt.shiftUp()).toBe(false);
  });

  it('cannot shift below neutral', () => {
    expect(dt.shiftDown()).toBe(false);
  });

  it('clutch held decouples engine', () => {
    dt.gear = 2;
    dt.rpm = 3000;
    dt.speed = 60;
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    expect(dt.isDecoupled).toBe(true);
  });

  it('allows downshift even if it would over-rev', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    for (let i = 0; i < 5; i++) dt.shiftUp();
    expect(dt.gear).toBe(5);
    dt.speed = 200;
    dt.rpm = 6000;
    expect(dt.shiftDown()).toBe(true);
    expect(dt.gear).toBe(4);
  });

  it('gear label shows number when clutch not held', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp();
    dt.clutchHeld = false;
    dt.update(0.001, 0);
    expect(dt.gearLabel).toBe('1');
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
    expect(dt.rpm).toBe(IDLE_RPM);
  });

  it('RPM increases with throttle in neutral', () => {
    dt.update(0.1, true);
    expect(dt.rpm).toBeGreaterThan(IDLE_RPM);
  });

  it('RPM increases with throttle in gear (coupled)', () => {
    dt.shiftUp(); // N -> 1
    dt.clutchHeld = false;
    dt.update(0.001, 0);
    dt.gear = 1;
    const startRPM = IDLE_RPM;
    dt.update(0.05, true);
    expect(dt.rpm).toBeGreaterThan(startRPM);
  });

  it('RPM never drops below IDLE_RPM', () => {
    dt.rpm = IDLE_RPM;
    dt.update(0.1, false);
    expect(dt.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
  });

  it('RPM never exceeds MAX_RPM', () => {
    dt.rpm = MAX_RPM - 10;
    for (let i = 0; i < 100; i++) {
      dt.update(0.05, true);
    }
    expect(dt.rpm).toBeLessThanOrEqual(MAX_RPM);
  });

  it('dt is clamped to 50ms', () => {
    dt.gear = 1;
    const rpm1 = dt.rpm;
    dt.update(5.0, true);
    const jump = dt.rpm - rpm1;

    dt.rpm = rpm1;
    dt.update(0.05, true);
    const clampedJump = dt.rpm - rpm1;

    expect(jump).toBeCloseTo(clampedJump, 3);
  });

  it('speed increases when coupled with throttle', () => {
    dt.shiftUp(); // N -> 1
    dt.clutchHeld = false;
    dt.update(0.001, 0); // release clutch
    dt.rpm = 3000;
    dt.update(0.05, true);
    expect(dt.speed).toBeGreaterThan(0);
  });

  it('speed decreases with drag in neutral', () => {
    dt.speed = 100;
    dt.update(0.05, false);
    expect(dt.speed).toBeLessThan(100);
  });

  it('engine revs freely when clutch is held', () => {
    dt.gear = 2;
    dt.rpm = 3000;
    dt.speed = 60;
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    // With clutch held and throttle, engine should rev on engine inertia only (faster)
    const rpmBefore = dt.rpm;
    advanceTime(100);
    dt.update(0.1, 1.0);
    // Engine revs up much faster since decoupled from vehicle mass
    expect(dt.rpm).toBeGreaterThan(rpmBefore + 500);
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
    dt.update(0.016, true);
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
    dt.update(0.05, false, true);
    expect(dt.speed).toBeLessThan(100);
  });

  it('speed does not go negative', () => {
    dt.speed = 1;
    dt.update(0.5, false, true);
    expect(dt.speed).toBeGreaterThanOrEqual(0);
  });

  it('RPM syncs to braked wheel speed when coupled', () => {
    dt.shiftUp(); // N -> 1
    dt.gear = 3;
    dt.rpm = 5000;
    dt.speed = 100;
    dt.update(0.05, false, true);
    expect(dt.rpm).toBeLessThan(5000);
    expect(dt.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
  });

  it('braking in neutral only slows car', () => {
    dt.gear = 0;
    dt.rpm = 3000;
    dt.speed = 80;
    dt.update(0.05, false, true);
    expect(dt.speed).toBeLessThan(80);
  });
});

describe('Drivetrain — clutch spring-damper engagement', () => {
  let dt;
  beforeEach(() => {
    mockNow = 0;
    dt = new Drivetrain();
    // Get to 2nd gear at speed
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp(); // 1
    dt.shiftUp(); // 2
    dt.clutchHeld = false;
    dt.rpm = 5000;
    dt.speed = 80;
    dt.update(0.001, 0.5); // release clutch, snap (small delta at this point)
    // Now stably in 2nd
    dt.rpm = 5000;
    dt.speed = 80;
  });

  it('activates on clutch release with RPM mismatch', () => {
    // Rev up with clutch held, then release
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp(); // 2 -> 3
    dt.rpm = 6000; // engine over-revved relative to wheel speed in 3rd
    dt.clutchHeld = false;
    dt.update(0.001, 0.5); // release triggers engagement
    expect(dt._clutchEngaging).toBe(true);
  });

  it('engine RPM converges toward wheel RPM', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp(); // 2 -> 3
    dt.rpm = 6000;
    const preRPM = dt.rpm;
    dt.clutchHeld = false;
    dt.update(0.001, 0.5);

    for (let i = 0; i < 100; i++) {
      advanceTime(8);
      dt.update(0.008, 0.5);
    }
    expect(Math.abs(dt.rpm - preRPM)).toBeGreaterThan(50);
  });

  it('settles (clutch locks) after enough time', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp();
    dt.rpm = 6000;
    dt.clutchHeld = false;
    dt.update(0.001, 0.5);

    for (let i = 0; i < 300; i++) {
      advanceTime(8);
      dt.update(0.008, 0.5);
    }

    expect(dt._clutchEngaging).toBe(false);
    expect(dt.shiftOscillation).toBe(0);
  });

  it('oscillation swings positive and negative', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp();
    dt.rpm = 6000;
    dt.clutchHeld = false;
    dt.update(0.001, 0.5);

    const values = [];
    for (let i = 0; i < 60; i++) {
      advanceTime(4);
      dt.update(0.004, 0.5);
      if (dt._clutchEngaging) values.push(dt.shiftOscillation);
    }

    expect(values.some(v => v > 0.01)).toBe(true);
    expect(values.some(v => v < -0.01)).toBe(true);
  });

  it('pressing clutch during engagement aborts it', () => {
    dt.clutchHeld = true;
    dt.update(0.001, 0);
    dt.shiftUp();
    dt.rpm = 6000;
    dt.clutchHeld = false;
    dt.update(0.001, 0.5);
    expect(dt._clutchEngaging).toBe(true);

    // Press clutch again
    dt.clutchHeld = true;
    dt.update(0.001, 0.5);
    expect(dt._clutchEngaging).toBe(false);
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
    expect(state).toHaveProperty('clutchHeld');
    expect(state).toHaveProperty('clutchEngaging');
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

  it('effectiveInertia increases with lower gear ratio', () => {
    dt.gear = 1;
    const inertia1 = dt.getState().effectiveInertia;
    dt.gear = 5;
    const inertia5 = dt.getState().effectiveInertia;
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
