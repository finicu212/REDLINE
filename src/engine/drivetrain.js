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
const PSI_PER_BAR = 14.504;
const SUPERCHARGER_RESPONSE_S = 0.06; // manifold fill time — effectively instant vs a turbo
const MAX_INTAKE_VACUUM_BAR = 0.7;   // closed-throttle manifold vacuum (petrol)
const BOV_THRESHOLD_PSI = 2.0;       // BOV vents above this on throttle lift
const BOV_VENT_RATE = 40;            // psi/s — how fast BOV bleeds manifold pressure

// Clutch spring-damper parameters
// Tuned so that in mid gears (~gear 2-3) natural frequency ≈ 6 Hz, damping ratio ζ ≈ 0.35
const CLUTCH_STIFFNESS = 190;    // Nm/rad — torsional spring constant
const CLUTCH_DAMPING = 3.5;      // Nm·s/rad — torsional viscous damping
const CLUTCH_SETTLE_THRESHOLD = 5; // RPM — snap together when deviation < this
const CLUTCH_MAX_SUBSTEP = 0.002;  // s — keeps ω_n·h ≈ 0.1 in 1st gear (stable)

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

const SANE_SPEED_KMH = 1000;     // NaN guard: anything past this is a numerical blow-up

// Hard limiter bounce: extra friction on unfired cycles, and max overshoot per frame
const HARD_CUT_FRICTION_PER_KRPM = 0.5;
const HARD_CUT_MAX_OVERSHOOT = 60; // RPM

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
    this._mass = p?.mass ?? VEHICLE_MASS;
    // hysteresis: fuel cut until RPM falls below revCutRPM (legacy)
    // hard:       timed fuel cut of cutMs — the GT-style bounce
    // soft:       torque taper over the last softRangeRPM; with cutMs 0 it only holds, never cuts
    // none:       no limiter — torque falloff past redline is the only ceiling (carb/points era)
    this._limiter = p?.limiter ?? { style: 'hysteresis' };
    this._limiterTimer = 0;
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
    this._hasTurbo = p ? !!p.turbo : true;  // default true for backward compat
    this._throttlePlate = p?.fuel !== 'diesel'; // diesels are unthrottled: no intake vacuum
    // Belt-driven Roots blower: boost follows crank speed instantly, no turbine lag
    this._supercharger = p?.supercharger ? {
      maxBoostBar: 0.55,    // ~8 psi street blower
      fullBoostRPM: 2500,   // positive displacement: full boost arrives early
      torqueGain: 0.55,     // torque added at full boost
      driveLossNm: 30,      // belt drive loss at 5000 RPM, WOT
      ...p.supercharger,
    } : null;
    // profile.turbo may be `true` (legacy petrol tune) or an object overriding these
    this._turbo = {
      torqueGain: TURBO_BOOST_MULTIPLIER, // torque added at full boost
      curveIncludesBoost: false,          // true: torqueCurve is the published on-boost curve
      bov: true,                          // diesels have none — boost just bleeds off
      spool: 1,                           // turbine drive scale; <1 = bigger, laggier turbo
      ...(p && typeof p.turbo === 'object' ? p.turbo : {}),
    };
    this.boostPsi = 0;               // manifold gauge pressure
    this._turboShaftRPS = 0;         // turbine shaft speed (rev/s)
    this._bovActive = false;         // blow-off valve venting
    this._prevThrottle = 0;          // for BOV trigger detection

    // NaN guard — last finite state, restored if a frame produces non-finite values
    this._lastGoodRPM = this.rpm;
    this._lastGoodSpeed = 0;
    this.nanRecoveries = 0;
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
    const { style, softRangeRPM = 0, cutMs = 0 } = this._limiter;
    const softStart = this._redlineRPM - softRangeRPM;
    if (style === 'soft' && softRangeRPM > 0 && rpm > softStart) {
      // Ignition-retard taper. Pure hold (no cut) tapers to zero so RPM settles at redline.
      const floor = cutMs > 0 ? 0.15 : 0;
      wotTorque *= Math.max(floor, 1 - (1 - floor) * (rpm - softStart) / softRangeRPM);
    }
    if (rpm > this._redlineRPM) {
      // Torque drops ~40% per 1000 RPM above redline (valve float, poor breathing).
      // Without a limiter that falloff is the ceiling, so let it reach zero.
      const overRev = (rpm - this._redlineRPM) / 1000;
      wotTorque *= style === 'none'
        ? Math.max(0, 1 - overRev)
        : Math.max(0.05, 1 - 0.4 * overRev);
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
      rpm: Number.isFinite(this.rpm) ? Math.max(this._idleRPM, this.rpm) : this._idleRPM,
      speed: Number.isFinite(this.speed) ? this.speed : 0,
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
      limiterStyle: this._limiter.style,
      limiterLoad: this._limiterLoad(),
      boostPsi: this.boostPsi,
      manifoldBar: this._manifoldBar(),
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
    else if (this.gear === 0) this._cancelEngagement();
    return true;
  }

  /** Shift down. Works with or without clutch. No over-rev protection: money shifts are allowed. */
  shiftDown() {
    if (this.gear <= 0) return false;

    const newGear = this.gear - 1;
    const hadClutch = this.clutchHeld;
    this.gear = newGear;
    if (!hadClutch && this.gear > 0 && this.speed > 0) this._engageClutch();
    // Spring-damper divides by totalRatio — must not keep running in neutral
    else if (this.gear === 0) this._cancelEngagement();
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
      // Close enough to snap; also ends any engagement left over from the previous gear
      this._cancelEngagement();
      this.rpm = Math.max(this._idleRPM, Math.min(this._maxRPM, wheelRPM));
    }
  }

  /** Gauge pressure in bar: boost when spooled, intake vacuum on a closed throttle plate. */
  _manifoldBar() {
    const boost = this.boostPsi / PSI_PER_BAR;
    const vacuum = this._throttlePlate ? MAX_INTAKE_VACUUM_BAR * (1 - this._lastThrottle) : 0;
    return boost - vacuum;
  }

  /** 0–1: how deep into the soft-hold band the engine is while on throttle (drives audio hunting). */
  _limiterLoad() {
    const { style, softRangeRPM = 0 } = this._limiter;
    if (style !== 'soft' || !softRangeRPM || this._lastThrottle < 0.05) return 0;
    const x = (this.rpm - (this._redlineRPM - softRangeRPM)) / softRangeRPM;
    return Math.max(0, Math.min(1, x)) * this._lastThrottle;
  }

  /** @private Fuel cut per the profile's limiter style. */
  _updateRevLimiter(dt) {
    const { style, cutMs = 0 } = this._limiter;
    if (style === 'none') {
      this.revLimiterActive = false;
    } else if (style === 'soft' && !cutMs) {
      this.revLimiterActive = false;
    } else if (style === 'hard' || style === 'soft') {
      if (this._limiterTimer > 0) {
        this._limiterTimer -= dt;
        // Minimum cut elapsed — fuel resumes only once RPM is back under the limit
        this.revLimiterActive = this._limiterTimer > 0 || this.rpm >= this._redlineRPM;
      } else if (this.rpm >= this._redlineRPM) {
        this._limiterTimer = cutMs / 1000;
        this.revLimiterActive = true;
      } else {
        this.revLimiterActive = false;
      }
    } else if (this.rpm >= this._redlineRPM) {
      this.revLimiterActive = true;
    } else if (this.rpm < this._revCutRPM) {
      this.revLimiterActive = false;
    }
  }

  /** @private Stop spring-damper engagement and clear its audio oscillation. */
  _cancelEngagement() {
    this._clutchEngaging = false;
    this._clutchAngleDelta = 0;
    this.shiftOscillation = 0;
    this.shiftOscAmplitude = 0;
  }

  /**
   * @private Restore last finite state if this frame produced NaN/Infinity.
   * One bad frame must not freeze the sim: NaN never recovers on its own and
   * throws inside Web Audio's setTargetAtTime, killing the render loop.
   */
  _guardFinite() {
    // Finite-but-absurd values (diverging integrator) are caught too, before they overflow
    const sane = (x, limit) => Number.isFinite(x) && Math.abs(x) < limit;
    // Wide enough for a 7th→1st money shift at top speed (~4.5× redline)
    const rpmLimit = this._maxRPM * 8;
    const ok = sane(this.rpm, rpmLimit) && sane(this.speed, SANE_SPEED_KMH)
      && sane(this._wheelOmega, rpmLimit * RPM_TO_RADS) && sane(this._clutchAngleDelta, 1e4)
      && sane(this.boostPsi, 1e3) && sane(this._turboShaftRPS, 1e6);
    if (ok) {
      this._lastGoodRPM = this.rpm;
      this._lastGoodSpeed = this.speed;
      return;
    }
    this.nanRecoveries += 1;
    console.warn(`[drivetrain] non-finite or runaway state in gear ${this.gear}, restored last good (#${this.nanRecoveries})`);
    this.rpm = this._lastGoodRPM;
    this.speed = this._lastGoodSpeed;
    this._cancelEngagement();
    this._wheelOmega = 0;
    this.boostPsi = 0;
    this._turboShaftRPS = 0;
    this._bovActive = false;
  }

  /**
   * Update physics. Call every frame.
   * @param {number} dt - delta time in seconds
   * @param {number} throttle - throttle position 0–1
   * @param {boolean} braking - true if brake is applied
   */
  update(dt, throttle, braking = false) {
    if (!(dt > 0)) return; // NaN, zero, or negative (rAF timestamp before first performance.now())
    dt = Math.min(dt, 0.05);
    throttle = Number(throttle);
    throttle = Number.isFinite(throttle) ? Math.max(0, Math.min(1, throttle)) : 0;
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

    this._updateRevLimiter(dt);

    // Update turbo spool (only if profile has turbo)
    if (this._hasTurbo) this._updateTurbo(dt, throttle);
    if (this._supercharger) this._updateSupercharger(dt, throttle);

    // Drive torque — constant-power throttle model (BeamNG-style) + turbo boost
    let driveTorque = 0;
    if (throttle > 0 && !this.revLimiterActive) {
      driveTorque = this._throttleTorque(this.rpm, throttle);
      if (this._hasTurbo) {
        const { torqueGain, curveIncludesBoost } = this._turbo;
        // Wastegate settles boost ~10% under max; published curves are measured there
        const boostFraction = curveIncludesBoost
          ? Math.min(1, this.boostPsi / (TURBO_WASTEGATE_PSI * 0.9))
          : this.boostPsi / TURBO_MAX_PSI;
        // Published curves are on-boost: scale down off-boost so full boost hits the spec
        driveTorque *= (1 + boostFraction * torqueGain) / (curveIncludesBoost ? 1 + torqueGain : 1);
      }
      if (this._supercharger) {
        const { maxBoostBar, torqueGain } = this._supercharger;
        driveTorque *= 1 + (this.boostPsi / (maxBoostBar * PSI_PER_BAR)) * torqueGain;
      }
    }

    // Resistance torque — engine braking scales with closed throttle
    let resistanceTorque = this._frictionTorque;
    if (this._supercharger) {
      // The belt always turns the rotors; the bypass valve only cuts pumping work at part throttle
      resistanceTorque += this._supercharger.driveLossNm * (this.rpm / 5000) * (0.3 + 0.7 * throttle);
    }
    const closedThrottle = 1 - throttle;
    if (coupled) {
      resistanceTorque += this._engineBrakingFactor * totalRatio * closedThrottle;
      // Aero + rolling drag reflected through drivetrain as engine resistance torque
      const v = this.speed / 3.6; // m/s
      const dragForce = AERO_CD_A_RHO * v * v + ROLLING_RESISTANCE * this._mass;
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
      // Unfired cylinders still pay friction, which grows with RPM — this is what drops the needle
      if (this._limiter.style === 'hard') {
        resistanceTorque += this._frictionTorque * (this.rpm / 1000) * HARD_CUT_FRICTION_PER_KRPM;
      }
    }

    // --- Clutch spring-damper engagement ---
    if (this._clutchEngaging) {
      // Explicit Euler goes unstable once ω_n·dt approaches 2 (1st gear at 20 FPS),
      // so integrate in fixed substeps well below that.
      const steps = Math.ceil(dt / CLUTCH_MAX_SUBSTEP);
      const h = dt / steps;
      for (let i = 0; i < steps && this._clutchEngaging; i++) {
        this._stepEngagement(h, driveTorque, resistanceTorque, totalRatio);
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
      if (throttle < 0.05 && this.rpm < this._idleRPM + 200) {
        const deficit = (this._idleRPM - this.rpm) / 1000; // per 1000 RPM
        netTorque += IDLE_RESTORE_GAIN * deficit;
      }

      this.rpm += (netTorque / this._engineInertia) * dt * RADS_TO_RPM;

      // Vehicle coasts — rolling resistance + aero drag
      if (this.speed > 0) {
        const v = this.speed / 3.6; // m/s
        const aeroDrag = AERO_CD_A_RHO * v * v / this._mass; // m/s²
        const decel = ROLLING_RESISTANCE + aeroDrag;
        this.speed = Math.max(0, this.speed - decel * dt * 3.6);
      }
    }

    // Clear oscillation when not engaging
    if (!this._clutchEngaging && this.shiftOscAmplitude > 0) {
      this.shiftOscillation = 0;
      this.shiftOscAmplitude = 0;
    }

    // A real ECU cuts at a crank angle, not a frame boundary: cap per-frame overshoot
    if (this._limiter.style === 'hard' && !this.revLimiterActive && this.rpm > this._redlineRPM + HARD_CUT_MAX_OVERSHOOT) {
      this.rpm = this._redlineRPM + HARD_CUT_MAX_OVERSHOOT;
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

    this._guardFinite();
  }

  /** @private One spring-damper integration step of length h seconds. */
  _stepEngagement(h, driveTorque, resistanceTorque, totalRatio) {
    const engineOmega = this.rpm * RPM_TO_RADS;
    const omegaDelta = this._wheelOmega - engineOmega;

    // Integrate angular displacement
    this._clutchAngleDelta += omegaDelta * h;

    // Spring-damper torque
    const clutchTorque = CLUTCH_STIFFNESS * this._clutchAngleDelta + CLUTCH_DAMPING * omegaDelta;

    // Apply to engine side (on top of drive/resistance torques)
    const engineAlpha = (driveTorque - resistanceTorque + clutchTorque) / this._engineInertia;
    this.rpm += engineAlpha * h * RADS_TO_RPM;

    // Apply reaction to wheel side (including aero + rolling drag)
    const wheelJ = this._vehicleInertia / (totalRatio * totalRatio);
    const v = this.speed / 3.6;
    const dragForce = AERO_CD_A_RHO * v * v + ROLLING_RESISTANCE * this._mass;
    const wheelRadius = this._tireCircumference / (2 * Math.PI);
    const dragTorqueAtEngine = (dragForce * wheelRadius) / totalRatio;
    this._wheelOmega += ((-clutchTorque - dragTorqueAtEngine) / wheelJ) * h;

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
  }

  /** @private Roots blower: boost ∝ crank speed up to fullBoostRPM, dumped by the bypass valve off-throttle. */
  _updateSupercharger(dt, throttle) {
    const { maxBoostBar, fullBoostRPM } = this._supercharger;
    const rpmFactor = Math.min(1, this.rpm / fullBoostRPM);
    const bypassClosed = Math.max(0, Math.min(1, (throttle - 0.2) / 0.8));
    const target = maxBoostBar * PSI_PER_BAR * rpmFactor * bypassClosed;
    this.boostPsi += (target - this.boostPsi) * Math.min(1, dt / SUPERCHARGER_RESPONSE_S);
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
    const turbineTorque = exhaustFlow * 3.5 * this._turbo.spool;

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
    if (this._turbo.bov && throttleDrop > 0.15 && this.boostPsi > BOV_THRESHOLD_PSI) {
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
