import { describe, it, expect } from 'vitest';
import { LapTimer, CornerGrader, inWindow } from '../timing.js';

const L = 1000;

/** Drive laps at constant speed v (m/s), starting just before the line. */
function drive(timer, { laps = 1, v = 50, dt = 0.05, from = 950, onStep } = {}) {
  let s = from, events = [];
  const total = (L - from) + laps * L + 1;
  for (let d = 0; d < total; d += v * dt) {
    s = (s + v * dt) % L;
    onStep?.(s);
    events.push(...timer.tick(dt, s));
  }
  return events;
}

describe('LapTimer', () => {
  it('starts on the first line crossing and times a lap', () => {
    const t = new LapTimer({ length: L, sectorEnds: [333, 666] });
    const ev = drive(t, { laps: 1, v: 50 });
    const lap = ev.find(e => e.type === 'lap');
    expect(lap.time).toBeCloseTo(20, 0);
    expect(lap.pb).toBe(true);
    expect(ev.filter(e => e.type === 'sector')).toHaveLength(2); // S3 is inside the lap event
  });

  it('first sectors are purple; a slower lap goes yellow, a faster one purple again', () => {
    const t = new LapTimer({ length: L, sectorEnds: [333, 666] });
    drive(t, { laps: 1, v: 50 });
    const slow = drive(t, { laps: 1, v: 40, from: t._prevS });
    expect(slow.find(e => e.type === 'sector').color).toBe('yellow');
    expect(slow.find(e => e.type === 'lap').pb).toBe(false);
    const fast = drive(t, { laps: 1, v: 60, from: t._prevS });
    expect(fast.find(e => e.type === 'sector').color).toBe('purple');
    expect(fast.find(e => e.type === 'lap').pb).toBe(true);
  });

  it('invalid laps never become PBs', () => {
    const t = new LapTimer({ length: L, sectorEnds: [333, 666] });
    drive(t, { laps: 1, v: 40 });
    const ev = drive(t, { laps: 1, v: 80, from: t._prevS, onStep: s => { if (s > 500 && s < 520) t.invalidate(); } });
    const lap = ev.find(e => e.type === 'lap');
    expect(lap.valid).toBe(false);
    expect(lap.pb).toBe(false);
    expect(t.bestLap).toBeCloseTo(25, 0);
  });

  it('live delta vs PB and ghost position', () => {
    const t = new LapTimer({ length: L, sectorEnds: [333, 666] });
    drive(t, { laps: 1, v: 50 });           // PB: 20 s
    // halfway through a slower lap
    let s = t._prevS;
    for (let i = 0; i < 250; i++) { s = (s + 2) % L; t.tick(0.05, s); } // 40 m/s
    expect(t.delta(s)).toBeGreaterThan(0);  // behind
    expect(t.ghostS()).toBeGreaterThan(s);  // ghost is ahead
  });

  it('round-trips through a stored record', () => {
    const t = new LapTimer({ length: L, sectorEnds: [333, 666] });
    drive(t, { laps: 1, v: 50 });
    const rec = JSON.parse(JSON.stringify(t.toRecord()));
    const t2 = new LapTimer({ length: L, sectorEnds: [333, 666], record: rec });
    expect(t2.bestLap).toBeCloseTo(t.bestLap, 6);
    drive(t2, { laps: 0, v: 50 });
    let s = t2._prevS;
    for (let i = 0; i < 100; i++) { s = (s + 2.5) % L; t2.tick(0.05, s); }
    expect(Math.abs(t2.delta(s))).toBeLessThan(0.2);
  });
});

describe('CornerGrader', () => {
  const corners = [{ name: 'T1', sEntry: 400, sApex: 450, sExit: 500, vLimit: 30 }];
  const run = (g, vMin, extra = {}) => {
    let evt = null;
    for (let s = 100; s < 600; s += 1) {
      const inCorner = s >= 400 && s <= 500;
      const car = { v: inCorner ? vMin : 60, brake: s > 300 && s < 400 ? 1 : 0, throttle: inCorner ? 0.5 : 1,
        surface: 'track', spinning: false, slide: 0, ...(inCorner ? extra : {}) };
      evt = g.tick(s, car) || evt;
    }
    return evt;
  };

  it('grades by min speed vs the limit and tracks a streak', () => {
    const g = new CornerGrader(corners, L);
    expect(run(g, 29.5).grade).toBe('PERFECT');
    expect(run(g, 28).grade).toBe('GREAT');
    expect(g.streak).toBe(2);
    expect(run(g, 26).grade).toBe('GOOD');
    expect(g.streak).toBe(2); // GOOD keeps the streak alive
    expect(run(g, 20).grade).toBe('SAFE');
    expect(g.streak).toBe(0);
    expect(g.bestStreak).toBe(2);
  });

  it('sliding, spinning and going off are called out', () => {
    const g = new CornerGrader(corners, L);
    expect(run(g, 29, { slide: 0.6 }).grade).toBe('TOO HOT');
    expect(run(g, 10, { spinning: true }).grade).toBe('SPIN');
    expect(run(g, 25, { surface: 'runoff' }).grade).toBe('OFF TRACK');
  });

  it('records where braking started before the corner, and keeps the last grade', () => {
    const g = new CornerGrader(corners, L);
    const evt = run(g, 29.5);
    expect(evt.brakeS).toBeCloseTo(301, 0);
    expect(g.lastGrades.T1.grade).toBe('PERFECT');
    g.lapDone();
    expect(g.lastLapBrakePoints.T1).toBeCloseTo(301, 0);
  });

  it('flat-out corners reward commitment instead of min speed', () => {
    const fast = [{ name: 'Grande', sEntry: 400, sApex: 450, sExit: 500, vLimit: 90 }];
    const g = new CornerGrader(fast, L);
    let evt = null;
    for (let s = 100; s < 600; s++) evt = g.tick(s, { v: 70, brake: 0, throttle: 1, surface: 'track', slide: 0 }) || evt;
    expect(evt.grade).toBe('FLAT OUT');
  });
});

describe('inWindow', () => {
  it('handles windows across the start line', () => {
    expect(inWindow(990, 950, 50, L)).toBe(true);
    expect(inWindow(20, 950, 50, L)).toBe(true);
    expect(inWindow(500, 950, 50, L)).toBe(false);
  });
});
