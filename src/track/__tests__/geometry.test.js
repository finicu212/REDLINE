import { describe, it, expect } from 'vitest';
import { buildTrack, closeLoop, MONZA_SEGMENTS, wrapS } from '../geometry.js';

describe('Monza geometry', () => {
  const track = buildTrack();

  it('closes the loop: last point meets the first', () => {
    const a = track.points[0], b = track.points[track.points.length - 1];
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(3);
  });

  it('turns a net 360° clockwise', () => {
    const total = MONZA_SEGMENTS.reduce((acc, s) => acc + (s.turn ?? 0), 0);
    expect(total).toBe(360);
  });

  it('is about as long as the real circuit (5.793 km)', () => {
    expect(track.length).toBeGreaterThan(5500);
    expect(track.length).toBeLessThan(6100);
  });

  it('closure keeps adjusted straights positive and plausible', () => {
    const segs = closeLoop(MONZA_SEGMENTS);
    for (const s of segs.filter(s => s.adjust)) {
      expect(s.len).toBeGreaterThan(200);
      expect(s.len).toBeLessThan(1200);
    }
  });

  it('names the famous corners in lap order', () => {
    expect(track.corners.map(c => c.name)).toEqual(
      ['Rettifilo', 'Curva Grande', 'Roggia', 'Lesmo 1', 'Lesmo 2', 'Ascari', 'Parabolica']);
    for (let i = 1; i < track.corners.length; i++) expect(track.corners[i].s).toBeGreaterThan(track.corners[i - 1].s);
    for (const c of track.corners) expect(c.sEnd).toBeGreaterThan(c.s);
  });

  it('does not self-intersect (no two distant points closer than a track width)', () => {
    const pts = track.points.filter((_, i) => i % 5 === 0);
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const ds = Math.abs(pts[i].s - pts[j].s);
      if (Math.min(ds, track.length - ds) < 150) continue;
      minD = Math.min(minD, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
    expect(minD).toBeGreaterThan(40);
  });

  it('wrapS wraps both directions', () => {
    expect(wrapS(-10, 100)).toBe(90);
    expect(wrapS(250, 100)).toBe(50);
  });
});
