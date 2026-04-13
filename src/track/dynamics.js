/**
 * Car on the racing line: a point mass that follows the line at arc length s with a
 * lateral offset d. The engine/brakes (Drivetrain) own longitudinal speed; this owns
 * everything tyres do to it — grip-limited braking, traction, cornering, sliding.
 *
 * Grip model (per unit mass, so everything is in m/s²):
 *   axle capacity  = mu · axle load share · (g + downforce·v²)
 *   load share     = static share ± h/L · a_long / g        (weight transfer)
 *   axle usage u   = |(lateral, longitudinal) demand| / capacity   (friction circle)
 * Front saturates first → understeer (runs wide). Rear first → oversteer (yaw, spin).
 * Braking loads the front (sharper turn-in, looser rear); throttle loads the rear.
 */

import { sampleLine, G } from './racingLine.js';
import { TRACK_HALF_WIDTH, KERB_WIDTH, RUNOFF_WIDTH } from './geometry.js';

export const DEFAULT_CHASSIS = {
  mu: 1.0,            // peak tyre friction coefficient
  downforce: 0,       // extra normal accel per (m/s)², m/s² per m²/s²
  frontWeight: 0.52,  // static front load share
  cgHeight: 0.22,     // CG height / wheelbase (weight-transfer strength)
  frontGrip: 0.96,    // front tyre grip relative to rear: <1 = stable understeer at the limit
  brakeBias: 0.62,    // share of braking done by the front axle
  drive: 'rwd',       // 'rwd' | 'fwd'
  abs: true,          // ABS: never locks, brakes just short of the limit
  tc: false,          // traction control: cuts power instead of spinning up
};

const SURFACE_GRIP = { track: 1, kerb: 0.9, runoff: 0.5 };
const LOCKED_SLIDE_MU = 0.8;      // sliding rubber grips less than peak
const ABS_EFFICIENCY = 0.96;
const SPIN_YAW = 0.85;            // rad of slip angle that becomes a spin
const SPIN_TIME = 1.3;            // s
const SPIN_DECEL = 7;             // m/s² while spinning
const DRIVER_OMEGA = 1.1;         // rad/s — how firmly the "driver" pulls back to the line
const EDGE = TRACK_HALF_WIDTH - 0.9;
const BARRIER = TRACK_HALF_WIDTH + KERB_WIDTH + RUNOFF_WIDTH;
const ACCEL_FILTER_S = 0.12;

export class CarDynamics {
  /**
   * @param {object} line - buildRacingLine() result
   * @param {object} [chassis] - grip/balance params (profile.chassis)
   * @param {object} [opts] - { startS, kerbZones: [[s0, s1], ...] }
   */
  constructor(line, chassis = {}, opts = {}) {
    this.line = line;
    this.c = { ...DEFAULT_CHASSIS, ...chassis };
    this.kerbZones = opts.kerbZones || [];
    this.reset(opts.startS ?? 0);
  }

  reset(s = 0) {
    this.s = s;                 // arc length along the line (wrapped)
    this.distance = 0;          // total distance driven (unwrapped)
    this.d = 0;                 // lateral offset from the line, + = left
    this.vd = 0;                // lateral velocity
    this.yaw = 0;               // body slip angle (visual + physics), + = nose left
    this.spinTimer = 0;
    this.spinDir = 1;
    this.v = 0;
    this.aLong = 0;
    this.aLat = 0;
    this.front = this.c.frontWeight;
    this.usageF = 0;
    this.usageR = 0;
    this.locked = false;
    this.absActive = false;
    this.wheelspin = 0;
    this.tcActive = false;
    this.surface = 'track';
    this.understeer = 0;
    this.oversteer = 0;
    this.events = [];
    this._prevV = 0;
    this._primed = false;
  }

  /** Brake pedal → delivered deceleration, limited by what the tyres can take right now. */
  brakeDecelFor(pedal, maxDecel) {
    this.locked = false;
    this.absActive = false;
    if (!(pedal > 0) || this.v <= 0.5) return maxDecel * Math.max(0, pedal || 0);
    const want = pedal * maxDecel;
    // Weight transfer depends on the decel actually achieved — iterate to the fixed point
    let available = want;
    for (let i = 0; i < 6; i++) available = Math.min(want, this._brakeCapacity(available));
    available = this._brakeCapacity(available);
    if (want <= available) return want;
    if (this.c.abs) {
      this.absActive = true;
      return available * ABS_EFFICIENCY;
    }
    this.locked = true;
    return available * LOCKED_SLIDE_MU;
  }

  /**
   * Max braking decel before the fronts lock at the current speed/cornering load.
   * An overloaded rear doesn't stop the brakes working — it slides, and update()
   * turns that into oversteer (trail-braking too deep rotates the car).
   */
  _brakeCapacity(decel) {
    const { mu, downforce, frontWeight: fs, cgHeight, brakeBias } = this.c;
    const grip = mu * SURFACE_GRIP[this.surface];
    const gEff = G + downforce * this.v * this.v;
    const front = clamp(fs + cgHeight * decel / G, 0.15, 0.85);
    const latF = Math.abs(this.aLat) * fs;
    const capF = grip * this.c.frontGrip * front * gEff;
    const availF = Math.sqrt(Math.max(0, capF * capF - latF * latF));
    return availF / brakeBias;
  }

  /**
   * Advance one frame. Call after drivetrain.update().
   * @param {number} dt
   * @param {{ speedMS: number, throttle: number, brake: number }} input
   * @returns {number} speed to scrub from the drivetrain (m/s)
   */
  update(dt, { speedMS, throttle = 0, brake = 0 }) {
    this.events.length = 0;
    if (!(dt > 0)) return 0;
    const c = this.c;
    const v = Math.max(0, speedMS);
    this.v = v;

    // Longitudinal accel from the drivetrain's result (filtered: it drives weight transfer)
    if (!this._primed) { this._prevV = v; this._primed = true; }
    const rawA = (v - this._prevV) / dt;
    this._prevV = v;
    this.aLong += (rawA - this.aLong) * Math.min(1, dt / ACCEL_FILTER_S);

    const p = sampleLine(this.line, this.s);
    // Curvature at the car's offset: outside of a corner is a bigger radius
    const kEff = p.curvature / Math.max(0.2, 1 + p.curvature * this.d);
    const turnSign = Math.sign(kEff);
    const aLatDemand = v * v * kEff;
    this.aLat = aLatDemand;

    // --- Loads and capacities ---
    this.surface = this._surfaceAt(this.s, this.d);
    const grip = c.mu * SURFACE_GRIP[this.surface];
    const gEff = G + c.downforce * v * v;
    const fs = c.frontWeight;
    this.front = clamp(fs - c.cgHeight * this.aLong / G, 0.15, 0.85);
    const capF = grip * c.frontGrip * this.front * gEff;
    const capR = grip * (1 - this.front) * gEff;

    // --- Longitudinal demand per axle ---
    let longF = 0, longR = 0;
    if (this.aLong < 0 && brake > 0) {
      longF = -this.aLong * c.brakeBias;
      longR = -this.aLong * (1 - c.brakeBias);
    } else if (this.aLong > 0) {
      if (c.drive === 'fwd') longF = this.aLong; else longR = this.aLong;
    }

    // --- Traction: can the driven axle put this down? ---
    let scrub = 0;
    this.wheelspin = 0;
    this.tcActive = false;
    const drivenCap = c.drive === 'fwd' ? capF : capR;
    const drivenLat = Math.abs(aLatDemand) * (c.drive === 'fwd' ? fs : 1 - fs);
    const tractionAvail = Math.sqrt(Math.max(0, drivenCap * drivenCap - drivenLat * drivenLat));
    if (this.aLong > tractionAvail && throttle > 0.05 && v > 1) {
      const excess = this.aLong - tractionAvail;
      if (c.tc) {
        this.tcActive = true;
        scrub += excess * dt;
      } else {
        this.wheelspin = Math.min(1, excess / Math.max(1, tractionAvail));
        scrub += excess * 0.85 * dt;
        // spinning tyres lose lateral grip too
        if (c.drive === 'fwd') longF = drivenCap; else longR = drivenCap * (1 + this.wheelspin);
      }
    }

    // Locked fronts can't steer
    const lockedFactor = this.locked ? 0.15 : 1;

    // --- Lateral capacity per axle after longitudinal use ---
    const latAvailF = Math.sqrt(Math.max(0, capF * capF - longF * longF)) * lockedFactor;
    const latAvailR = Math.sqrt(Math.max(0, capR * capR - longR * longR));
    // Total lateral accel each axle can support, scaled by its static share
    const latCapF = latAvailF / fs;
    const latCapR = latAvailR / (1 - fs);
    const latCap = Math.min(latCapF, latCapR);

    this.usageF = Math.hypot(Math.abs(aLatDemand) * fs, longF) / Math.max(1e-6, capF / lockedFactor);
    this.usageR = Math.hypot(Math.abs(aLatDemand) * (1 - fs), longR) / Math.max(1e-6, capR);
    if (this.locked) this.usageF = Math.max(this.usageF, 1.2);

    this.understeer = 0;
    this.oversteer = 0;

    if (this.spinTimer > 0) {
      // --- Spinning: rotate, slide, bleed speed ---
      this.spinTimer -= dt;
      this.yaw += this.spinDir * (2 * Math.PI / SPIN_TIME) * dt;
      scrub += Math.min(v, SPIN_DECEL * dt);
      this.vd *= Math.exp(-dt * 1.5);
      if (this.spinTimer <= 0) {
        this.yaw = 0;
        this.vd = 0;
        this.events.push({ type: 'recovered' });
      }
    } else if (Math.abs(aLatDemand) > latCap && v > 3) {
      // --- Over the limit ---
      const deficit = Math.abs(aLatDemand) - latCap;
      if (latCapF <= latCapR) {
        // Understeer: front washes out, car drifts to the outside
        this.understeer = Math.min(1, deficit / Math.max(1, latCap));
        this.vd += turnSign * deficit * dt;
        this.yaw += (0 - this.yaw) * Math.min(1, dt * 3);
        scrub += 0.3 * deficit * dt;
      } else {
        // Oversteer: rear steps out, nose rotates into the corner, car slides wide a bit
        this.oversteer = Math.min(1, deficit / Math.max(1, latCap));
        this.yaw += -turnSign * (deficit / Math.max(8, v)) * 2.2 * dt;
        this.vd += turnSign * deficit * 0.45 * dt;
        scrub += 0.25 * deficit * dt;
        if (Math.abs(this.yaw) > SPIN_YAW) this._startSpin();
      }
    } else {
      // --- Within grip: catch any slide and steer back to the line with spare grip ---
      const spare = Math.max(0, latCap - Math.abs(aLatDemand));
      this.yaw += (0 - this.yaw) * Math.min(1, dt * 2.5);
      const want = -(DRIVER_OMEGA * DRIVER_OMEGA * this.d) - 2 * DRIVER_OMEGA * this.vd;
      this.vd += clamp(want, -spare, spare) * dt;
    }

    // Sliding sideways costs speed
    scrub += Math.abs(this.yaw) * v * 0.35 * dt;

    // --- Lateral position, runoff, barrier ---
    const prevSurface = this.surface;
    this.d += this.vd * dt;
    if (Math.abs(this.d) > BARRIER) {
      this.d = Math.sign(this.d) * BARRIER;
      this.vd = 0;
      scrub += v * 0.5;
      this.events.push({ type: 'wall' });
    }
    const newSurface = this._surfaceAt(this.s, this.d);
    if (newSurface === 'runoff') {
      scrub += (2.5 + 0.004 * v * v) * dt;
      if (prevSurface !== 'runoff') this.events.push({ type: 'offtrack' });
    } else if (prevSurface === 'runoff') {
      this.events.push({ type: 'rejoin' });
    }
    if (newSurface === 'kerb' && prevSurface !== 'kerb') this.events.push({ type: 'kerb' });
    this.surface = newSurface;

    // --- Advance along the line ---
    const along = v * Math.cos(Math.min(Math.abs(this.yaw), Math.PI / 2)) * dt / Math.max(0.2, 1 + p.curvature * this.d);
    this.distance += along;
    const L = this.line.length;
    this.s = ((this.s + along) % L + L) % L;

    return Math.min(scrub, v);
  }

  _startSpin() {
    this.spinTimer = SPIN_TIME;
    this.spinDir = Math.sign(this.yaw) || 1;
    this.events.push({ type: 'spin' });
  }

  _surfaceAt(s, d) {
    const ad = Math.abs(d);
    if (ad <= EDGE) return 'track';
    if (ad <= TRACK_HALF_WIDTH + KERB_WIDTH && this._inKerbZone(s)) return 'kerb';
    if (ad <= TRACK_HALF_WIDTH) return 'track';
    return 'runoff';
  }

  _inKerbZone(s) {
    for (const [a, b] of this.kerbZones) if (s >= a && s <= b) return true;
    return false;
  }

  /** Overall tyre noise 0–1: starts before the limit (a warning), peaks when sliding. */
  get squeal() {
    if (this.surface === 'runoff') return 0;
    const u = Math.max(this.usageF, this.usageR);
    const nearLimit = clamp((u - 0.88) / 0.25, 0, 1);
    return Math.max(nearLimit, this.locked ? 1 : 0, this.wheelspin, this.spinTimer > 0 ? 1 : 0);
  }

  /** True when tyres are actually sliding (leaves skid marks / smoke). */
  get sliding() {
    return this.locked || this.wheelspin > 0.15 || this.spinTimer > 0
      || this.understeer > 0.05 || this.oversteer > 0.05;
  }

  /** World pose of the car: position, body heading. */
  pose() {
    const p = sampleLine(this.line, this.s);
    return {
      x: p.x + p.nx * this.d,
      y: p.y + p.ny * this.d,
      heading: p.heading - this.yaw - Math.atan2(this.vd, Math.max(5, this.v)),
      lineHeading: p.heading,
    };
  }
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
