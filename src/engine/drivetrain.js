/**
 * Drivetrain physics — gear ratios, inertia model, rev limiter, shift state machine,
 * and post-shift oscillation modeling.
 *
 * Based on Honda S2000 AP1 gearbox. Physics model:
 *   angular_accel = (drive_torque - resistance_torque) / effective_inertia
 *   effective_inertia = engine_inertia + vehicle_inertia / (total_ratio^2)
 *
 * Shift oscillation: when gears engage, engine RPM and wheel-driven RPM equalize
 * through the drivetrain's spring-mass compliance. This produces a damped sine
 * oscillation at 6-12 Hz, decaying over 200-400ms. Amplitude scales with the
 * RPM mismatch at the moment of engagement.
 */

import { IDLE_RPM, REDLINE_RPM, REV_CUT_RPM, MAX_RPM } from './constants.js';

// Index 0 = Neutral (no drive connection), 1-5 = gears
const GEAR_RATIOS = [0, 3.133, 2.045, 1.481, 1.161, 0.943];
const FINAL_DRIVE = 4.100;
const TIRE_CIRCUMFERENCE = 1.88; // meters (~205/55R16)

const ENGINE_INERTIA = 0.15;     // kg·m² — engine rotating assembly
const VEHICLE_INERTIA = 90;      // effective vehicle rotational inertia at wheels

const FRICTION_TORQUE = 8;       // Nm — constant mechanical friction
const ENGINE_BRAKING_FACTOR = 12; // Nm — compression braking on closed throttle
const BRAKE_DECEL = 9.0;          // m/s² — vehicle deceleration under braking (~0.9g)

const SHIFT_DURATION = 150;      // ms — clutch disengaged during shift

// Shift oscillation parameters
const OSCILLATION_FREQ = 6;             // Hz — drivetrain natural frequency (lower = more visible on tacho)
const OSCILLATION_DECAY_TAU = 0.35;     // seconds — exponential decay time constant
const OSCILLATION_DURATION = 1.0;       // seconds — total oscillation window
const OSCILLATION_RPM_SCALE = 0.45;     // fraction of RPM delta that becomes oscillation amplitude

// Simplified torque curve (RPM → Nm at wide-open throttle)
const TORQUE_CURVE = [
  [850,  120],
  [2000, 155],
  [3000, 180],
  [4000, 200],
  [5000, 220],
  [5800, 235],
  [6500, 240],
  [7000, 230],
  [7200, 220],
];

const RADS_TO_RPM = 60 / (2 * Math.PI);

// --- Helpers ---

function lerpTorqueCurve(rpm) {
  if (rpm <= TORQUE_CURVE[0][0]) return TORQUE_CURVE[0][1];
  if (rpm >= TORQUE_CURVE[TORQUE_CURVE.length - 1][0]) return TORQUE_CURVE[TORQUE_CURVE.length - 1][1];

  for (let i = 0; i < TORQUE_CURVE.length - 1; i++) {
    const [r0, t0] = TORQUE_CURVE[i];
    const [r1, t1] = TORQUE_CURVE[i + 1];
    if (rpm >= r0 && rpm <= r1) {
      const t = (rpm - r0) / (r1 - r0);
      return t0 + t * (t1 - t0);
    }
  }
  return 0;
}

// --- Drivetrain class ---

export class Drivetrain {
  constructor() {
    this.rpm = IDLE_RPM;
    this.gear = 0;          // 0 = neutral
    this.speed = 0;          // km/h
    this.revLimiterActive = false;

    // Shift state
    this._shifting = false;
    this._shiftStart = 0;
    this._shiftTargetGear = 0;
    this._preShiftRPM = 0;
    this._preShiftThrottle = false;

    // Post-shift oscillation state
    this._oscActive = false;
    this._oscStartTime = 0;
    this._oscRPMDelta = 0;       // signed: negative = upshift (RPM dropped), positive = downshift
    this._oscDirection = 0;       // +1 upshift, -1 downshift
    this.shiftOscillation = 0;    // current oscillation value [-1, 1] — consumed by audio
    this.shiftOscAmplitude = 0;   // current decayed amplitude [0, 1] — consumed by audio
  }

  get isNeutral() {
    return this.gear === 0 || this._shifting;
  }

  get totalRatio() {
    return GEAR_RATIOS[this.gear] * FINAL_DRIVE;
  }

  get gearLabel() {
    if (this._shifting) return '-';
    return this.gear === 0 ? 'N' : String(this.gear);
  }

  /** Snapshot of all drivetrain state for audio + debug.
   *  RPM includes oscillation offset for tacho/audio; physics uses raw this.rpm. */
  getState() {
    const inGear = !this.isNeutral && this.gear > 0;
    const totalRatio = inGear ? GEAR_RATIOS[this.gear] * FINAL_DRIVE : 0;
    // Display RPM = base RPM + oscillation wobble (clamped to valid range)
    const oscOffset = this._oscActive ? this.shiftOscillation * Math.abs(this._oscRPMDelta) : 0;
    const displayRPM = Math.max(IDLE_RPM, Math.min(MAX_RPM, this.rpm + oscOffset));
    return {
      rpm: displayRPM,
      speed: this.speed,
      gear: this.gear,
      gearLabel: this.gearLabel,
      shifting: this._shifting,
      revLimiterActive: this.revLimiterActive,
      throttle: false, // set by caller
      totalRatio,
      effectiveInertia: inGear
        ? ENGINE_INERTIA + VEHICLE_INERTIA / (totalRatio * totalRatio)
        : ENGINE_INERTIA,
      torqueNm: inGear ? lerpTorqueCurve(this.rpm) : 0,
      // Shift oscillation (consumed by audio for detune + gain modulation)
      shiftOscillation: this.shiftOscillation,
      shiftOscAmplitude: this.shiftOscAmplitude,
      shiftOscRPMDelta: this._oscRPMDelta,
    };
  }

  shiftUp() {
    if (this._shifting) return false;
    if (this.gear >= 5) return false;
    this._beginShift(this.gear + 1);
    return true;
  }

  shiftDown() {
    if (this._shifting) return false;
    if (this.gear <= 0) return false;

    const newGear = this.gear - 1;

    // Over-rev protection
    if (newGear > 0 && this.speed > 0) {
      const newTotalRatio = GEAR_RATIOS[newGear] * FINAL_DRIVE;
      const wheelRPS = (this.speed / 3.6) / TIRE_CIRCUMFERENCE;
      const projectedRPM = wheelRPS * 60 * newTotalRatio;
      if (projectedRPM > MAX_RPM) return false;
    }

    this._beginShift(newGear);
    return true;
  }

  /**
   * Update physics. Call every frame.
   * @param {number} dt - delta time in seconds
   * @param {number} throttle - throttle position 0–1
   * @param {boolean} braking - true if brake is applied
   */
  update(dt, throttle, braking = false) {
    dt = Math.min(dt, 0.05);
    throttle = Math.max(0, Math.min(1, throttle));

    // Handle shift completion
    if (this._shifting) {
      this._preShiftThrottle = throttle;
      const now = performance.now();
      if (now - this._shiftStart >= SHIFT_DURATION) {
        this._completeShift();
      }
    }

    // Update post-shift oscillation
    this._updateOscillation();

    const inGear = !this.isNeutral && this.gear > 0;
    const totalRatio = inGear ? GEAR_RATIOS[this.gear] * FINAL_DRIVE : 0;

    // Effective inertia
    let J;
    if (inGear) {
      J = ENGINE_INERTIA + VEHICLE_INERTIA / (totalRatio * totalRatio);
    } else {
      J = ENGINE_INERTIA;
    }

    // Rev limiter (fuel cut with hysteresis)
    if (this.rpm >= REDLINE_RPM) {
      this.revLimiterActive = true;
    } else if (this.rpm < REV_CUT_RPM) {
      this.revLimiterActive = false;
    }

    // Drive torque — scaled by continuous throttle position
    let driveTorque = 0;
    if (throttle > 0 && !this.revLimiterActive) {
      driveTorque = lerpTorqueCurve(this.rpm) * throttle;
    }

    // Resistance torque — engine braking scales with closed throttle
    let resistanceTorque = FRICTION_TORQUE;
    const closedThrottle = 1 - throttle;
    if (inGear) {
      resistanceTorque += ENGINE_BRAKING_FACTOR * totalRatio * closedThrottle;
    } else {
      resistanceTorque += ENGINE_BRAKING_FACTOR * 0.3 * closedThrottle;
    }

    if (this.revLimiterActive) {
      resistanceTorque += ENGINE_BRAKING_FACTOR * 2;
    }

    // Angular acceleration → RPM change
    const netTorque = driveTorque - resistanceTorque;
    const alpha = netTorque / J;
    this.rpm += alpha * dt * RADS_TO_RPM;

    // Clamp RPM
    if (this.rpm < IDLE_RPM) this.rpm = IDLE_RPM;
    if (this.rpm > MAX_RPM) this.rpm = MAX_RPM;

    // Compute vehicle speed from base RPM (no oscillation — prevents feedback)
    if (inGear) {
      const wheelRPM = this.rpm / totalRatio;
      this.speed = (wheelRPM * TIRE_CIRCUMFERENCE / 60) * 3.6;
    } else if (!this._shifting) {
      this.speed = Math.max(0, this.speed - this.speed * 0.3 * dt);
    }

    // Braking: decelerates the vehicle (wheels), not the engine directly.
    // When in gear, reduced speed will pull RPM down next frame via the
    // speed→RPM coupling. When in neutral, just slows the car.
    if (braking && this.speed > 0) {
      const speedMS = this.speed / 3.6;
      const newSpeedMS = Math.max(0, speedMS - BRAKE_DECEL * dt);
      this.speed = newSpeedMS * 3.6;

      // In gear: sync RPM to the braked wheel speed
      if (inGear) {
        const brakedWheelRPS = newSpeedMS / TIRE_CIRCUMFERENCE;
        const brakedRPM = brakedWheelRPS * 60 * totalRatio;
        this.rpm = Math.max(IDLE_RPM, brakedRPM);
      }
    }
  }

  /** @private */
  _beginShift(targetGear) {
    this._shifting = true;
    this._shiftStart = performance.now();
    this._shiftTargetGear = targetGear;
    this._preShiftRPM = this.rpm;
  }

  /** @private */
  _completeShift() {
    const oldGear = this.gear;
    const newGear = this._shiftTargetGear;
    this._shifting = false;
    this.gear = newGear;

    let targetRPM = this.rpm;
    if (newGear > 0 && this.speed > 0) {
      const newTotalRatio = GEAR_RATIOS[newGear] * FINAL_DRIVE;
      const wheelRPS = (this.speed / 3.6) / TIRE_CIRCUMFERENCE;
      targetRPM = Math.max(IDLE_RPM, Math.min(MAX_RPM, wheelRPS * 60 * newTotalRatio));
    }

    // Compute RPM delta for oscillation: how much RPM jumped
    const rpmDelta = targetRPM - this.rpm;
    this.rpm = targetRPM;

    // Trigger post-shift oscillation if there was a meaningful RPM change
    if (Math.abs(rpmDelta) > 100 && oldGear > 0) {
      this._oscActive = true;
      this._oscStartTime = performance.now();
      this._oscRPMDelta = rpmDelta;
      this._oscDirection = rpmDelta < 0 ? 1 : -1; // upshift = RPM drops = positive dir
    }
  }

  /** @private Update the damped oscillation state. */
  _updateOscillation() {
    if (!this._oscActive) {
      this.shiftOscillation = 0;
      this.shiftOscAmplitude = 0;
      return;
    }

    const elapsed = (performance.now() - this._oscStartTime) / 1000; // seconds

    if (elapsed > OSCILLATION_DURATION) {
      this._oscActive = false;
      this.shiftOscillation = 0;
      this.shiftOscAmplitude = 0;
      return;
    }

    // Normalized amplitude [0, 1] based on RPM delta magnitude
    // Bigger RPM jumps = bigger oscillation
    const rpmMagnitude = Math.min(1, Math.abs(this._oscRPMDelta) / 3000);
    const baseAmplitude = rpmMagnitude * OSCILLATION_RPM_SCALE;

    // Exponential decay
    const decay = Math.exp(-elapsed / OSCILLATION_DECAY_TAU);
    this.shiftOscAmplitude = baseAmplitude * decay;

    // Damped sine wave
    const phase = 2 * Math.PI * OSCILLATION_FREQ * elapsed;
    this.shiftOscillation = Math.sin(phase) * this.shiftOscAmplitude;
  }
}

export { GEAR_RATIOS, FINAL_DRIVE };
