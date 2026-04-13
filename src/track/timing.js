/**
 * Lap timing and corner grading — the feedback half of the game.
 *
 * LapTimer: laps, 3 sectors (purple = best ever, green = faster than last lap,
 * yellow = slower), live delta and ghost position from the PB lap's (s, t) trace.
 * CornerGrader: grades every corner on exit from min speed vs the car's limit.
 */

const TRACE_STEP_M = 10;

export class LapTimer {
  /**
   * @param {{ length: number, sectorEnds: number[], record?: object }} opts
   *   record: previously saved { bestLap, bestSectors, pbTrace, topSpeed }
   */
  constructor({ length, sectorEnds, record = null }) {
    this.length = length;
    this.sectorEnds = sectorEnds;           // s where sector 1 and 2 end
    this.running = false;
    this.t = 0;                             // current lap time
    this.lapNumber = 0;
    this.valid = true;
    this.sector = 0;
    this.sectorStart = 0;
    this.currentSectors = [];
    this.lastSectors = [];
    this.lastLap = null;
    this.bestLap = record?.bestLap ?? null;
    this.bestSectors = record?.bestSectors ?? [null, null, null];
    this.pbTrace = record?.pbTrace ?? null; // Float32Array-like [s0, t0, s1, t1, ...]
    this.topSpeed = record?.topSpeed ?? 0;
    this.laps = [];
    this._trace = [];
    this._lastTraceS = -Infinity;
    this._prevS = null;
  }

  /**
   * @param {number} dt
   * @param {number} s - wrapped arc length along the line
   * @returns {object[]} events: sector / lap
   */
  tick(dt, s) {
    const events = [];
    const prev = this._prevS;
    this._prevS = s;
    if (this.running) this.t += dt;
    if (prev === null) return events;

    const crossedLine = prev > this.length * 0.75 && s < this.length * 0.25;
    if (crossedLine) {
      if (this.running) events.push(this._finishLap());
      this._startLap();
      return events;
    }
    if (!this.running) return events;

    // Sector boundaries
    if (this.sector < 2 && prev < this.sectorEnds[this.sector] && s >= this.sectorEnds[this.sector]) {
      events.push(this._finishSector(this.sector));
      this.sector++;
    }

    if (s - this._lastTraceS >= TRACE_STEP_M) {
      this._trace.push(s, this.t);
      this._lastTraceS = s;
    }
    return events;
  }

  _startLap() {
    this.running = true;
    this.t = 0;
    this.valid = true;
    this.sector = 0;
    this.sectorStart = 0;
    this.currentSectors = [];
    this._trace = [0, 0];
    this._lastTraceS = 0;
    this.lapNumber++;
  }

  _finishSector(i) {
    const time = this.t - this.sectorStart;
    this.sectorStart = this.t;
    this.currentSectors[i] = time;
    const best = this.bestSectors[i];
    const last = this.lastSectors[i];
    let color = 'yellow';
    if (this.valid && (best === null || time < best)) {
      color = 'purple';
      this.bestSectors[i] = time;
    } else if (last == null || time < last) {
      color = 'green';
    }
    return { type: 'sector', index: i, time, color, delta: best === null ? null : time - best };
  }

  _finishLap() {
    const sectorEvt = this._finishSector(2);
    const time = this.t;
    this._trace.push(this.length, time);
    const prevBest = this.bestLap;
    const isPB = this.valid && (prevBest === null || time < prevBest);
    if (isPB) {
      this.bestLap = time;
      this.pbTrace = Float32Array.from(this._trace);
    }
    this.lastLap = time;
    this.lastSectors = this.currentSectors.slice();
    const lap = { number: this.lapNumber, time, valid: this.valid, pb: isPB,
      delta: prevBest === null ? null : time - prevBest, sectors: this.lastSectors, sectorColor: sectorEvt.color };
    this.laps.push(lap);
    return { type: 'lap', ...lap, lastSector: sectorEvt };
  }

  /** Track limits / spin into the gravel: this lap can't be a PB. */
  invalidate() {
    if (this.running && this.valid) {
      this.valid = false;
      return true;
    }
    return false;
  }

  /** Live gap to the PB at this point of the lap (s): negative = ahead. */
  delta(s) {
    if (!this.running || !this.pbTrace) return null;
    const pbT = interpTrace(this.pbTrace, s, 0, 1);
    return pbT === null ? null : this.t - pbT;
  }

  /** Where the PB lap was at the current lap time (for the ghost car). */
  ghostS() {
    if (!this.running || !this.pbTrace) return null;
    return interpTrace(this.pbTrace, this.t, 1, 0);
  }

  toRecord() {
    return {
      bestLap: this.bestLap,
      bestSectors: this.bestSectors,
      pbTrace: this.pbTrace ? Array.from(this.pbTrace) : null,
      topSpeed: this.topSpeed,
    };
  }
}

/** Linear interpolation on an interleaved monotonic trace [a0, b0, a1, b1, ...]. */
function interpTrace(trace, key, keyOff, valOff) {
  const n = trace.length / 2;
  if (n < 2) return null;
  if (key <= trace[keyOff]) return trace[valOff];
  let lo = 0, hi = n - 1;
  if (key >= trace[hi * 2 + keyOff]) return trace[hi * 2 + valOff];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trace[mid * 2 + keyOff] <= key) lo = mid; else hi = mid;
  }
  const k0 = trace[lo * 2 + keyOff], k1 = trace[hi * 2 + keyOff];
  const v0 = trace[lo * 2 + valOff], v1 = trace[hi * 2 + valOff];
  return v0 + (v1 - v0) * ((key - k0) / Math.max(1e-9, k1 - k0));
}

// --- Corner grading ---

export const GRADES = {
  PERFECT:  { label: 'PERFECT',   tone: 'perfect', streak: true },
  FLAT:     { label: 'FLAT OUT',  tone: 'perfect', streak: true },
  GREAT:    { label: 'GREAT',     tone: 'great',   streak: true },
  GOOD:     { label: 'GOOD',      tone: 'good',    streak: null },
  SAFE:     { label: 'SAFE',      tone: 'meh',     streak: false },
  LIFTED:   { label: 'LIFTED',    tone: 'meh',     streak: false },
  HOT:      { label: 'TOO HOT',   tone: 'warn',    streak: false },
  SPIN:     { label: 'SPIN',      tone: 'bad',     streak: false },
  OFF:      { label: 'OFF TRACK', tone: 'bad',     streak: false },
};

const FLAT_OUT_LIMIT = 70;   // m/s — corners faster than this are about commitment, not braking
const APPROACH_M = 450;      // braking zone searched before a corner's entry

export class CornerGrader {
  /**
   * @param {object[]} corners - [{ name, sEntry, sApex, sExit, vLimit }] in line s
   * @param {number} length - line length
   */
  constructor(corners, length) {
    this.corners = corners;
    this.length = length;
    this.streak = 0;
    this.bestStreak = 0;
    this.lastGrades = {};          // name → grade event (persistent badge)
    this.brakePoints = {};         // name → s where braking started this lap
    this.lastLapBrakePoints = {};
    this._active = null;
    this._brakingPrev = false;
  }

  /**
   * @param {number} s - wrapped line s
   * @param {object} car - { v, brake, throttle, surface, spinning, sliding, locked, slide }
   * @returns {object|null} grade event when a corner completes
   */
  tick(s, car) {
    // Brake-point capture in each corner's approach
    const braking = car.brake > 0.2;
    if (braking && !this._brakingPrev) {
      const c = this._approaching(s);
      if (c && this.brakePoints[c.name] === undefined) this.brakePoints[c.name] = s;
    }
    this._brakingPrev = braking;

    if (!this._active) {
      const c = this.corners.find(c => inWindow(s, c.sEntry, c.sExit, this.length));
      if (c) this._active = { c, vEntry: car.v, vMin: car.v, slide: 0, off: false, spin: false,
        braked: false, throttleSum: 0, samples: 0 };
      return null;
    }

    const a = this._active;
    if (inWindow(s, a.c.sEntry, a.c.sExit, this.length)) {
      a.vMin = Math.min(a.vMin, car.v);
      a.slide = Math.max(a.slide, car.slide);
      a.off ||= car.surface === 'runoff';
      a.spin ||= car.spinning;
      a.braked ||= car.brake > 0.1;
      a.throttleSum += car.throttle;
      a.samples++;
      return null;
    }
    this._active = null;
    return this._grade(a);
  }

  _approaching(s) {
    return this.corners.find(c => inWindow(s, c.sEntry - APPROACH_M, c.sEntry, this.length));
  }

  _grade(a) {
    const { c } = a;
    const ratio = Math.min(1, a.vMin / c.vLimit);
    let g;
    if (a.off) g = GRADES.OFF;
    else if (a.spin) g = GRADES.SPIN;
    else if (a.slide > 0.35) g = GRADES.HOT;
    else if (c.vLimit >= FLAT_OUT_LIMIT) {
      g = !a.braked && a.throttleSum / Math.max(1, a.samples) > 0.85 ? GRADES.FLAT : GRADES.LIFTED;
    }
    else if (ratio >= 0.97) g = GRADES.PERFECT;
    else if (ratio >= 0.92) g = GRADES.GREAT;
    else if (ratio >= 0.85) g = GRADES.GOOD;
    else g = GRADES.SAFE;

    if (g.streak === true) this.streak++;
    else if (g.streak === false) this.streak = 0;
    this.bestStreak = Math.max(this.bestStreak, this.streak);

    const evt = { type: 'corner', name: c.name, grade: g.label, tone: g.tone, s: c.sApex,
      vEntry: a.vEntry, vMin: a.vMin, vLimit: c.vLimit, ratio, streak: this.streak,
      brakeS: this.brakePoints[c.name] ?? null };
    this.lastGrades[c.name] = evt;
    return evt;
  }

  /** Call at the line: this lap's brake points become "last lap" markers. */
  lapDone() {
    this.lastLapBrakePoints = this.brakePoints;
    this.brakePoints = {};
  }
}

/** s within [a, b] on a loop of length L (handles windows crossing the line). */
export function inWindow(s, a, b, L) {
  a = ((a % L) + L) % L;
  b = ((b % L) + L) % L;
  return a <= b ? s >= a && s <= b : s >= a || s <= b;
}
