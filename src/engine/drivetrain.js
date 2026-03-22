/**
 * Drivetrain physics — gear ratios, inertia model, rev limiter, manual clutch,
 * and spring-damper clutch engagement.
 *
 * Physics model:
 *   angular_accel = (drive_torque - resistance_torque) / effective_inertia
 *   effective_inertia = engine_inertia + vehicle_inertia / (total_ratio^2)
 *
 * Accepts an optional profile object (from profiles.js) to configure all parameters.
 * When no profile is passed, defaults to Honda S2000 AP1 values for backward compat.
 *
 * Clutch engagement: when gears engage after a shift, engine and wheel inertias
 * are coupled through a torsional spring-damper. The RPM mismatch produces real
 * oscillation whose frequency and damping emerge from the physics — lower gears
 * oscillate slower (more reflected inertia), higher gears faster.
 *
 *   clutch_torque = k * angle_delta + c * omega_delta
 *   f_natural = (1/2π) * sqrt(k / J_reduced)
 *   ζ = c / (2 * sqrt(k * J_reduced))
 */

import { IDLE_RPM, REDLINE_RPM, REV_CUT_RPM, MAX_RPM } from './constants.js';

// --- S2000 AP1 defaults (used when no profile is passed) ---

const GEAR_RATIOS = [0, 3.133, 2.045, 1.481, 1.161, 0.943];
const FINAL_DRIVE = 4.100;
const TIRE_CIRCUMFERENCE = 1.88;

const ENGINE_INERTIA = 0.15;
const VEHICLE_INERTIA = 90;

const FRICTION_TORQUE = 8;
const ENGINE_BRAKING_FACTOR = 12;
const BRAKE_DECEL = 9.0;

const SHIFT_DURATION = 150;

// Vehicle resistance (applied to speed directly, not through drivetrain)
const ROLLING_RESISTANCE = 0.4;  // m/s² — tire deformation, bearing friction (~constant)
const AERO_CD_A_RHO = 0.45;     // 0.5 * Cd * A * ρ (Cd≈0.3, A≈2m², ρ≈1.2) — combined aero constant
const VEHICLE_MASS = 1300;       // kg — for F=ma aero drag deceleration

// Idle air control — restoring torque that holds RPM near IDLE_RPM when decoupled
const IDLE_TARGET_RPM = 850;
const IDLE_RESTORE_GAIN = 15;    // Nm per 1000 RPM below target — simulates IAC valve

// Idle fluctuation — per-cylinder firing impulse makes idle imperfect
const IDLE_FLUTTER_RPM = 15;     // ±RPM amplitude of idle flutter
const IDLE_FLUTTER_HZ = 14;      // ~4-cyl at 850 RPM × 2 fires/rev ≈ 14 Hz

// Turbocharger parameters — small-frame turbo (BeamNG-style exhaust energy model)
// Small turbine = low inertia = fast spool. Full boost from ~3000 RPM at WOT.
const TURBO_INERTIA = 0.00008;       // kg·m² — turbine wheel moment of inertia (small = fast)
const TURBO_MAX_SHAFT_RPS = 1800;    // max shaft speed in rev/s (~108k RPM)
const TURBO_MAX_PSI = 14.7;          // peak manifold pressure (1 bar gauge)
const TURBO_WASTEGATE_PSI = 14.7;    // wastegate cracks open here
const TURBO_BOOST_MULTIPLIER = 0.6;  // torque multiplier at peak boost
const TURBO_FRICTION = 0.012;        // shaft bearing friction coefficient
const BOV_THRESHOLD_PSI = 2.0;       // BOV vents above this on throttle lift
const BOV_VENT_RATE = 40;            // psi/s — how fast BOV bleeds manifold pressure

// Clutch spring-damper parameters
// Tuned so that in mid gears (~gear 2-3) natural frequency ≈ 6 Hz, damping ratio ζ ≈ 0.35
const CLUTCH_STIFFNESS = 190;    // Nm/rad — torsional spring constant
const CLUTCH_DAMPING = 3.5;      // Nm·s/rad — torsional viscous damping
const CLUTCH_SETTLE_THRESHOLD = 5; // RPM — snap together when deviation < this

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

function lerpTorqueCurveWith(curve, rpm) {
  if (rpm <= curve[0][0]) return curve[0][1];
  if (rpm >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];

  for (let i = 0; i < curve.length - 1; i++) {
    const [r0, t0] = curve[i];
    const [r1, t1] = curve[i + 1];
    if (rpm >= r0 && rpm <= r1) {
      const t = (rpm - r0) / (r1 - r0);
      return t0 + t * (t1 - t0);
    }
  }
  return 0;
}

/** Module-level helpers using S2000 defaults — for backward-compat exports */
function lerpTorqueCurve(rpm) {
  return lerpTorqueCurveWith(TORQUE_CURVE, rpm);
}

function computePeakPower(curve) {
  return curve.reduce((max, [r, t]) => {
    const p = t * r * RPM_TO_RADS;
    return p > max ? p : max;
  }, 0);
}

const PEAK_POWER = computePeakPower(TORQUE_CURVE);

/**
 * BeamNG-style constant-power throttle model (S2000 defaults).
 * Kept as module-level export for backward compat.
 */
function throttleTorque(rpm, pedal) {
  if (pedal <= 0) return 0;

  // Base torque from curve, with falloff above redline (breathing limits)
  let wotTorque = lerpTorqueCurve(rpm);
  if (rpm > REDLINE_RPM) {
    // Torque drops ~40% per 1000 RPM above redline (valve float, poor breathing)
    const overRev = (rpm - REDLINE_RPM) / 1000;
    wotTorque *= Math.max(0.05, 1 - 0.4 * overRev);
  }

  // Constant-power limit applies at ALL throttle positions including WOT.
  // At high RPM, P/ω naturally reduces torque — prevents runaway on light inertia.
  const omega = rpm * RPM_TO_RADS;
  if (omega <= 0) return wotTorque * pedal;

  const targetPower = PEAK_POWER * pedal;
  const powerLimitedTorque = targetPower / omega;
  return Math.min(wotTorque, powerLimitedTorque);
}

// --- Drivetrain class ---

export class Drivetrain {
  /**
   * @param {object} [profile] - Engine profile from profiles.js. Omit for S2000 defaults.
   */
  constructor(profile) {
    const p = profile || null;

    // Profile parameters (instance properties)
    this._gearRatios = p ? p.gearRatios : GEAR_RATIOS;
    this._finalDrive = p ? p.finalDrive : FINAL_DRIVE;
    this._tireCircumference = p ? p.tireCircumference : TIRE_CIRCUMFERENCE;
    this._engineInertia = p ? p.engineInertia : ENGINE_INERTIA;
    this._vehicleInertia = p ? p.vehicleInertia : VEHICLE_INERTIA;
    this._frictionTorque = p ? p.frictionTorque : FRICTION_TORQUE;
    this._engineBrakingFactor = p ? p.engineBrakingFactor : ENGINE_BRAKING_FACTOR;
    this._brakeDecel = p ? p.brakeDecel : BRAKE_DECEL;
    this._shiftDuration = p ? p.shiftDuration : SHIFT_DURATION;
    this._torqueCurve = p ? p.torqueCurve : TORQUE_CURVE;
    this._idleRPM = p ? p.idleRPM : IDLE_RPM;
    this._redlineRPM = p ? p.redlineRPM : REDLINE_RPM;
    this._revCutRPM = p ? p.revCutRPM : REV_CUT_RPM;
    this._maxRPM = p ? p.maxRPM : MAX_RPM;
    this._maxGear = this._gearRatios.length - 1;
    this._peakPower = computePeakPower(this._torqueCurve);

    this.rpm = this._idleRPM;
    this.gear = 0;
    this.speed = 0;
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
    this._time = 0;              // accumulated time for idle flutter

    // Turbo state — BeamNG-style exhaust energy → shaft speed → boost
    this.boostPsi = 0;               // manifold gauge pressure
    this._turboShaftRPS = 0;         // turbine shaft speed (rev/s)
    this._bovActive = false;         // blow-off valve venting
    this._prevThrottle = 0;          // for BOV trigger detection
  }

  /** True when engine is decoupled from wheels (clutch held, engaging, or neutral). */
  get isDecoupled() {
    return this.gear === 0 || this.clutchHeld || this._clutchEngaging;
  }

  get totalRatio() {
    return this._gearRatios[this.gear] * this._finalDrive;
  }

  get gearLabel() {
    return this.gear === 0 ? 'N' : String(this.gear);
  }

  /** Instance-level torque interpolation using this profile's curve */
  _lerpTorque(rpm) {
    return lerpTorqueCurveWith(this._torqueCurve, rpm);
  }

  /** Instance-level constant-power throttle model using this profile's peak power.
   *  Includes over-rev torque falloff above redline. */
  _throttleTorque(rpm, pedal) {
    if (pedal <= 0) return 0;

    // Base torque from curve, with falloff above redline (breathing limits)
    let wotTorque = this._lerpTorque(rpm);
    if (rpm > this._redlineRPM) {
      // Torque drops ~40% per 1000 RPM above redline (valve float, poor breathing)
      const overRev = (rpm - this._redlineRPM) / 1000;
      wotTorque *= Math.max(0.05, 1 - 0.4 * overRev);
    }

    // Constant-power limit applies at ALL throttle positions including WOT.
    const omega = rpm * RPM_TO_RADS;
    if (omega <= 0) return wotTorque * pedal;

    const targetPower = this._peakPower * pedal;
    const powerLimitedTorque = targetPower / omega;
    return Math.min(wotTorque, powerLimitedTorque);
  }

  /** Snapshot of all drivetrain state for audio + debug. */
  getState() {
    const coupled = this.gear > 0 && !this.clutchHeld && !this._clutchEngaging;
    const totalRatio = this.gear > 0 ? this._gearRatios[this.gear] * this._finalDrive : 0;
    return {
      rpm: Math.max(this._idleRPM, this.rpm),
      speed: this.speed,
      gear: this.gear,
      gearLabel: this.gearLabel,
      shifting: false,
      clutchHeld: this.clutchHeld,
      clutchEngaging: this._clutchEngaging,
      revLimiterActive: this.revLimiterActive,
      throttle: false, // set by caller
      totalRatio,
      effectiveInertia: coupled
        ? this._engineInertia + this._vehicleInertia / (totalRatio * totalRatio)
        : this._engineInertia,
      torqueNm: coupled ? this._throttleTorque(this.rpm, this._lastThrottle) : 0,
      // Shift oscillation (consumed by audio for detune + gain modulation)
      shiftOscillation: this.shiftOscillation,
      shiftOscAmplitude: this.shiftOscAmplitude,
      shiftOscRPMDelta: this._oscRPMDelta,
      // Turbo
      boostPsi: this.boostPsi,
      turboSpool: this._turboShaftRPS / TURBO_MAX_SHAFT_RPS,
      bovActive: this._bovActive,
    };
  }

  /** Shift up. Works with or without clutch. Without clutch, triggers spring-damper. */
  shiftUp() {
    if (this.gear >= this._maxGear) return false;
    const hadClutch = this.clutchHeld;
    this.gear += 1;
    if (!hadClutch && this.gear > 0 && this.speed > 0) this._engageClutch();
    return true;
  }

  /** Shift down. Works with or without clutch. Over-rev protection included. */
  shiftDown() {
    if (this.gear <= 0) return false;

    const newGear = this.gear - 1;

    // Over-rev protection
    if (newGear > 0 && this.speed > 0) {
      const newTotalRatio = this._gearRatios[newGear] * this._finalDrive;
      const wheelRPS = (this.speed / 3.6) / this._tireCircumference;
      const projectedRPM = wheelRPS * 60 * newTotalRatio;
      if (projectedRPM > this._maxRPM) return false;
    }

    const hadClutch = this.clutchHeld;
    this.gear = newGear;
    if (!hadClutch && this.gear > 0 && this.speed > 0) this._engageClutch();
    return true;
  }

  /** @private Trigger spring-damper engagement from current state. */
  _engageClutch() {
    const totalRatio = this._gearRatios[this.gear] * this._finalDrive;
    const wheelRPS = (this.speed / 3.6) / this._tireCircumference;
    const wheelRPM = wheelRPS * 60 * totalRatio;
    const rpmDelta = wheelRPM - this.rpm;

    if (Math.abs(rpmDelta) > 100) {
      this._clutchEngaging = true;
      this._wheelOmega = wheelRPM * RPM_TO_RADS;
      this._clutchAngleDelta = 0;
      this._clutchInitialDelta = rpmDelta;
      this._oscRPMDelta = rpmDelta;
    } else {
      this.rpm = Math.max(this._idleRPM, Math.min(this._maxRPM, wheelRPM));
    }
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
    this._time += dt;

    const totalRatio = this.gear > 0 ? this._gearRatios[this.gear] * this._finalDrive : 0;

    // --- Clutch release edge: start spring-damper engagement ---
    if (this._wasClutchHeld && !this.clutchHeld && this.gear > 0 && this.speed > 0) {
      const wheelRPS = (this.speed / 3.6) / this._tireCircumference;
      const wheelRPM = wheelRPS * 60 * totalRatio;
      const rpmDelta = wheelRPM - this.rpm;

      if (Math.abs(rpmDelta) > 100) {
        this._clutchEngaging = true;
        this._wheelOmega = wheelRPM * RPM_TO_RADS;
        this._clutchAngleDelta = 0;
        this._clutchInitialDelta = rpmDelta;
        this._oscRPMDelta = rpmDelta;
      } else {
        this.rpm = Math.max(this._idleRPM, Math.min(this._maxRPM, wheelRPM));
      }
    }
    this._wasClutchHeld = this.clutchHeld;

    // If clutch is pressed during engagement, abort engagement
    if (this.clutchHeld && this._clutchEngaging) {
      this._clutchEngaging = false;
      this.shiftOscillation = 0;
      this.shiftOscAmplitude = 0;
    }

    const coupled = this.gear > 0 && !this.clutchHeld && !this._clutchEngaging;

    // Rev limiter (fuel cut with hysteresis)
    if (this.rpm >= this._redlineRPM) {
      this.revLimiterActive = true;
    } else if (this.rpm < this._revCutRPM) {
      this.revLimiterActive = false;
    }

    // Update turbo spool
    this._updateTurbo(dt, throttle);

    // Drive torque — constant-power throttle model (BeamNG-style) + turbo boost
    let driveTorque = 0;
    if (throttle > 0 && !this.revLimiterActive) {
      driveTorque = this._throttleTorque(this.rpm, throttle);
      // Boost adds torque proportional to manifold pressure
      const boostFraction = this.boostPsi / TURBO_MAX_PSI;
      driveTorque *= (1 + boostFraction * TURBO_BOOST_MULTIPLIER);
    }

    // Resistance torque — engine braking scales with closed throttle
    let resistanceTorque = this._frictionTorque;
    const closedThrottle = 1 - throttle;
    if (coupled) {
      resistanceTorque += this._engineBrakingFactor * totalRatio * closedThrottle;
      // Aero + rolling drag reflected through drivetrain as engine resistance torque
      const v = this.speed / 3.6; // m/s
      const dragForce = AERO_CD_A_RHO * v * v + ROLLING_RESISTANCE * VEHICLE_MASS;
      const wheelRadius = this._tireCircumference / (2 * Math.PI);
      resistanceTorque += (dragForce * wheelRadius) / totalRatio;
    } else {
      // Decoupled: compression braking + pumping losses scale with RPM
      resistanceTorque += this._engineBrakingFactor * 1.2 * closedThrottle;
      // RPM-proportional friction (pumping losses increase with speed)
      resistanceTorque += (this.rpm / 1000) * 4.0 * closedThrottle;
    }

    if (this.revLimiterActive) {
      resistanceTorque += this._engineBrakingFactor * 2;
    }

    // --- Clutch spring-damper engagement ---
    if (this._clutchEngaging) {
      const engineOmega = this.rpm * RPM_TO_RADS;
      const omegaDelta = this._wheelOmega - engineOmega;

      // Integrate angular displacement
      this._clutchAngleDelta += omegaDelta * dt;

      // Spring-damper torque
      const clutchTorque = CLUTCH_STIFFNESS * this._clutchAngleDelta + CLUTCH_DAMPING * omegaDelta;

      // Apply to engine side (on top of drive/resistance torques)
      const engineAlpha = (driveTorque - resistanceTorque + clutchTorque) / this._engineInertia;
      this.rpm += engineAlpha * dt * RADS_TO_RPM;

      // Apply reaction to wheel side (including aero + rolling drag)
      const wheelJ = this._vehicleInertia / (totalRatio * totalRatio);
      const v = this.speed / 3.6;
      const dragForce = AERO_CD_A_RHO * v * v + ROLLING_RESISTANCE * VEHICLE_MASS;
      const wheelRadius = this._tireCircumference / (2 * Math.PI);
      const dragTorqueAtEngine = (dragForce * wheelRadius) / totalRatio;
      this._wheelOmega += ((-clutchTorque - dragTorqueAtEngine) / wheelJ) * dt;

      // Derive speed from wheel omega
      this.speed = Math.max(0, (this._wheelOmega * RADS_TO_RPM / totalRatio) * this._tireCircumference / 60 * 3.6);

      // Update audio oscillation from actual physics state
      const rpmDeviation = this.rpm - (this._wheelOmega * RADS_TO_RPM);
      if (Math.abs(this._clutchInitialDelta) > 1) {
        this.shiftOscillation = Math.max(-1, Math.min(1, rpmDeviation / this._clutchInitialDelta));
        this.shiftOscAmplitude = Math.min(1, Math.abs(rpmDeviation / this._clutchInitialDelta));
      }

      // Check convergence
      const rpmDiff = Math.abs(this.rpm - this._wheelOmega * RADS_TO_RPM);
      if (rpmDiff < CLUTCH_SETTLE_THRESHOLD && Math.abs(omegaDelta) < CLUTCH_SETTLE_THRESHOLD * RPM_TO_RADS) {
        this._clutchEngaging = false;
        // Snap to shared velocity (conserve momentum)
        const Je = this._engineInertia;
        const Jw = this._vehicleInertia / (totalRatio * totalRatio);
        const sharedOmega = (Je * this.rpm * RPM_TO_RADS + Jw * this._wheelOmega) / (Je + Jw);
        this.rpm = sharedOmega * RADS_TO_RPM;
        this.shiftOscillation = 0;
        this.shiftOscAmplitude = 0;
      }
    } else if (coupled) {
      // Rigid coupling — engine and wheels locked
      const J = this._engineInertia + this._vehicleInertia / (totalRatio * totalRatio);
      const netTorque = driveTorque - resistanceTorque;
      this.rpm += (netTorque / J) * dt * RADS_TO_RPM;

      const wheelRPM = this.rpm / totalRatio;
      this.speed = (wheelRPM * this._tireCircumference / 60) * 3.6;
    } else {
      // Decoupled (neutral or clutch held) — engine revs freely
      let netTorque = driveTorque - resistanceTorque;

      // Idle air control: restoring torque pulls RPM back toward idle target
      if (throttle < 0.05 && this.rpm < IDLE_TARGET_RPM + 200) {
        const deficit = (IDLE_TARGET_RPM - this.rpm) / 1000; // per 1000 RPM
        netTorque += IDLE_RESTORE_GAIN * deficit;
      }

      this.rpm += (netTorque / this._engineInertia) * dt * RADS_TO_RPM;

      // Vehicle coasts — rolling resistance + aero drag
      if (this.speed > 0) {
        const v = this.speed / 3.6; // m/s
        const aeroDrag = AERO_CD_A_RHO * v * v / VEHICLE_MASS; // m/s²
        const decel = ROLLING_RESISTANCE + aeroDrag;
        this.speed = Math.max(0, this.speed - decel * dt * 3.6);
      }
    }

    // Clear oscillation when not engaging
    if (!this._clutchEngaging && this.shiftOscAmplitude > 0) {
      this.shiftOscillation = 0;
      this.shiftOscAmplitude = 0;
    }

    // Floor RPM at idle (never stall)
    if (this.rpm < this._idleRPM) this.rpm = this._idleRPM;
    // No hard ceiling — engine can over-rev past redline (limiter provides resistance)

    // Idle flutter: per-cylinder firing pulses make idle imperfect
    if (this.rpm < this._idleRPM + 100 && throttle < 0.05) {
      const flutter = IDLE_FLUTTER_RPM * Math.sin(2 * Math.PI * IDLE_FLUTTER_HZ * this._time);
      this.rpm += flutter * dt * 60; // scale by dt so it's frame-rate independent
    }

    // Braking: decelerates the vehicle (wheels), not the engine directly.
    if (braking && this.speed > 0) {
      const speedMS = this.speed / 3.6;
      const newSpeedMS = Math.max(0, speedMS - this._brakeDecel * dt);
      this.speed = newSpeedMS * 3.6;

      // In gear: sync RPM to the braked wheel speed
      if (coupled) {
        const brakedWheelRPS = newSpeedMS / this._tireCircumference;
        const brakedRPM = brakedWheelRPS * 60 * totalRatio;
        this.rpm = Math.max(this._idleRPM, brakedRPM);
      } else if (this._clutchEngaging) {
        // Braking affects wheel side during clutch engagement
        this._wheelOmega = Math.max(0, (newSpeedMS / this._tireCircumference) * 2 * Math.PI * totalRatio);
      }
    }
  }

  /**
   * @private BeamNG-style turbo: exhaust gas energy spins turbine shaft,
   * shaft speed² maps to compressor pressure, wastegate limits boost,
   * BOV vents manifold on throttle lift.
   */
  _updateTurbo(dt, throttle) {
    // --- Exhaust energy → turbine torque ---
    // Exhaust gas energy ∝ RPM × throttle. Small turbo = low inertia,
    // so even moderate exhaust flow accelerates the shaft quickly.
    const exhaustFlow = (this.rpm / this._redlineRPM) * throttle;
    // Turbine torque (N·m on shaft) — tuned so WOT at 3000 RPM
    // spools to ~100% in under a second
    const turbineTorque = exhaustFlow * 3.5;

    // --- Compressor load (back-pressure resists shaft) ---
    // Rises with shaft speed² — this is what limits equilibrium RPM
    const normShaft = this._turboShaftRPS / TURBO_MAX_SHAFT_RPS;
    const compressorLoad = normShaft * normShaft * 2.5;

    // --- Bearing friction ---
    const friction = this._turboShaftRPS * TURBO_FRICTION / TURBO_MAX_SHAFT_RPS * 10;

    // --- Wastegate: bleeds exhaust energy when boost exceeds target ---
    let wastegateBleed = 0;
    if (this.boostPsi > TURBO_WASTEGATE_PSI * 0.85) {
      const overboost = (this.boostPsi - TURBO_WASTEGATE_PSI * 0.85) / (TURBO_WASTEGATE_PSI * 0.15);
      wastegateBleed = Math.min(turbineTorque * 0.9, turbineTorque * overboost);
    }

    // --- Shaft angular acceleration ---
    const netTorque = turbineTorque - compressorLoad - friction - wastegateBleed;
    const shaftAccel = netTorque / TURBO_INERTIA; // rad/s² on shaft
    this._turboShaftRPS += (shaftAccel / (2 * Math.PI)) * dt;
    this._turboShaftRPS = Math.max(0, Math.min(this._turboShaftRPS, TURBO_MAX_SHAFT_RPS));

    // --- Boost pressure: compressor output ∝ shaft speed² ---
    const rawBoost = normShaft * normShaft * TURBO_MAX_PSI;

    // --- BOV logic ---
    const throttleDrop = this._prevThrottle - throttle;
    if (throttleDrop > 0.15 && this.boostPsi > BOV_THRESHOLD_PSI) {
      this._bovActive = true;
    }

    if (this._bovActive) {
      // BOV vents manifold pressure rapidly
      this.boostPsi = Math.max(0, this.boostPsi - BOV_VENT_RATE * dt);
      // BOV also slows compressor (surge avoidance)
      this._turboShaftRPS *= (1 - 1.5 * dt);
      if (this.boostPsi < 0.5) {
        this._bovActive = false;
      }
    } else {
      this.boostPsi = Math.min(rawBoost, TURBO_WASTEGATE_PSI);
    }

    this._prevThrottle = throttle;
  }

}

export { GEAR_RATIOS, FINAL_DRIVE, PEAK_POWER, TURBO_MAX_PSI, throttleTorque };
