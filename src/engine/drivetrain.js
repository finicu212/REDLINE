/**
 * Drivetrain physics — gear ratios, inertia model, rev limiter, manual clutch,
 * and spring-damper clutch engagement.
 *
 * Based on Honda S2000 AP1 gearbox. Physics model:
 *   angular_accel = (drive_torque - resistance_torque) / effective_inertia
 *   effective_inertia = engine_inertia + vehicle_inertia / (total_ratio^2)
 *
 * Manual clutch: hold clutch to decouple engine from wheels (engine revs freely).
 * Shift gears while clutch is held. Release clutch → spring-damper engagement
 * couples engine and wheel inertias, producing natural oscillation.
 *
 *   clutch_torque = k * angle_delta + c * omega_delta
 *   f_natural = (1/2π) * sqrt(k / J_reduced)
 *   ζ = c / (2 * sqrt(k * J_reduced))
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

// Clutch spring-damper parameters
const CLUTCH_STIFFNESS = 190;    // Nm/rad — torsional spring constant
const CLUTCH_DAMPING = 3.5;      // Nm·s/rad — torsional viscous damping
const CLUTCH_SETTLE_THRESHOLD = 5; // RPM — snap together when deviation < this

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
const RPM_TO_RADS = (2 * Math.PI) / 60;

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

// Pre-compute peak power (W) from the WOT torque curve: max(T × omega)
const PEAK_POWER = TORQUE_CURVE.reduce((max, [r, t]) => {
  const p = t * r * RPM_TO_RADS;
  return p > max ? p : max;
}, 0);

/**
 * BeamNG-style constant-power throttle model.
 * Throttle pedal scales power output, not torque.
 */
function throttleTorque(rpm, pedal) {
  const wotTorque = lerpTorqueCurve(rpm);
  if (pedal >= 1) return wotTorque;
  if (pedal <= 0) return 0;

  const omega = rpm * RPM_TO_RADS;
  if (omega <= 0) return wotTorque * pedal;

  const targetPower = PEAK_POWER * pedal;
  const powerLimitedTorque = targetPower / omega;
  return Math.min(wotTorque, powerLimitedTorque);
}

// --- Drivetrain class ---

export class Drivetrain {
  constructor() {
    this.rpm = IDLE_RPM;
    this.gear = 0;          // 0 = neutral
    this.speed = 0;          // km/h
    this.revLimiterActive = false;

    // Clutch state
    this.clutchHeld = false;        // true when player is holding clutch pedal
    this._wasClutchHeld = false;    // previous frame's clutch state (edge detection)

    // Clutch spring-damper state (active during engagement after clutch release)
    this._clutchEngaging = false;
    this._wheelOmega = 0;         // rad/s — wheel angular velocity (reflected to engine side)
    this._clutchAngleDelta = 0;   // rad — integrated angular displacement between engine & wheel
    this._clutchInitialDelta = 0; // RPM — initial mismatch at engagement (for audio normalization)
    this._oscRPMDelta = 0;        // signed RPM delta at engagement (consumed by audio for shift thud)
    this.shiftOscillation = 0;    // current oscillation value [-1, 1] — consumed by audio
    this.shiftOscAmplitude = 0;   // current decayed amplitude [0, 1] — consumed by audio
    this._lastThrottle = 0;
  }

  /** True when engine is decoupled from wheels (clutch held, engaging, or neutral). */
  get isDecoupled() {
    return this.gear === 0 || this.clutchHeld || this._clutchEngaging;
  }

  get totalRatio() {
    return GEAR_RATIOS[this.gear] * FINAL_DRIVE;
  }

  get gearLabel() {
    return this.gear === 0 ? 'N' : String(this.gear);
  }

  /** Snapshot of all drivetrain state for audio + debug. */
  getState() {
    const coupled = this.gear > 0 && !this.clutchHeld && !this._clutchEngaging;
    const totalRatio = this.gear > 0 ? GEAR_RATIOS[this.gear] * FINAL_DRIVE : 0;
    return {
      rpm: Math.max(IDLE_RPM, Math.min(MAX_RPM, this.rpm)),
      speed: this.speed,
      gear: this.gear,
      gearLabel: this.gearLabel,
      shifting: false, // no more auto-shift timer
      clutchHeld: this.clutchHeld,
      clutchEngaging: this._clutchEngaging,
      revLimiterActive: this.revLimiterActive,
      throttle: false, // set by caller
      totalRatio,
      effectiveInertia: coupled
        ? ENGINE_INERTIA + VEHICLE_INERTIA / (totalRatio * totalRatio)
        : ENGINE_INERTIA,
      torqueNm: coupled ? throttleTorque(this.rpm, this._lastThrottle) : 0,
      shiftOscillation: this.shiftOscillation,
      shiftOscAmplitude: this.shiftOscAmplitude,
      shiftOscRPMDelta: this._oscRPMDelta,
    };
  }

  /**
   * Shift up. Requires clutch to be held (or in neutral).
   * Returns true if gear changed.
   */
  shiftUp() {
    if (!this.clutchHeld && this.gear > 0) return false;
    if (this.gear >= 5) return false;
    this.gear += 1;
    return true;
  }

  /**
   * Shift down. Requires clutch to be held (or already in neutral won't go below 0).
   * No over-rev protection — engine allows over-rev past redline.
   */
  shiftDown() {
    if (!this.clutchHeld && this.gear > 0) return false;
    if (this.gear <= 0) return false;
    this.gear -= 1;
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
    this._lastThrottle = throttle;

    const totalRatio = this.gear > 0 ? GEAR_RATIOS[this.gear] * FINAL_DRIVE : 0;

    // --- Clutch release edge: start spring-damper engagement ---
    if (this._wasClutchHeld && !this.clutchHeld && this.gear > 0 && this.speed > 0) {
      const wheelRPS = (this.speed / 3.6) / TIRE_CIRCUMFERENCE;
      const wheelRPM = wheelRPS * 60 * totalRatio;
      const rpmDelta = wheelRPM - this.rpm;

      if (Math.abs(rpmDelta) > 100) {
        this._clutchEngaging = true;
        this._wheelOmega = wheelRPM * RPM_TO_RADS;
        this._clutchAngleDelta = 0;
        this._clutchInitialDelta = rpmDelta;
        this._oscRPMDelta = rpmDelta;
      } else {
        // Small mismatch — snap
        this.rpm = Math.max(IDLE_RPM, Math.min(MAX_RPM, wheelRPM));
      }
    }
    this._wasClutchHeld = this.clutchHeld;

    // If clutch is pressed during engagement, abort engagement
    if (this.clutchHeld && this._clutchEngaging) {
      this._clutchEngaging = false;
      this.shiftOscillation = 0;
      this.shiftOscAmplitude = 0;
    }

    // Rev limiter (fuel cut with hysteresis)
    if (this.rpm >= REDLINE_RPM) {
      this.revLimiterActive = true;
    } else if (this.rpm < REV_CUT_RPM) {
      this.revLimiterActive = false;
    }

    // Drive torque
    let driveTorque = 0;
    if (throttle > 0 && !this.revLimiterActive) {
      driveTorque = throttleTorque(this.rpm, throttle);
    }

    // Resistance torque
    let resistanceTorque = FRICTION_TORQUE;
    const closedThrottle = 1 - throttle;
    const coupled = this.gear > 0 && !this.clutchHeld && !this._clutchEngaging;
    if (coupled) {
      resistanceTorque += ENGINE_BRAKING_FACTOR * totalRatio * closedThrottle;
    } else {
      resistanceTorque += ENGINE_BRAKING_FACTOR * 0.3 * closedThrottle;
    }
    if (this.revLimiterActive) {
      resistanceTorque += ENGINE_BRAKING_FACTOR * 2;
    }

    // --- Physics branches ---
    if (this._clutchEngaging) {
      // Spring-damper engagement
      const engineOmega = this.rpm * RPM_TO_RADS;
      const omegaDelta = this._wheelOmega - engineOmega;

      this._clutchAngleDelta += omegaDelta * dt;

      const clutchTorque = CLUTCH_STIFFNESS * this._clutchAngleDelta + CLUTCH_DAMPING * omegaDelta;

      // Engine side
      const engineAlpha = (driveTorque - resistanceTorque + clutchTorque) / ENGINE_INERTIA;
      this.rpm += engineAlpha * dt * RADS_TO_RPM;

      // Wheel side
      const wheelJ = VEHICLE_INERTIA / (totalRatio * totalRatio);
      this._wheelOmega += (-clutchTorque / wheelJ) * dt;

      this.speed = Math.max(0, (this._wheelOmega * RADS_TO_RPM / totalRatio) * TIRE_CIRCUMFERENCE / 60 * 3.6);

      // Audio oscillation from actual physics state
      const rpmDeviation = this.rpm - (this._wheelOmega * RADS_TO_RPM);
      if (Math.abs(this._clutchInitialDelta) > 1) {
        this.shiftOscillation = Math.max(-1, Math.min(1, rpmDeviation / this._clutchInitialDelta));
        this.shiftOscAmplitude = Math.min(1, Math.abs(rpmDeviation / this._clutchInitialDelta));
      }

      // Check convergence
      const rpmDiff = Math.abs(this.rpm - this._wheelOmega * RADS_TO_RPM);
      if (rpmDiff < CLUTCH_SETTLE_THRESHOLD && Math.abs(omegaDelta) < CLUTCH_SETTLE_THRESHOLD * RPM_TO_RADS) {
        this._clutchEngaging = false;
        const Je = ENGINE_INERTIA;
        const Jw = VEHICLE_INERTIA / (totalRatio * totalRatio);
        const sharedOmega = (Je * this.rpm * RPM_TO_RADS + Jw * this._wheelOmega) / (Je + Jw);
        this.rpm = sharedOmega * RADS_TO_RPM;
        this.shiftOscillation = 0;
        this.shiftOscAmplitude = 0;
      }
    } else if (coupled) {
      // Rigid coupling — engine and wheels locked
      const J = ENGINE_INERTIA + VEHICLE_INERTIA / (totalRatio * totalRatio);
      const netTorque = driveTorque - resistanceTorque;
      this.rpm += (netTorque / J) * dt * RADS_TO_RPM;

      const wheelRPM = this.rpm / totalRatio;
      this.speed = (wheelRPM * TIRE_CIRCUMFERENCE / 60) * 3.6;
    } else {
      // Decoupled (neutral or clutch held) — engine revs freely
      const netTorque = driveTorque - resistanceTorque;
      this.rpm += (netTorque / ENGINE_INERTIA) * dt * RADS_TO_RPM;

      // Vehicle coasts (rolling resistance)
      this.speed = Math.max(0, this.speed - this.speed * 0.3 * dt);
    }

    // Clear oscillation when not engaging
    if (!this._clutchEngaging && this.shiftOscAmplitude > 0) {
      this.shiftOscillation = 0;
      this.shiftOscAmplitude = 0;
    }

    // Clamp RPM
    if (this.rpm < IDLE_RPM) this.rpm = IDLE_RPM;
    if (this.rpm > MAX_RPM) this.rpm = MAX_RPM;

    // Braking
    if (braking && this.speed > 0) {
      const speedMS = this.speed / 3.6;
      const newSpeedMS = Math.max(0, speedMS - BRAKE_DECEL * dt);
      this.speed = newSpeedMS * 3.6;

      if (coupled) {
        const brakedWheelRPS = newSpeedMS / TIRE_CIRCUMFERENCE;
        this.rpm = Math.max(IDLE_RPM, brakedWheelRPS * 60 * totalRatio);
      } else if (this._clutchEngaging) {
        this._wheelOmega = Math.max(0, (newSpeedMS / TIRE_CIRCUMFERENCE) * 2 * Math.PI * totalRatio);
      }
    }
  }
}

export { GEAR_RATIOS, FINAL_DRIVE, PEAK_POWER, throttleTorque };
