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
  abs: true,          // ABS + EBD: never locks, splits braking by dynamic axle load
  tc: false,          // traction + stability control: cuts power, damps oversteer, no spins
};

const SURFACE_GRIP = { track: 1, kerb: 0.9, runoff: 0.5 };
const LOCKED_SLIDE_MU = 0.8;      // sliding rubber grips less than peak
const ABS_EFFICIENCY = 0.96;
const SPIN_YAW = 0.85;            // rad of slip angle that becomes a spin
const BRAKE_HEADROOM = 1.15;      // brakes out-muscle the tyres: ABS, not the caliper, sets the limit
const ESC_MAX_YAW = 0.25;
// Once the rear lets go, the fronts' unopposed side force spins the body up: yaw accelerates
const YAW_ACCEL_PER_DEFICIT = 1.0; // rad/s² per m/s² of missing rear grip
const TC_TARGET = 0.95;           // traction control keeps driven-axle usage at this
// Slide amount = missing cornering / asked-for cornering. Near-straight, "asked-for" is ~0,
// so a tiny deficit would read as a full slide — normalise by at least this (m/s²)
const SLIDE_NORM_FLOOR = 3;         // rad — stability control never lets a slide grow past this
const SPIN_TIME = 1.3;            // s
const SPIN_DECEL = 7;             // m/s² while spinning
const DRIVER_OMEGA = 1.1;         // rad/s — how firmly the "driver" pulls back to the line
const EDGE = TRACK_HALF_WIDTH - 0.9;
const BARRIER = TRACK_HALF_WIDTH + KERB_WIDTH + RUNOFF_WIDTH;
const ACCEL_FILTER_S = 0.12;
const WALL_BOUNCE = 3;            // m/s back toward the track after a barrier hit
const RUNOFF_DRAG = 4;            // m/s² in the gravel, plus…
const RUNOFF_DRAG_V2 = 0.008;     // …per (m/s)²
const RUNOFF_LATERAL_DAMP = 1.5;  // 1/s — sideways speed lost digging into gravel

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
    this.yawRate = 0;
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
    // Real brakes can always lock a tyre: full pedal reaches the grip limit even on a sticky car
    maxDecel = Math.max(maxDecel, BRAKE_HEADROOM * this.c.mu * (G + this.c.downforce * this.v * this.v));
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
    if (!this.c.abs) return availF / brakeBias;
    // EBD: braking follows load, so the rear contributes what it can after cornering
    const latR = Math.abs(this.aLat) * (1 - fs);
    const capR = grip * (1 - front) * gEff;
    const availR = Math.sqrt(Math.max(0, capR * capR - latR * latR));
    return availF + availR;
  }

  /**
   * Advance one frame. Call after drivetrain.update().
   * @param {number} dt
   * @param {{ speedMS: number, throttle: number, brake: number, clutchSlipping?: boolean }} input
   * @returns {number} speed to scrub from the drivetrain (m/s)
   */
  update(dt, { speedMS, throttle = 0, brake = 0, clutchSlipping = false }) {
    this.events.length = 0;
    if (!(dt > 0)) return 0;
    const c = this.c;
    const v = Math.max(0, speedMS);
    this.v = v;

    // Longitudinal accel from the drivetrain's result (filtered: it drives weight transfer)
    if (!this._primed) { this._prevV = v; this._primed = true; }
    const rawA = (v - this._prevV) / dt;
    this._prevV = v;
    // Clutch-engagement jolts are drivetrain compliance, not tyre load: hold the filter
    if (!clutchSlipping) this.aLong += (rawA - this.aLong) * Math.min(1, dt / ACCEL_FILTER_S);

    const p = sampleLine(this.line, this.s);
    // Curvature at the car's offset: outside of a corner is a bigger radius
    const kEff = p.curvature / Math.max(0.2, 1 + p.curvature * this.d);
    const turnSign = Math.sign(kEff);
    const aLatDemand = v * v * kEff;
    this.aLat = aLatDemand;

    // --- Loads and capacities ---
    this.surface = this._surfaceAt(this.s, p.offset + this.d);
    const grip = c.mu * SURFACE_GRIP[this.surface];
    const gEff = G + c.downforce * v * v;
    const fs = c.frontWeight;
    this.front = clamp(fs - c.cgHeight * this.aLong / G, 0.15, 0.85);
    const capF = grip * c.frontGrip * this.front * gEff;
    const capR = grip * (1 - this.front) * gEff;

    // --- Longitudinal demand per axle ---
    let longF = 0, longR = 0;
    if (this.aLong < 0 && brake > 0) {
      // ABS/EBD share braking by dynamic load; older cars have a fixed bias (rear can lock)
      const bias = c.abs ? this.front : c.brakeBias;
      longF = -this.aLong * bias;
      longR = -this.aLong * (1 - bias);
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
    // A slipping clutch is the shock absorber during a shift — its jolt isn't tyre demand
    if (!clutchSlipping && this.aLong > tractionAvail && throttle > 0.05 && v > 1) {
      const excess = this.aLong - tractionAvail;
      if (c.tc) {
        // TC holds the driven tyres just under the friction-circle limit, leaving cornering grip
        const tcAvail = Math.sqrt(Math.max(0, (TC_TARGET * drivenCap) ** 2 - drivenLat * drivenLat));
        this.tcActive = true;
        scrub += (this.aLong - tcAvail) * dt;
        if (c.drive === 'fwd') longF = tcAvail; else longR = tcAvail;
      } else {
        this.wheelspin = Math.min(1, excess / Math.max(1, tractionAvail));
        scrub += excess * 0.85 * dt;
        // Spinning tyres use most of their grip going nowhere: little left for cornering
        const used = drivenCap * Math.min(0.97, 0.75 + 0.25 * this.wheelspin);
        if (c.drive === 'fwd') longF = used; else longR = used;
      }
    }
    // Mid-shift the slipping clutch is the weak link: the tyres never see more drive than they hold
    if (clutchSlipping && this.aLong > 0) {
      if (c.drive === 'fwd') longF = Math.min(longF, tractionAvail); else longR = Math.min(longR, tractionAvail);
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
        this.yawRate = 0;
        this.vd = 0;
        this.events.push({ type: 'recovered' });
      }
    } else if (Math.abs(aLatDemand) > latCap && v > 3) {
      // --- Over the limit ---
      const deficit = Math.abs(aLatDemand) - latCap;
      // The rear can only step out while the fronts still grip enough to rotate the car.
      // Way too fast, both axles are gone: the fronts wash out first (understeer).
      if (latCapF <= latCapR || Math.abs(aLatDemand) > latCapF) {
        // Understeer: front washes out, car drifts to the outside
        this.understeer = Math.min(1, deficit / Math.max(Math.abs(aLatDemand), SLIDE_NORM_FLOOR));
        this.vd += turnSign * deficit * dt;
        this.yaw += (0 - this.yaw) * Math.min(1, dt * 3);
        this.yawRate = 0;
        scrub += 0.3 * deficit * dt;
      } else {
        // Oversteer: rear steps out, nose rotates into the corner. The path is still grip-limited,
        // so the car slides wide by the full deficit — pointing the nose in doesn't add grip
        this.oversteer = Math.min(1, deficit / Math.max(Math.abs(aLatDemand), SLIDE_NORM_FLOOR));
        // Stability control brakes single wheels to kill yaw: slides stay small, never spin
        const yawGain = c.tc ? 0.35 : 1;
        this.yawRate += -turnSign * deficit * YAW_ACCEL_PER_DEFICIT * yawGain * dt;
        this.yaw += this.yawRate * dt;
        this.vd += turnSign * deficit * dt;
        scrub += (c.tc ? 0.4 : 0.25) * deficit * dt;
        if (c.tc && Math.abs(this.yaw) >= ESC_MAX_YAW) {
          this.yaw = clamp(this.yaw, -ESC_MAX_YAW, ESC_MAX_YAW);
          this.yawRate = 0;
        }
        else if (Math.abs(this.yaw) > SPIN_YAW) this._startSpin();
      }
    } else {
      // --- Within grip: catch any slide and steer back to the line with spare grip ---
      const spare = Math.max(0, latCap - Math.abs(aLatDemand));
      // Grip is back: the slide stops growing and the car straightens up
      this.yawRate *= Math.exp(-dt * 8);
      this.yaw += this.yawRate * dt;
      this.yaw += (0 - this.yaw) * Math.min(1, dt * 2.5);
      const want = -(DRIVER_OMEGA * DRIVER_OMEGA * this.d) - 2 * DRIVER_OMEGA * this.vd;
      this.vd += clamp(want, -spare, spare) * dt;
    }

    // Sliding sideways costs speed
    scrub += Math.abs(this.yaw) * v * 0.35 * dt;

    // --- Lateral position, runoff, barrier (edges are measured from the centerline) ---
    const prevSurface = this.surface;
    this.d += this.vd * dt;
    const fromCenter = p.offset + this.d;
    if (Math.abs(fromCenter) > BARRIER) {
      // Glancing hit on the tyre wall: bounce back toward the track, lose a big chunk of speed
      const side = Math.sign(fromCenter);
      this.d = side * BARRIER - p.offset;
      this.vd = -side * WALL_BOUNCE;
      this.yaw *= 0.3;
      this.yawRate = 0;
      scrub += v * 0.4;
      this.events.push({ type: 'wall' });
    }
    const newSurface = this._surfaceAt(this.s, p.offset + this.d);
    if (newSurface === 'runoff') {
      // Gravel digs in: heavy drag and sideways momentum bleeds off, so traps actually trap
      scrub += (RUNOFF_DRAG + RUNOFF_DRAG_V2 * v * v) * dt;
      // only outward: driving back to the track isn't dug in
      if (Math.sign(this.vd) === Math.sign(p.offset + this.d)) this.vd *= Math.exp(-dt * RUNOFF_LATERAL_DAMP);
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

  /** @param {number} fromCenter - lateral position relative to the track centerline */
  _surfaceAt(s, fromCenter) {
    const ad = Math.abs(fromCenter);
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
