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

  it('can shift without clutch (clutchless shift triggers engagement)', () => {
    dt.shiftUp(); // N -> 1
    expect(dt.gear).toBe(1);
    dt.speed = 60;
    dt.rpm = 5000;
    // Shift without clutch — should work and trigger spring-damper
    expect(dt.shiftUp()).toBe(true);
    expect(dt.gear).toBe(2);
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

  it('RPM stays near idle with no throttle in neutral', () => {
    for (let i = 0; i < 10; i++) dt.update(0.016, 0);
    // Idle air control + flutter means RPM hovers near but not exactly at IDLE_RPM
    expect(dt.rpm).toBeGreaterThanOrEqual(IDLE_RPM - 20);
    expect(dt.rpm).toBeLessThan(IDLE_RPM + 50);
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

  it('RPM stays near idle even with friction', () => {
    dt.rpm = IDLE_RPM;
    for (let i = 0; i < 20; i++) dt.update(0.016, 0);
    // Idle air control prevents RPM from collapsing far below idle
    expect(dt.rpm).toBeGreaterThanOrEqual(IDLE_RPM - 20);
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

    expect(jump).toBeCloseTo(clampedJump, 1);
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

describe('Drivetrain — NaN safety', () => {
  /** Accelerate in 1st, then clutchless upshift so spring-damper is mid-engagement. */
  function engagingInSecond(profile) {
    const dt = new Drivetrain(profile);
    dt.shiftUp();
    for (let i = 0; i < 300; i++) dt.update(1 / 60, 1);
    dt.shiftUp();
    dt.update(1 / 60, 1);
    return dt;
  }

  it('shifting to neutral mid-engagement cancels engagement and stays finite', () => {
    const dt = engagingInSecond();
    expect(dt._clutchEngaging).toBe(true);
    dt.shiftDown(); // 2 -> 1
    dt.shiftDown(); // 1 -> N
    expect(dt.gear).toBe(0);
    expect(dt._clutchEngaging).toBe(false);
    for (let i = 0; i < 60; i++) dt.update(1 / 60, 1);
    expect(Number.isFinite(dt.rpm)).toBe(true);
    expect(Number.isFinite(dt.speed)).toBe(true);
  });

  it('small-delta re-shift during engagement ends stale engagement', () => {
    const dt = engagingInSecond();
    // Force a gear change whose wheel RPM matches engine RPM closely
    dt.gear = 1;
    const ratio = GEAR_RATIOS[1] * FINAL_DRIVE;
    dt.rpm = ((dt.speed / 3.6) / 1.88) * 60 * ratio;
    dt._engageClutch();
    expect(dt._clutchEngaging).toBe(false);
  });

  it('recovers when internal state becomes non-finite', () => {
    const dt = engagingInSecond();
    for (let i = 0; i < 10; i++) dt.update(1 / 60, 1);
    dt._wheelOmega = NaN;
    dt.update(1 / 60, 1);
    expect(Number.isFinite(dt.rpm)).toBe(true);
    expect(Number.isFinite(dt.speed)).toBe(true);
    expect(dt.rpm).toBeGreaterThanOrEqual(IDLE_RPM);
    expect(dt._clutchEngaging).toBe(false);
    expect(dt.nanRecoveries).toBe(1);
    // Keeps simulating normally afterwards
    const before = dt.rpm;
    for (let i = 0; i < 30; i++) dt.update(1 / 60, 1);
    expect(Number.isFinite(dt.rpm)).toBe(true);
    expect(dt.rpm).not.toBe(before);
  });

  it('1st-gear clutch engagement stays stable at 20 FPS', () => {
    const dt = new Drivetrain();
    dt.shiftUp();
    for (let i = 0; i < 60; i++) dt.update(1 / 60, 1);
    dt.clutchHeld = true;
    for (let i = 0; i < 30; i++) dt.update(0.05, 1); // rev up decoupled
    dt.clutchHeld = false;
    for (let i = 0; i < 100; i++) {
      dt.update(0.05, 1);
      expect(dt.speed).toBeLessThan(300);
    }
    expect(dt.nanRecoveries).toBe(0);
  });

  it('recovers from finite-but-runaway values', () => {
    const dt = new Drivetrain();
    dt.shiftUp();
    for (let i = 0; i < 60; i++) dt.update(1 / 60, 1);
    dt.speed = 1e200;
    dt.update(1 / 60, 1);
    expect(dt.speed).toBeLessThan(300);
    expect(dt.nanRecoveries).toBe(1);
  });

  it('ignores non-finite dt and throttle inputs', () => {
    const dt = new Drivetrain();
    dt.update(NaN, 1);
    dt.update(1 / 60, NaN);
    dt.update(-0.01, 1);
    expect(Number.isFinite(dt.rpm)).toBe(true);
    expect(dt.nanRecoveries).toBe(0);
  });

  it('getState never exposes non-finite numbers', () => {
    const dt = new Drivetrain();
    dt.rpm = NaN;
    dt.speed = Infinity;
    const s = dt.getState();
    expect(Number.isFinite(s.rpm)).toBe(true);
    expect(Number.isFinite(s.speed)).toBe(true);
  });

  it('survives random shift/clutch mashing on every profile', async () => {
    const { PROFILE_LIST } = await import('../profiles.js');
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    // Sound variants share physics — fuzz each distinct drivetrain once
    const physics = [...new Map(PROFILE_LIST.map(p => [p.torqueCurve, p])).values()];
    for (const profile of physics) {
      for (const frame of [1 / 144, 1 / 60, 1 / 30, 0.05]) {
        const dt = new Drivetrain(profile);
        let firstBad = -1;
        for (let i = 0; i < 3000; i++) {
          const r = rand();
          if (r < 0.03) dt.shiftUp();
          else if (r < 0.06) dt.shiftDown();
          if (rand() < 0.02) dt.clutchHeld = !dt.clutchHeld;
          dt.update(frame, rand() < 0.8 ? 1 : 0, rand() < 0.02);
          if (firstBad < 0 && !(Number.isFinite(dt.rpm) && Number.isFinite(dt.speed))) firstBad = i;
        }
        expect(firstBad, `${profile.id} @ ${frame}`).toBe(-1);
        expect(dt.nanRecoveries).toBe(0); // root cause fixed — guard never needed
      }
    }
  });
});

describe('Drivetrain — limiter styles', () => {
  const base = { ...PROFILES_FOR_LIMITER() };
  function PROFILES_FOR_LIMITER() {
    return {
      idleRPM: 800, redlineRPM: 6000, revCutRPM: 5900, maxRPM: 6500, tachoMaxRPM: 7000,
      torqueCurve: [[800, 200], [4000, 300], [6000, 280], [7000, 250]],
      gearRatios: [0, 3, 2], finalDrive: 3.5, tireCircumference: 2,
      engineInertia: 0.2, vehicleInertia: 100, frictionTorque: 8, engineBrakingFactor: 12,
      brakeDecel: 9, shiftDuration: 150, turbo: false, mass: 1400,
    };
  }
  const revNeutral = (dt, frames = 240) => {
    let maxRPM = 0, cuts = 0, wasActive = false;
    for (let i = 0; i < frames; i++) {
      dt.update(1 / 120, 1);
      maxRPM = Math.max(maxRPM, dt.rpm);
      if (dt.revLimiterActive && !wasActive) cuts++;
      wasActive = dt.revLimiterActive;
    }
    return { maxRPM, cuts };
  };

  it('hard cut holds fuel off for cutMs, then bounces', () => {
    const dt = new Drivetrain({ ...base, limiter: { style: 'hard', cutMs: 100 } });
    const { cuts } = revNeutral(dt);
    expect(cuts).toBeGreaterThan(1);
    // 100 ms at 120 fps ≈ 12 frames of cut per bounce
    dt.rpm = 6100; dt._limiterTimer = 0;
    let frames = 0;
    dt.update(1 / 120, 1);
    while (dt.revLimiterActive && frames < 100) { dt.update(1 / 120, 1); frames++; }
    expect(frames).toBeGreaterThanOrEqual(10);
    expect(frames).toBeLessThanOrEqual(13);
  });

  it('hard cut bounces tightly around redline in neutral (no ratcheting)', () => {
    const dt = new Drivetrain({ ...base, limiter: { style: 'hard', cutMs: 60 } });
    revNeutral(dt, 240);
    const { maxRPM, cuts } = revNeutral(dt, 240);
    expect(maxRPM).toBeLessThan(6100);
    expect(cuts).toBeGreaterThan(5); // audible bounce: several cuts per 2 s
  });

  it('soft limiter tapers torque before redline', () => {
    const dt = new Drivetrain({ ...base, limiter: { style: 'soft', cutMs: 80, softRangeRPM: 300 } });
    const hard = new Drivetrain({ ...base, limiter: { style: 'hard', cutMs: 80 } });
    expect(dt._throttleTorque(5900, 1)).toBeLessThan(hard._throttleTorque(5900, 1));
    expect(dt._throttleTorque(5000, 1)).toBe(hard._throttleTorque(5000, 1));
    expect(dt.getState().limiterStyle).toBe('soft');
  });

  it('soft hold (cutMs 0) never cuts and settles at redline', () => {
    const dt = new Drivetrain({ ...base, limiter: { style: 'soft', cutMs: 0, softRangeRPM: 300 } });
    const { maxRPM, cuts } = revNeutral(dt, 600);
    expect(cuts).toBe(0);
    expect(maxRPM).toBeGreaterThan(5600);
    expect(maxRPM).toBeLessThanOrEqual(6000);
    expect(dt.getState().limiterLoad).toBeGreaterThan(0.5);
  });

  it('no limiter never cuts; breathing falloff caps RPM', () => {
    const dt = new Drivetrain({ ...base, limiter: { style: 'none' } });
    const { maxRPM, cuts } = revNeutral(dt, 1200);
    expect(cuts).toBe(0);
    expect(maxRPM).toBeGreaterThan(6000);
    expect(maxRPM).toBeLessThan(7200);
  });
});
