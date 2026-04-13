/**
 * A competent-but-cautious driver: follows a brake-aware speed profile (friction circle,
 * with margin), shifts on RPM. Used by tests to prove every car laps cleanly and to
 * sanity-check lap times.
 */

import { speedProfile, indexAt, G } from './racingLine.js';

const LOOKAHEAD_M = 12;   // react a little early: pedal response isn't instant

export class Autopilot {
  constructor(session, profile, { margin = 0.93 } = {}) {
    this.session = session;
    this.profile = profile;
    const c = session.car.c;
    const mu = c.mu * Math.min(1, c.frontGrip);
    this.target = speedProfile(session.line, { mu, downforce: c.downforce, brakeDecel: profile.brakeDecel * 0.9, margin });
    this.grip = mu * G;
    // Soft limiters hold RPM below redline: shift before the hold band, or never shift at all
    const lim = profile.limiter ?? {};
    this.upshiftRPM = lim.style === 'soft' && lim.softRangeRPM
      ? profile.redlineRPM - lim.softRangeRPM * 0.7
      : profile.redlineRPM * 0.96;
    this._braking = false;
    this._cooldown = 0;
  }

  /** @returns {{ throttle: number, brake: number }} and shifts the drivetrain as needed */
  drive(drivetrain) {
    const { line, car } = this.session;
    const v = drivetrain.speed / 3.6;
    this._shift(drivetrain);
    const ds = line.length / line.n;
    const i = indexAt(line, car.s);
    const target = Math.min(this.target[i], this.target[(i + Math.round(LOOKAHEAD_M / ds)) % line.n]);

    // Hysteresis: keep braking until comfortably under target, so the pedal doesn't chatter
    if (v > target * 1.01) this._braking = true;
    else if (v < target * 0.985) this._braking = false;
    if (this._braking) {
      const over = (v - target) / Math.max(1, target);
      return { throttle: 0, brake: Math.min(1, 0.35 + over * 12) };
    }
    // Friction circle on exit too: feed throttle in as the corner opens, back off on wheelspin
    const grip = this.grip * (1 + car.c.downforce * v * v / G);
    const latFrac = Math.min(1, Math.abs(car.aLat) / grip);
    let throttle = v < target * 0.995 ? 1 : 0.35;
    if (latFrac > 0.75) throttle = Math.min(throttle, Math.max(0.15, (1 - latFrac) * 4));
    if (car.wheelspin > 0.05 || car.oversteer > 0.05) throttle *= 0.5;
    return { throttle, brake: 0 };
  }

  _shift(dt) {
    const p = this.profile;
    this._cooldown = Math.max(0, this._cooldown - 1);
    if (dt.gear === 0) { dt.shiftUp(); return; }
    if (this._cooldown > 0) return;
    const maxGear = p.gearRatios.length - 1;
    if (dt.rpm > this.upshiftRPM && dt.gear < maxGear) { dt.shiftUp(); this._cooldown = 45; return; }
    const low = p.idleRPM + (p.redlineRPM - p.idleRPM) * 0.3;
    if (dt.rpm < low && dt.gear > 1) {
      const ratioDown = p.gearRatios[dt.gear - 1] / p.gearRatios[dt.gear];
      if (dt.rpm * ratioDown < p.redlineRPM * 0.85) { dt.shiftDown(); this._cooldown = 30; }
    }
  }
}

export { G };
