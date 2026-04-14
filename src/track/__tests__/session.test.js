import { describe, it, expect } from 'vitest';
import { Drivetrain } from '../../engine/drivetrain.js';
import { PROFILE_LIST, PROFILES } from '../../engine/profiles.js';
import { RaceSession } from '../session.js';
import { Autopilot } from '../autopilot.js';

/** Run the autopilot until `laps` laps complete (or a time cap). */
function race(profile, { laps = 2, margin = 0.93, record = null } = {}) {
  const dt = new Drivetrain(profile);
  const session = new RaceSession(profile, { record });
  const ap = new Autopilot(session, profile, { margin });
  const done = [], counts = {}, corners = [];
  for (let t = 0; t < 420 && done.length < laps; t += 1 / 60) {
    session.step(1 / 60, dt, ap.drive(dt));
    for (const e of session.feed) if (e.t === session.time) {
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (e.type === 'lap') done.push(e);
      if (e.type === 'corner') corners.push(e);
    }
  }
  return { session, laps: done, counts, dt, corners };
}

describe('RaceSession — every car laps Monza cleanly with a sane driver', () => {
  // Bounds are loose on purpose: they catch broken physics, not tuning drift
  const bounds = {
    i4_na: [95, 135], i4_3: [140, 200], v6_1: [110, 150], v6_2: [135, 185],
    v8_1: [100, 140], v8_2: [120, 165], v8_3: [100, 135],
  };
  for (const p of PROFILE_LIST) {
    it(`${p.name}: 2 valid laps, no spins, plausible time`, () => {
      const { laps, counts } = race(p);
      expect(laps).toHaveLength(2);
      expect(laps.every(l => l.valid)).toBe(true);
      expect(counts.spin ?? 0).toBe(0);
      expect(counts.wall ?? 0).toBe(0);
      const [lo, hi] = bounds[p.id];
      expect(laps[1].time).toBeGreaterThan(lo);
      expect(laps[1].time).toBeLessThan(hi);
    }, 30000);
  }
});

describe('RaceSession — feedback plumbing', () => {
  const { session, laps, counts, corners } = race(PROFILES.v8_3, { laps: 2 });

  it('grades all seven corners every lap and fires sectors + speed trap', () => {
    expect(counts.corner).toBe(14);
    expect(counts.sector).toBe(4);
    expect(counts.speedtrap).toBe(2);
    expect(Object.keys(session.grader.lastGrades)).toHaveLength(7);
  });

  it('second lap is a PB with a ghost and a live delta', () => {
    expect(laps[1].pb).toBe(true);
    expect(session.timer.pbTrace.length).toBeGreaterThan(100);
    expect(session.ghostPose()).not.toBeNull();
    expect(session.timer.delta(session.car.s)).not.toBeNull();
  });

  it('records brake points for braking corners and keeps the PB lap set', () => {
    expect(Object.keys(session.grader.lastLapBrakePoints).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(session.pbBrakePoints).length).toBeGreaterThanOrEqual(5);
  });

  it('paints a grip trail for the last lap', () => {
    expect(session.lastTrail.length / 3).toBeGreaterThan(1000);
    const usage = session.lastTrail.filter((_, i) => i % 3 === 2);
    expect(Math.max(...usage)).toBeGreaterThan(0.7);
  });

  it('lap events summarise the grades; ideal lap = sum of best sectors', () => {
    const counts = laps[1].grades;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(7);
    const b = session.timer.bestSectors;
    expect(session.idealLap).toBeCloseTo(b[0] + b[1] + b[2], 6);
    expect(session.idealLap).toBeLessThanOrEqual(session.timer.bestLap + 1e-6);
  });

  it('second-lap corner grades report braking distance vs the PB lap', () => {
    const lap1 = corners.slice(0, 7), lap2 = corners.slice(7);
    expect(lap1.every(c => c.brakeVsPB == null)).toBe(true);        // no PB yet
    const compared = lap2.filter(c => c.brakeVsPB != null);
    expect(compared.length).toBeGreaterThanOrEqual(5);
    // same driver, same car: brake points repeat within a few meters — except Rettifilo,
    // where lap 1 arrives slower from the standing start and brakes later
    for (const c of compared.filter(c => c.name !== 'Rettifilo')) expect(Math.abs(c.brakeVsPB)).toBeLessThan(25);
  });

  it('record() round-trips into a fresh session', () => {
    const rec = JSON.parse(JSON.stringify(session.record()));
    const again = new RaceSession(PROFILES.v8_3, { record: rec });
    expect(again.timer.bestLap).toBeCloseTo(session.timer.bestLap, 6);
    expect(again.pbBrakePoints).toEqual(session.pbBrakePoints);
  });
});

describe('RaceSession — feed', () => {
  it('events from the same frame get distinct, increasing seq numbers', () => {
    const s = new RaceSession(PROFILES.v8_3, { record: null });
    s._emit({ type: 'offtrack' });
    s._emit({ type: 'invalid' });
    const [a, b] = s.feed;
    expect(a.t).toBe(b.t);
    expect(b.seq).toBe(a.seq + 1);
  });
});

describe('RaceSession — marks and limits', () => {
  it('leaves skid marks when the tyres slide and invalidates the lap off track', () => {
    const p = PROFILES.v8_2;
    const dt = new Drivetrain(p);
    const session = new RaceSession(p, { record: null });
    const ap = new Autopilot(session, p, { margin: 1.25 }); // hopelessly too fast
    const types = new Set();
    for (let t = 0; t < 90; t += 1 / 60) {
      session.step(1 / 60, dt, ap.drive(dt));
      for (const e of session.feed) if (e.t === session.time) types.add(e.type);
    }
    expect(session.skidCount).toBeGreaterThan(50);
    expect(types.has('offtrack') || types.has('spin')).toBe(true);
    expect(types.has('invalid')).toBe(true);
  });

  it('standing start: the clock only starts at the line', () => {
    const p = PROFILES.v6_1;
    const dt = new Drivetrain(p);
    const session = new RaceSession(p, { record: null });
    expect(session.timer.running).toBe(false);
    const ap = new Autopilot(session, p);
    for (let t = 0; t < 8; t += 1 / 60) session.step(1 / 60, dt, ap.drive(dt));
    expect(session.timer.running).toBe(true);
  });
});

describe('RaceSession — review regressions', () => {
  const brakingInCorner = (p) => {
    const dt = new Drivetrain(p);
    const session = new RaceSession(p, { record: null });
    const ap = new Autopilot(session, p);
    // drive until mid-Rettifilo braking zone, then stamp on the brakes
    const target = session.corners[0].sEntry - 20;
    for (let t = 0; t < 60 && !(session.car.s > target && session.car.s < target + 50); t += 1 / 60) {
      session.step(1 / 60, dt, ap.drive(dt));
    }
    return { dt, session };
  };

  it('releasing the brake unlocks a locked wheel (no-ABS car)', () => {
    const p = PROFILES.v6_2;
    const { dt, session } = brakingInCorner(p);
    session.car.aLat = 9; // mid-corner load so full pedal locks
    session.step(1 / 60, dt, { throttle: 0, brake: 1 });
    expect(session.car.locked).toBe(true);
    session.step(1 / 60, dt, { throttle: 0, brake: 0 });
    expect(session.car.locked).toBe(false);
  });

  it('braking with the clutch held still transfers weight forward', () => {
    const p = PROFILES.v8_3;
    const dt = new Drivetrain(p);
    const session = new RaceSession(p, { record: null });
    const ap = new Autopilot(session, p, { margin: 0.9 });
    for (let t = 0; t < 12; t += 1 / 60) session.step(1 / 60, dt, ap.drive(dt));
    dt.clutchHeld = true;
    for (let t = 0; t < 1; t += 1 / 60) session.step(1 / 60, dt, { throttle: 0, brake: 1 });
    expect(session.car.aLong).toBeLessThan(-6);
    expect(session.car.front).toBeGreaterThan(p.chassis.frontWeight + 0.1);
  });

  it('spinning into the gravel is reported as SPIN, not track limits', () => {
    const p = PROFILES.v8_2;
    const dt = new Drivetrain(p);
    const session = new RaceSession(p, { record: null });
    session.timer._startLap();
    session.timer._prevS = session.car.s;
    dt.shiftUp(); dt.speed = 80;
    session.car.spinTimer = 1;
    session.car.vd = 600; // leaves the track within this frame
    session.step(1 / 60, dt, { throttle: 0, brake: 0 });
    const inv = session.feed.find(e => e.type === 'invalid');
    expect(inv?.reason).toBe('SPIN');
  });

  it('reset to grid clears the aborted lap: validity, top speed', () => {
    const p = PROFILES.v8_3;
    const dt = new Drivetrain(p);
    const session = new RaceSession(p, { record: null });
    const ap = new Autopilot(session, p);
    for (let t = 0; t < 20; t += 1 / 60) session.step(1 / 60, dt, ap.drive(dt));
    session.timer.invalidate();
    session.resetToGrid(dt);
    expect(session.timer.valid).toBe(true);
    expect(session.lapTopSpeed).toBe(0);
    expect(dt.speed).toBe(0);
    expect(dt.gear).toBe(0);
  });
});

describe('RaceSession — coach', () => {
  it('names a held mistake once, then respects cooldowns', () => {
    const s = new RaceSession(PROFILES.v8_3, { record: null });
    const car = s.car;
    car.v = 30; car.surface = 'track';
    const tick = () => { s.time += 1 / 60; s.throttle = 0; s.brake = 1; car.locked = true; s._coach(1 / 60); };
    for (let i = 0; i < 20; i++) tick();
    const tips = s.feed.filter(e => e.type === 'coach');
    expect(tips).toHaveLength(1);
    expect(tips[0].id).toBe('lock');
    for (let i = 0; i < 600; i++) tick(); // 10 s later, same mistake: still inside the repeat window
    expect(s.feed.filter(e => e.type === 'coach')).toHaveLength(1);
  });

  it('power understeer is told apart from entry understeer', () => {
    const s = new RaceSession(PROFILES.v8_3, { record: null });
    const car = s.car;
    car.v = 20; car.surface = 'track'; car.understeer = 0.6; car.aLong = 3;
    for (let i = 0; i < 30; i++) { s.time += 1 / 60; s.throttle = 1; s.brake = 0; s._coach(1 / 60); }
    expect(s.feed.find(e => e.type === 'coach')?.id).toBe('powerUnder');
  });
});
