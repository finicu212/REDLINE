import { describe, it, expect } from 'vitest';
import { CarDynamics } from '../dynamics.js';
import { G } from '../racingLine.js';

/** Constant-curvature loop (clockwise, radius R) shaped like buildRacingLine() output. */
function circleLine(R = 100, ds = 1) {
  const L = 2 * Math.PI * R, n = Math.round(L / ds);
  const x = new Float64Array(n), y = new Float64Array(n), s = new Float64Array(n);
  const heading = new Float64Array(n), curvature = new Float64Array(n).fill(1 / R);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;           // heading, clockwise from north
    heading[i] = a;
    x[i] = R - R * Math.cos(a);                // center at (R, 0): turning right
    y[i] = R * Math.sin(a);
    s[i] = (i / n) * L;
  }
  return { n, x, y, s, heading, curvature, length: L };
}

const R = 100;
const limit = (mu) => Math.sqrt(mu * G * R);

/** Drive at a held speed for `secs`, feeding the given longitudinal accel via speed ramps. */
function hold(car, v, secs, { throttle = 0.3, brake = 0, accel = 0, dt = 1 / 120 } = {}) {
  let speed = v, scrubbed = 0;
  for (let t = 0; t < secs; t += dt) {
    speed += accel * dt;
    const sc = car.update(dt, { speedMS: speed, throttle, brake });
    scrubbed += sc;
  }
  return scrubbed;
}

describe('CarDynamics — cornering limit', () => {
  it('under the limit: holds the line, no slide, no scrub', () => {
    const car = new CarDynamics(circleLine(R), { mu: 1.0, abs: true });
    const scrub = hold(car, limit(1.0) * 0.9, 3);
    expect(Math.abs(car.d)).toBeLessThan(0.3);
    expect(car.sliding).toBe(false);
    expect(scrub).toBeLessThan(0.01);
    expect(car.usageF).toBeLessThan(1);
  });

  it('over the limit with a front-heavy car: understeers wide and scrubs speed', () => {
    const car = new CarDynamics(circleLine(R), { mu: 1.0, frontWeight: 0.62 });
    const scrub = hold(car, limit(1.0) * 1.2, 1.5);
    expect(car.understeer).toBeGreaterThan(0);
    expect(car.d).toBeGreaterThan(1);       // right-hander: outside is left (+d)
    expect(scrub).toBeGreaterThan(0.5);
  });

  it('tyres start squealing just before the limit (a warning), not well below it', () => {
    const low = new CarDynamics(circleLine(R), { mu: 1.0 });
    hold(low, limit(1.0) * 0.7, 1);
    const near = new CarDynamics(circleLine(R), { mu: 1.0 });
    hold(near, limit(1.0) * 0.97, 1);
    expect(low.squeal).toBe(0);
    expect(near.squeal).toBeGreaterThan(0.2);
  });

  it('downforce raises the cornering limit at speed', () => {
    const plain = new CarDynamics(circleLine(R), { mu: 1.0 });
    const aero = new CarDynamics(circleLine(R), { mu: 1.0, downforce: 0.002 });
    hold(plain, limit(1.0) * 1.1, 1);
    hold(aero, limit(1.0) * 1.1, 1);
    expect(plain.sliding).toBe(true);
    expect(aero.sliding).toBe(false);
  });
});

describe('CarDynamics — way too fast', () => {
  it('coasting into a corner far over the limit understeers wide, never snaps into oversteer', () => {
    // Front-biased car lifting at 250 km/h: weight shifts forward, but both axles are overwhelmed
    const car = new CarDynamics(circleLine(300), { mu: 1.0, frontWeight: 0.52, cgHeight: 0.22 });
    let v = 69, maxOver = 0, maxYaw = 0;
    for (let t = 0; t < 1; t += 1 / 120) {
      v -= 3 / 120; // lift: drag + engine braking
      const sc = car.update(1 / 120, { speedMS: v, throttle: 0, brake: 0 });
      v -= sc;
      maxOver = Math.max(maxOver, car.oversteer);
      maxYaw = Math.max(maxYaw, Math.abs(car.yaw));
    }
    expect(maxOver).toBe(0);
    expect(maxYaw).toBeLessThan(0.05);
    expect(car.understeer).toBeGreaterThan(0.3);
  });

  it('the path never bends harder than the tyres allow, whichever axle lets go', () => {
    // Rear-light car, just over the limit: oversteer, but lateral drift = full grip deficit
    const R = 150, mu = 1.0;
    const car = new CarDynamics(circleLine(R), { mu, frontWeight: 0.35, cgHeight: 0.3, abs: false, tc: true });
    const v = limit(mu) * 1.08;
    hold(car, v, 0.4, { throttle: 0 });
    // outward accel >= demand − total grip (latCap ≤ mu·g)
    const minDrift = 0.5 * (v * v / R - mu * G) * 0.4 * 0.4;
    expect(car.d).toBeGreaterThan(minDrift * 0.8);
  });
});

describe('CarDynamics — weight transfer', () => {
  it('braking moves load to the front, accelerating to the rear', () => {
    const brake = new CarDynamics(circleLine(R), { frontWeight: 0.5, cgHeight: 0.25 });
    hold(brake, 40, 0.5, { accel: -6, brake: 1 });
    const gas = new CarDynamics(circleLine(R), { frontWeight: 0.5, cgHeight: 0.25 });
    hold(gas, 20, 0.5, { accel: 4, throttle: 1 });
    expect(brake.front).toBeGreaterThan(0.6);
    expect(gas.front).toBeLessThan(0.45);
  });

  it('lifting/braking hard mid-corner in a neutral RWD car makes it oversteer', () => {
    const car = new CarDynamics(circleLine(R), { mu: 1.0, frontWeight: 0.5, cgHeight: 0.3, abs: true });
    hold(car, limit(1.0) * 0.97, 0.5);
    hold(car, limit(1.0) * 0.97, 0.4, { accel: -5, brake: 1 });
    expect(car.oversteer).toBeGreaterThan(0);
    expect(car.yaw).toBeLessThan(0); // right-hander: nose rotates right (negative yaw)
  });

  it('power in a slow corner overwhelms a no-TC RWD car (wheelspin), TC just trims it', () => {
    const wild = new CarDynamics(circleLine(30), { mu: 0.8, tc: false });
    hold(wild, 12, 0.3, { accel: 6, throttle: 1 });
    const tamed = new CarDynamics(circleLine(30), { mu: 0.8, tc: true });
    hold(tamed, 12, 0.3, { accel: 6, throttle: 1 });
    expect(wild.wheelspin).toBeGreaterThan(0);
    expect(tamed.wheelspin).toBe(0);
    expect(tamed.tcActive).toBe(true);
  });
});

describe('CarDynamics — brakes', () => {
  it('ABS brakes at the limit without locking; no-ABS car locks and loses decel', () => {
    const abs = new CarDynamics(circleLine(R), { mu: 0.8, abs: true });
    const raw = new CarDynamics(circleLine(R), { mu: 0.8, abs: false });
    for (const car of [abs, raw]) hold(car, limit(0.8) * 0.9, 0.3);
    abs.brakeDecelFor(1, 12);
    raw.brakeDecelFor(1, 12);
    expect(abs.locked).toBe(false);
    expect(abs.absActive).toBe(true);
    expect(raw.locked).toBe(true);
    // Locked fronts can't steer: the car washes wide, the ABS car keeps turning
    for (let t = 0; t < 0.5; t += 1 / 120) {
      for (const car of [abs, raw]) {
        car.brakeDecelFor(1, 12);
        car.update(1 / 120, { speedMS: limit(0.8) * 0.9, throttle: 0, brake: 1 });
      }
    }
    expect(raw.usageF).toBeGreaterThanOrEqual(1.2);
    expect(raw.d).toBeGreaterThan(abs.d);
  });

  it('full pedal reaches the tyre limit (~1g+) even when the profile brake is weaker', () => {
    const car = new CarDynamics(circleLine(100000), { mu: 1.4, abs: true });
    hold(car, 40, 0.2);
    const d = car.brakeDecelFor(1, 8);
    expect(d).toBeGreaterThan(1.25 * G);
    expect(car.absActive).toBe(true);
  });

  it('gentle braking in a straight line never locks', () => {
    const car = new CarDynamics(circleLine(10000), { mu: 1.0, abs: false });
    hold(car, 40, 0.2);
    const d = car.brakeDecelFor(0.5, 12); // stronger than the 1.15 g floor: pedal scales it as-is
    expect(d).toBeCloseTo(6, 5);
    expect(car.locked).toBe(false);
  });
});

describe('CarDynamics — spins, runoff, progress', () => {
  it('lifting at the limit in a tail-happy car: spins, bleeds speed, then recovers', () => {
    const car = new CarDynamics(circleLine(R), { mu: 1.0, frontWeight: 0.35, cgHeight: 0.3, abs: false });
    let spun = false, recovered = false, v = limit(1.0) * 1.02, scrubTotal = 0;
    for (let t = 0; t < 4; t += 1 / 120) {
      const sc = car.update(1 / 120, { speedMS: v, throttle: 0, brake: 0 });
      v = Math.max(0, v - sc - 4 / 120); scrubTotal += sc; // lift: engine braking + drag
      if (car.events.some(e => e.type === 'spin')) spun = true;
      if (car.events.some(e => e.type === 'recovered')) recovered = true;
    }
    expect(spun).toBe(true);
    expect(recovered).toBe(true);
    expect(scrubTotal).toBeGreaterThan(5);
  });

  it('running wide off the track: runoff event, heavy drag, then rejoins', () => {
    const car = new CarDynamics(circleLine(R), { mu: 1.0, frontWeight: 0.6 });
    const types = new Set();
    let v = limit(1.0) * 1.4;
    for (let t = 0; t < 10; t += 1 / 120) {
      const sc = car.update(1 / 120, { speedMS: v, throttle: 0, brake: 0 });
      v = Math.max(limit(1.0) * 0.6, v - sc);
      car.events.forEach(e => types.add(e.type));
    }
    expect(types.has('offtrack')).toBe(true);
    expect(types.has('rejoin')).toBe(true);
    expect(Math.abs(car.d)).toBeLessThan(6);
  });

  it('advances along the line at road speed on a straight', () => {
    const car = new CarDynamics(circleLine(100000), {});
    hold(car, 50, 1);
    expect(car.distance).toBeCloseTo(50, 0);
  });

  it('pose follows the line with the offset applied', () => {
    const line = circleLine(R);
    const car = new CarDynamics(line, {});
    car.d = 2;
    const p = car.pose();
    expect(Math.hypot(p.x - line.x[0], p.y - line.y[0])).toBeCloseTo(2, 3);
  });
});
