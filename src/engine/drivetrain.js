/**
 * Drivetrain physics — gear ratios, inertia model, rev limiter, shift state machine.
 *
 * Based on Honda S2000 AP1 gearbox. All torque/inertia values tuned for game feel,
 * not strict realism, but the physics model is structurally correct:
 *   angular_accel = (drive_torque - resistance_torque) / effective_inertia
 *   effective_inertia = engine_inertia + vehicle_inertia / (total_ratio^2)
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

const SHIFT_DURATION = 150;      // ms — clutch disengaged during shift

// Simplified torque curve (RPM → Nm at wide-open throttle)
// Peaks at ~6500 RPM with VTEC-like bump, drops off toward redline
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

  /** Snapshot of all drivetrain state for audio + debug. */
  getState() {
    const inGear = !this.isNeutral && this.gear > 0;
    const totalRatio = inGear ? GEAR_RATIOS[this.gear] * FINAL_DRIVE : 0;
    return {
      rpm: this.rpm,
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
   * @param {boolean} throttle - true if throttle is open
   */
  update(dt, throttle) {
    dt = Math.min(dt, 0.05);

    // Handle shift completion
    if (this._shifting) {
      const now = performance.now();
      if (now - this._shiftStart >= SHIFT_DURATION) {
        this._completeShift();
      }
    }

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

    // Drive torque
    let driveTorque = 0;
    if (throttle && !this.revLimiterActive) {
      driveTorque = lerpTorqueCurve(this.rpm);
    }

    // Resistance torque
    let resistanceTorque = FRICTION_TORQUE;
    if (!throttle) {
      if (inGear) {
        resistanceTorque += ENGINE_BRAKING_FACTOR * totalRatio;
      } else {
        resistanceTorque += ENGINE_BRAKING_FACTOR * 0.3;
      }
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

    // Compute vehicle speed from RPM (when in gear)
    if (inGear) {
      const wheelRPM = this.rpm / totalRatio;
      this.speed = (wheelRPM * TIRE_CIRCUMFERENCE / 60) * 3.6;
    } else if (!this._shifting) {
      this.speed = Math.max(0, this.speed - this.speed * 0.3 * dt);
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
    const newGear = this._shiftTargetGear;
    this._shifting = false;
    this.gear = newGear;

    if (newGear > 0 && this.speed > 0) {
      const newTotalRatio = GEAR_RATIOS[newGear] * FINAL_DRIVE;
      const wheelRPS = (this.speed / 3.6) / TIRE_CIRCUMFERENCE;
      this.rpm = Math.max(IDLE_RPM, Math.min(MAX_RPM, wheelRPS * 60 * newTotalRatio));
    }
  }
}

export { GEAR_RATIOS, FINAL_DRIVE };
