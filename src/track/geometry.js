/**
 * Monza (Autodromo Nazionale, GP layout) as a clockwise chain of straights and arcs.
 *
 * Built "turtle style" from real-ish segment lengths and corner radii, then two
 * straights are solved so the loop closes exactly. World units are meters,
 * x = east, y = north. Arc length s = 0 is the start/finish line.
 */

const DEG = Math.PI / 180;

/**
 * Segment list. Straights: { len }. Arcs: { turn: degrees (+right), r }.
 * `corner` names the start of a named corner; `adjust` marks the straights the
 * closure solver may lengthen/shorten.
 */
export const MONZA_SEGMENTS = [
  { len: 600, name: 'Start / Finish' },
  { turn: 80, r: 14, corner: 'Rettifilo' },
  { len: 25 },
  { turn: -80, r: 14 },
  { len: 200 },
  { turn: 72, r: 380, corner: 'Curva Grande' },
  { len: 650, adjust: 'b' },
  { turn: -55, r: 22, corner: 'Roggia' },
  { len: 15 },
  { turn: 55, r: 22 },
  { len: 320 },
  { turn: 80, r: 75, corner: 'Lesmo 1' },
  { len: 190 },
  { turn: 55, r: 62, corner: 'Lesmo 2' },
  { len: 450, name: 'Serraglio' },
  { turn: -8, r: 600 },
  { len: 400 },
  { turn: -45, r: 90, corner: 'Ascari' },
  { len: 20 },
  { turn: 80, r: 95 },
  { len: 20 },
  { turn: -35, r: 140 },
  { len: 1000, name: 'Rettilineo Centro' },
  { turn: 40, r: 130, corner: 'Parabolica' },
  { turn: 121, r: 200 },
  { len: 450, adjust: 'a' },
];

export const TRACK_HALF_WIDTH = 6;   // m — 12 m wide asphalt
export const KERB_WIDTH = 1.5;       // m — kerb strip past the white line
export const RUNOFF_WIDTH = 28;      // m — gravel/grass before the barrier

/** Walk the segments from origin heading north; returns end pose. */
function walk(segments, onPoint, ds = 2) {
  let x = 0, y = 0, h = 0; // h: heading, 0 = north, clockwise positive
  let s = 0;
  onPoint?.(x, y, h, s, -1);
  segments.forEach((seg, i) => {
    if (seg.len !== undefined) {
      const n = Math.max(1, Math.ceil(seg.len / ds));
      for (let k = 1; k <= n; k++) {
        const d = seg.len / n;
        x += Math.sin(h) * d; y += Math.cos(h) * d; s += d;
        onPoint?.(x, y, h, s, i);
      }
    } else {
      const total = seg.turn * DEG;
      const arc = Math.abs(total) * seg.r;
      const n = Math.max(1, Math.ceil(arc / ds));
      for (let k = 1; k <= n; k++) {
        const dh = total / n;
        const d = arc / n;
        // midpoint heading keeps the chord on the arc
        const hm = h + dh / 2;
        x += Math.sin(hm) * d; y += Math.cos(hm) * d; s += d;
        h += dh;
        onPoint?.(x, y, h, s, i);
      }
    }
  });
  return { x, y, h, s };
}

/** Lengthen/shorten the two `adjust` straights so the path ends where it began. */
export function closeLoop(segments) {
  const segs = segments.map(s => ({ ...s }));
  const ia = segs.findIndex(s => s.adjust === 'a');
  const ib = segs.findIndex(s => s.adjust === 'b');
  const headingAt = idx => {
    let h = 0;
    for (let i = 0; i < idx; i++) if (segs[i].turn !== undefined) h += segs[i].turn * DEG;
    return h;
  };
  const da = [Math.sin(headingAt(ia)), Math.cos(headingAt(ia))];
  const db = [Math.sin(headingAt(ib)), Math.cos(headingAt(ib))];
  const end = walk(segs);
  // Solve da*α + db*β = -end for straight-length deltas α, β
  const det = da[0] * db[1] - da[1] * db[0];
  const alpha = (-end.x * db[1] + end.y * db[0]) / det;
  const beta = (-da[0] * end.y + da[1] * end.x) / det;
  segs[ia].len += alpha;
  segs[ib].len += beta;
  return segs;
}

/**
 * Resample the closed centerline every ~ds meters.
 * Returns { points: [{x, y, h, s, seg}], length, corners: [{name, s}], segments }.
 */
export function buildTrack(segments = MONZA_SEGMENTS, ds = 2) {
  const segs = closeLoop(segments);
  const points = [];
  walk(segs, (x, y, h, s, seg) => points.push({ x, y, h, s, seg }), ds);
  // last point duplicates the first after closure
  const length = points[points.length - 1].s;
  points.pop();

  const corners = [];
  const segStart = [];
  let acc = 0;
  segs.forEach((seg, i) => {
    segStart[i] = acc;
    acc += seg.len !== undefined ? seg.len : Math.abs(seg.turn * DEG) * seg.r;
    if (seg.corner) corners.push({ name: seg.corner, s: segStart[i], segIndex: i });
  });
  // Corner extent: from its first arc to the end of its last arc before a long straight
  for (let c = 0; c < corners.length; c++) {
    let j = corners[c].segIndex;
    let end = segStart[j];
    while (j < segs.length && (segs[j].turn !== undefined || (segs[j].len < 40 && !segs[j].adjust))) {
      end = segStart[j] + (segs[j].len !== undefined ? segs[j].len : Math.abs(segs[j].turn * DEG) * segs[j].r);
      j++;
    }
    corners[c].sEnd = end;
  }
  return { points, length, corners, segments: segs, segStart };
}

/** Wrap arc length into [0, length). */
export function wrapS(s, length) {
  return ((s % length) + length) % length;
}
