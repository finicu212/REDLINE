/**
 * RaceSession — one car, one track, a time attack. Owns the order of each frame:
 *   tyres limit the brakes → drivetrain → tyres limit traction/cornering → timing/grading
 * and keeps the persistent "marks" the player leaves: skid marks, the grip trail,
 * brake points, corner grades. The renderer and HUD only read from here.
 */

import { buildTrack, TRACK_HALF_WIDTH } from './geometry.js';
import { buildRacingLine, cornerSpeedLimit, indexAt, sampleLine } from './racingLine.js';
import { CarDynamics } from './dynamics.js';
import { LapTimer, CornerGrader } from './timing.js';
import { loadRecord, saveRecord } from './storage.js';

const GRID_BEHIND_LINE = 80;     // m — standing start, clock starts at the line
const SKID_CAPACITY = 24000;     // segments kept for the session (ring buffer)
const TRAIL_STEP = 4;            // m between grip-trail samples
const SPEEDTRAP_BEFORE = 420;    // m before Rettifilo's entry — ahead of any sane braking point
const FEED_TTL = 6;              // s a feed event stays readable
const COACH_GAP_S = 6;           // min time between any two coaching tips
const COACH_REPEAT_S = 30;       // min time before the same tip repeats

/**
 * Mistakes the car can tell apart, with the one line that explains them.
 * `when` sees the car and the pedals; `hold` = seconds the condition must persist.
 */
export const COACH_TIPS = [
  { id: 'lock', hold: 0.15, title: 'LOCK-UP', text: 'locked fronts can\'t steer — ease off the brake',
    when: (c) => c.locked },
  { id: 'entry', hold: 0.2, title: 'TOO FAST IN', text: 'brake earlier, turn in while easing off',
    when: (c, thr, brk) => c.understeer > 0.3 && brk > 0.2 },
  { id: 'powerUnder', hold: 0.25, title: 'POWER UNDERSTEER', text: 'wait for the exit before full throttle',
    when: (c, thr) => c.understeer > 0.3 && thr > 0.5 && c.aLong > 0 },
  { id: 'liftOver', hold: 0.15, title: 'LIFT-OFF OVERSTEER', text: 'weight jumped forward, the rear went light',
    when: (c, thr) => c.oversteer > 0.25 && thr < 0.2 },
  { id: 'powerOver', hold: 0.15, title: 'POWER OVERSTEER', text: 'squeeze the throttle, don\'t stab it',
    when: (c, thr) => c.oversteer > 0.25 && thr > 0.5 },
  { id: 'wheelspin', hold: 0.3, title: 'WHEELSPIN', text: 'short-shift or feed the throttle in',
    when: (c) => c.wheelspin > 0.4 },
];

let cached = null;
/** Track + racing line are expensive (~0.5 s) and identical for every car: build once. */
export function getMonza() {
  if (!cached) {
    const track = buildTrack();
    const line = buildRacingLine(track);
    cached = { track, line };
  }
  return cached;
}

export class RaceSession {
  /**
   * @param {object} profile - engine profile (uses id, chassis)
   * @param {object} [opts] - { record } to inject a record instead of localStorage (tests)
   */
  constructor(profile, opts = {}) {
    const { track, line } = getMonza();
    this.track = track;
    this.line = line;
    this.profile = profile;
    this.carId = profile?.id ?? 'default';
    const chassis = profile?.chassis ?? {};

    this.corners = this._buildCorners(chassis);
    const kerbZones = this.corners.map(c => [c.sEntry - 25, c.sExit + 25]);
    this.car = new CarDynamics(line, chassis, { startS: line.length - GRID_BEHIND_LINE, kerbZones });

    const roggia = this.corners.find(c => c.name === 'Roggia');
    const ascari = this.corners.find(c => c.name === 'Ascari');
    this.sectorEnds = [roggia.sEntry - 250, ascari.sExit + 150];

    const record = opts.record !== undefined ? opts.record : loadRecord(this.carId);
    this._persist = opts.record === undefined;
    this.timer = new LapTimer({ length: line.length, sectorEnds: this.sectorEnds, record });
    this.grader = new CornerGrader(this.corners, line.length);
    this.pbBrakePoints = record?.pbBrakePoints ?? {};
    this.bestTopSpeed = record?.topSpeed ?? 0;

    const rettifilo = this.corners.find(c => c.name === 'Rettifilo');
    this.speedTrapS = rettifilo.sEntry - SPEEDTRAP_BEFORE;
    this.lapTopSpeed = 0;

    // Persistent marks
    this.skids = new Float32Array(SKID_CAPACITY * 5); // x1, y1, x2, y2, intensity
    this.skidCount = 0;
    this.skidHead = 0;
    this._lastSkid = null;
    this.trail = [];          // current lap: [x, y, usage, ...]
    this.lastTrail = [];
    this._trailS = null;

    this.feed = [];           // { t, ...event } — HUD/renderer read, TTL-pruned
    this._lapGrades = [];
    this._seq = 0;
    this._coachHeld = {};
    this._coachLast = {};
    this._coachAny = -Infinity;
    this.time = 0;
    this.brake = 0;
    this.throttle = 0;
  }

  _buildCorners(chassis) {
    const { track, line } = this;
    const mu = (chassis.mu ?? 1) * Math.min(1, chassis.frontGrip ?? 0.96);
    const df = chassis.downforce ?? 0;
    const ds = track.length / track.points.length;
    const lineS = cs => line.s[Math.min(line.n - 1, Math.round(cs / ds))];
    return track.corners.map(c => {
      const sEntry = lineS(c.s) - 10;
      const sExit = lineS(c.sEnd) + 10;
      let maxK = 0, sApex = sEntry;
      const i0 = indexAt(line, sEntry), i1 = indexAt(line, sExit);
      for (let i = i0; i !== i1; i = (i + 1) % line.n) {
        const k = Math.abs(line.curvature[i]);
        if (k > maxK) { maxK = k; sApex = line.s[i]; }
      }
      return { name: c.name, sEntry, sExit, sApex, vLimit: cornerSpeedLimit(maxK, mu, df), maxK };
    });
  }

  /**
   * One frame. Runs the drivetrain too, so braking can be grip-limited first.
   * @param {number} dt
   * @param {import('../engine/drivetrain.js').Drivetrain} drivetrain
   * @param {{ throttle: number, brake: number }} input - brake pedal 0–1
   */
  step(dt, drivetrain, { throttle, brake }) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.throttle = throttle;
    this.brake = brake;
    const car = this.car;

    // Always consult the tyres: releasing the pedal is what unlocks a locked wheel
    const brakeDecel = car.brakeDecelFor(brake, drivetrain.brakeDecel);
    drivetrain.update(dt, throttle, brake > 0 ? brake : false, brake > 0 ? brakeDecel : undefined);

    const scrub = car.update(dt, { speedMS: drivetrain.speed / 3.6, throttle, brake,
      clutchSlipping: drivetrain.isClutchSlipping });
    drivetrain.scrubSpeed(scrub);

    for (const e of car.events) {
      if (e.type === 'offtrack' && this.timer.invalidate()) {
        this._emit({ type: 'invalid', reason: car.spinTimer > 0 ? 'SPIN' : 'TRACK LIMITS' });
      }
      this._emit({ ...e, s: car.s });
    }

    const prevS = this.timer._prevS;
    for (const e of this.timer.tick(dt, car.s)) this._onTiming(e);
    this._speedTrap(prevS, car.s, drivetrain.speed);

    const grade = this.grader.tick(car.s, {
      v: car.v, brake, throttle, surface: car.surface, spinning: car.spinTimer > 0,
      slide: Math.max(car.understeer, car.oversteer, car.locked ? 0.5 : 0, car.wheelspin * 0.5),
    });
    if (grade) {
      const pbBrake = this.pbBrakePoints[grade.name];
      // + = braked later (deeper) than on the PB lap
      grade.brakeVsPB = grade.brakeS != null && pbBrake != null ? grade.brakeS - pbBrake : null;
      this._lapGrades.push(grade.tone);
      this._emit(grade);
    }

    this._coach(dt);
    this._marks();
    this._prune();
  }

  /** Name the mistake the moment it happens — the game noticed, and says why. */
  _coach(dt) {
    const c = this.car;
    for (const tip of COACH_TIPS) {
      const on = c.surface !== 'runoff' && c.v > 5 && tip.when(c, this.throttle, this.brake);
      this._coachHeld[tip.id] = on ? (this._coachHeld[tip.id] || 0) + dt : 0;
      if (this._coachHeld[tip.id] < tip.hold) continue;
      if (this.time - this._coachAny < COACH_GAP_S) continue;
      if (this.time - (this._coachLast[tip.id] ?? -Infinity) < COACH_REPEAT_S) continue;
      this._coachAny = this.time;
      this._coachLast[tip.id] = this.time;
      this._emit({ type: 'coach', id: tip.id, title: tip.title, text: tip.text });
      break;
    }
  }

  _onTiming(e) {
    // A purple sector improves the ideal lap even when the lap isn't a PB — keep it
    const purple = e.type === 'sector' ? e.color === 'purple' : e.lastSector?.color === 'purple';
    if (purple && this._persist) saveRecord(this.carId, this.record());
    if (e.type === 'lap') {
      if (e.pb) this.pbBrakePoints = { ...this.grader.brakePoints };
      this.grader.lapDone();
      this.lastTrail = this.trail;
      this.trail = [];
      e.topSpeed = this.lapTopSpeed;
      this.lapTopSpeed = 0;
      e.grades = countBy(this._lapGrades);
      this._lapGrades = [];
      if (e.pb && this._persist) saveRecord(this.carId, this.record());
    }
    this._emit(e);
  }

  _speedTrap(prevS, s, kmh) {
    this.lapTopSpeed = Math.max(this.lapTopSpeed, kmh);
    if (prevS === null || !(prevS < this.speedTrapS && s >= this.speedTrapS)) return;
    const record = kmh > this.bestTopSpeed;
    if (record) {
      this.bestTopSpeed = kmh;
      this.timer.topSpeed = kmh;
      if (this._persist) saveRecord(this.carId, this.record());
    }
    this._emit({ type: 'speedtrap', kmh, record });
  }

  /** Skid marks where tyres slide on asphalt; grip trail every few meters. */
  _marks() {
    const car = this.car;
    const pose = car.pose();
    const onTarmac = car.surface !== 'runoff';
    const intensity = car.locked ? 1 : Math.min(1, Math.max(car.wheelspin, car.understeer * 1.5, car.oversteer * 2,
      car.spinTimer > 0 ? 1 : 0));
    if (car.sliding && onTarmac && intensity > 0.08) {
      const hx = Math.cos(pose.heading) * 0.8, hy = -Math.sin(pose.heading) * 0.8; // right of car
      const pts = [[pose.x + hx, pose.y + hy], [pose.x - hx, pose.y - hy]];
      if (this._lastSkid) {
        for (let w = 0; w < 2; w++) this._pushSkid(this._lastSkid[w][0], this._lastSkid[w][1], pts[w][0], pts[w][1], intensity);
      }
      this._lastSkid = pts;
    } else {
      this._lastSkid = null;
    }

    if (this.timer.running && (this._trailS === null || Math.abs(car.s - this._trailS) >= TRAIL_STEP)) {
      this._trailS = car.s;
      this.trail.push(pose.x, pose.y, Math.max(car.usageF, car.usageR));
    }
  }

  _pushSkid(x1, y1, x2, y2, a) {
    if (Math.hypot(x2 - x1, y2 - y1) > 8) return; // teleports (spin reset) don't draw
    const o = this.skidHead * 5;
    this.skids[o] = x1; this.skids[o + 1] = y1; this.skids[o + 2] = x2; this.skids[o + 3] = y2; this.skids[o + 4] = a;
    this.skidHead = (this.skidHead + 1) % SKID_CAPACITY;
    this.skidCount = Math.min(SKID_CAPACITY, this.skidCount + 1);
  }

  _emit(e) {
    // seq, not t, identifies an event: one frame can emit several (offtrack + invalid)
    this.feed.push({ t: this.time, seq: ++this._seq, ...e });
  }

  _prune() {
    let i = 0;
    while (i < this.feed.length && this.time - this.feed[i].t > FEED_TTL) i++;
    if (i) this.feed.splice(0, i);
  }

  /** Back to the grid for a fresh attempt. PBs, skid marks and grades stay — they're earned. */
  /** Sum of best sectors: the lap you've proven you can do. */
  get idealLap() {
    const b = this.timer.bestSectors;
    return b.every(x => x != null) ? b[0] + b[1] + b[2] : null;
  }

  resetToGrid(drivetrain) {
    drivetrain.stop();
    this.car.reset(this.line.length - GRID_BEHIND_LINE);
    this.timer.running = false;
    this.timer._prevS = null;
    this.timer.t = 0;
    this.timer.valid = true;
    this.lapTopSpeed = 0;
    this.trail = [];
    this._trailS = null;
    this._lastSkid = null;
    this.grader._active = null;
    this.grader.brakePoints = {};
    this._lapGrades = [];
    this._emit({ type: 'reset' });
  }

  /** Ghost of the PB lap: world pose or null. */
  ghostPose() {
    const s = this.timer.ghostS();
    if (s === null) return null;
    const p = sampleLine(this.line, s);
    return { x: p.x, y: p.y, heading: p.heading };
  }

  /** World position of a line s (for markers/labels), optionally pushed sideways. */
  worldAt(s, side = 0) {
    const p = sampleLine(this.line, s);
    return { x: p.x + p.nx * side, y: p.y + p.ny * side, heading: p.heading, nx: p.nx, ny: p.ny };
  }

  record() {
    return { ...this.timer.toRecord(), topSpeed: this.bestTopSpeed, pbBrakePoints: this.pbBrakePoints };
  }

  get halfWidth() {
    return TRACK_HALF_WIDTH;
  }
}

function countBy(arr) {
  const out = {};
  for (const k of arr) out[k] = (out[k] || 0) + 1;
  return out;
}
