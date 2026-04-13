import { describe, it, expect } from 'vitest';
import { buildTrack, TRACK_HALF_WIDTH } from '../geometry.js';
import { buildRacingLine, sampleLine, indexAt, cornerSpeedLimit, G } from '../racingLine.js';

const track = buildTrack();
const line = buildRacingLine(track);

describe('Racing line', () => {
  it('stays inside the white lines everywhere', () => {
    for (let i = 0; i < line.n; i++) expect(Math.abs(line.offset[i])).toBeLessThanOrEqual(TRACK_HALF_WIDTH);
  });

  it('is shorter than the centerline (cuts apexes)', () => {
    expect(line.length).toBeLessThan(track.length);
    expect(line.length).toBeGreaterThan(track.length * 0.97);
  });

  it('opens up corners: peak curvature below the centerline radius', () => {
    // Rettifilo centerline radius 14 m → line must be gentler
    const rettifilo = track.corners.find(c => c.name === 'Rettifilo');
    let maxK = 0;
    for (let i = 0; i < line.n; i++) if (line.s[i] > rettifilo.s - 20 && line.s[i] < rettifilo.sEnd + 20) maxK = Math.max(maxK, Math.abs(line.curvature[i]));
    expect(maxK).toBeLessThan(1 / 14);
    expect(maxK).toBeGreaterThan(1 / 60); // still a proper chicane
  });

  it('uses the full width at apexes (touches the inside)', () => {
    const maxOff = Math.max(...Array.from(line.offset, Math.abs));
    expect(maxOff).toBeGreaterThan(TRACK_HALF_WIDTH - 2);
  });

  it('straights are near-zero curvature', () => {
    const p = sampleLine(line, 300);
    expect(Math.abs(p.curvature)).toBeLessThan(0.001);
  });

  it('sampleLine wraps and interpolates', () => {
    const a = sampleLine(line, 10), b = sampleLine(line, 10 + line.length);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(indexAt(line, -1)).toBe(line.n - 1);
  });

  it('corner speed limit: v²k = mu g, downforce raises it, straights unlimited', () => {
    const v = cornerSpeedLimit(1 / 100, 1.0);
    expect(v * v / 100).toBeCloseTo(G, 3);
    expect(cornerSpeedLimit(1 / 100, 1.0, 0.001)).toBeGreaterThan(v);
    expect(cornerSpeedLimit(0, 1)).toBe(Infinity);
  });
});
