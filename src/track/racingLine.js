/**
 * Racing line: minimum-curvature path inside the track edges, found by gradient
 * descent on the offset from the centerline. Every car follows this same line.
 */

import { TRACK_HALF_WIDTH } from './geometry.js';

const EDGE_MARGIN = 1.3; // m — keep the car's half-width inside the white lines
export const G = 9.81;

/**
 * @param {{points, length}} track - from buildTrack()
 * @param {number} iterations - relaxation passes (converges slowly on long corners)
 */
export function buildRacingLine(track, iterations = 1500) {
  const n = track.points.length;
  const cx = new Float64Array(n), cy = new Float64Array(n);
  const nx = new Float64Array(n), ny = new Float64Array(n); // left-pointing normals
  track.points.forEach((p, i) => {
    cx[i] = p.x; cy[i] = p.y;
    // heading 0 = north, clockwise; left normal = (-cos h, sin h)
    nx[i] = -Math.cos(p.h); ny[i] = Math.sin(p.h);
  });

  // Offset along the normal is the only free variable — keeps points evenly spread
  const off = new Float64Array(n);
  const maxOff = TRACK_HALF_WIDTH - EDGE_MARGIN;
  const x = new Float64Array(n), y = new Float64Array(n);
  // Minimum curvature, not shortest path: plain Laplacian smoothing wraps the inside
  // kerb (radius R - w, tighter than the centerline). Descend on Σ|second difference|²
  // instead — its gradient is the fourth difference. Coarse-to-fine stencils converge fast.
  const cxd = new Float64Array(n), cyd = new Float64Array(n);
  const passes = [[16, 0.3], [8, 0.3], [4, 0.2], [2, 0.1], [1, 0.1]];
  for (const [k, frac] of passes) {
    const its = Math.round(iterations * frac);
    for (let it = 0; it < its; it++) {
      for (let i = 0; i < n; i++) { x[i] = cx[i] + nx[i] * off[i]; y[i] = cy[i] + ny[i] * off[i]; }
      for (let i = 0; i < n; i++) {
        const a = (i - k + n) % n, b = (i + k) % n;
        cxd[i] = x[a] - 2 * x[i] + x[b];
        cyd[i] = y[a] - 2 * y[i] + y[b];
      }
      for (let i = 0; i < n; i++) {
        const a = (i - k + n) % n, b = (i + k) % n;
        const gx = cxd[a] - 2 * cxd[i] + cxd[b];
        const gy = cyd[a] - 2 * cyd[i] + cyd[b];
        // stable for step ≤ 1/16; project on the normal so spacing stays even
        const step = -0.06 * (gx * nx[i] + gy * ny[i]);
        off[i] = Math.max(-maxOff, Math.min(maxOff, off[i] + step));
      }
    }
  }
  for (let i = 0; i < n; i++) { x[i] = cx[i] + nx[i] * off[i]; y[i] = cy[i] + ny[i] * off[i]; }

  // Arc length along the line itself (differs slightly from centerline s)
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  const length = s[n - 1] + Math.hypot(x[0] - x[n - 1], y[0] - y[n - 1]);

  // Heading and signed curvature (+ = turning right, matching geometry convention)
  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n;
    heading[i] = Math.atan2(x[b] - x[i], y[b] - y[i]);
  }
  const rawK = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    let dh = heading[i] - heading[a];
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const ds = (s[i] - s[a] + length) % length || 1e-6;
    rawK[i] = dh / ds;
  }
  const curvature = smoothCircular(rawK, 4);

  return { n, x, y, s, heading, curvature, offset: off, length, nx, ny, cx, cy };
}

function smoothCircular(arr, radius) {
  const n = arr.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += arr[(i + k + n) % n];
    out[i] = acc / (2 * radius + 1);
  }
  return out;
}

/** Index of the line sample at/just before arc length s (binary search). */
export function indexAt(line, s) {
  const L = line.length;
  s = ((s % L) + L) % L;
  let lo = 0, hi = line.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (line.s[mid] <= s) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Interpolated pose on the line at arc length s: {x, y, heading, curvature, nx, ny}. */
export function sampleLine(line, s) {
  const L = line.length;
  s = ((s % L) + L) % L;
  const i = indexAt(line, s);
  const j = (i + 1) % line.n;
  const segLen = ((line.s[j] - line.s[i]) + L) % L || 1e-6;
  const t = Math.min(1, (s - line.s[i]) / segLen);
  let dh = line.heading[j] - line.heading[i];
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  const heading = line.heading[i] + dh * t;
  return {
    x: line.x[i] + (line.x[j] - line.x[i]) * t,
    y: line.y[i] + (line.y[j] - line.y[i]) * t,
    heading,
    curvature: line.curvature[i] + (line.curvature[j] - line.curvature[i]) * t,
    // left-pointing unit normal of the line
    nx: -Math.cos(heading),
    ny: Math.sin(heading),
  };
}

/**
 * Max steady cornering speed (m/s) for curvature k, grip mu and downforce
 * (extra m/s² of normal load per (m/s)²):  v²|k| = mu (g + df v²).
 */
export function cornerSpeedLimit(k, mu, downforce = 0) {
  const ak = Math.abs(k);
  const denom = ak - mu * downforce;
  if (denom <= 1e-9) return Infinity;
  return Math.sqrt((mu * G) / denom);
}

/**
 * Brake-aware speed profile along the line: the fastest speed at each point from which
 * the car can still slow for everything ahead, using only the grip left after cornering
 * (friction circle). Backward pass, looped twice so the lap wraps cleanly.
 * @param {object} line
 * @param {{ mu: number, downforce?: number, brakeDecel: number, margin?: number }} opts
 * @returns {Float64Array} m/s per line sample
 */
export function speedProfile(line, { mu, downforce = 0, brakeDecel, margin = 1 }) {
  const n = line.n, L = line.length;
  const vmax = Float64Array.from(line.curvature, k => Math.min(150, cornerSpeedLimit(k, mu, downforce) * margin));
  const v = Float64Array.from(vmax);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const ds = ((line.s[j] - line.s[i]) + L) % L;
      const vj = v[j];
      const grip = mu * margin * (G + downforce * vj * vj);
      const lat = vj * vj * Math.abs(line.curvature[j]);
      const aBrake = Math.min(brakeDecel, Math.sqrt(Math.max(0, grip * grip - lat * lat)));
      v[i] = Math.min(vmax[i], Math.sqrt(vj * vj + 2 * aBrake * ds));
    }
  }
  return v;
}
