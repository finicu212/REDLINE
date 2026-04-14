/**
 * Top-down Monza renderer (canvas 2D). Draws the world in meters through one camera
 * transform; text and badges are projected and drawn in screen space so they stay crisp.
 *
 * Everything the player does leaves a mark here — skid marks, the grip trail, brake
 * ticks, corner grades — because the world noticing you is most of the fun.
 */

import { TRACK_HALF_WIDTH, KERB_WIDTH, RUNOFF_WIDTH } from './geometry.js';
import { indexAt, sampleLine } from './racingLine.js';
import * as T from '../engine/tokens.js';

const MAX_PARTICLES = 900;
const TREE_COUNT = 4200;
const TREE_CLEARANCE = TRACK_HALF_WIDTH + KERB_WIDTH + RUNOFF_WIDTH + 6;
const CAR_LEN = 4.5, CAR_WID = 1.95;
const TONE_COLOR = {
  perfect: T.gradePerfect, great: T.gradeGreat, good: T.gradeGood,
  meh: T.gradeMeh, warn: T.gradeWarn, bad: T.gradeBad,
};
const SECTOR_COLOR = { purple: T.gradePerfect, green: T.gradeGreat, yellow: '#f5d142' };

export class TrackRenderer {
  constructor(canvas, session, { carColor = T.accent } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.session = session;
    this.carColor = carColor;
    this.dpr = 1;
    this.W = 0; this.H = 0;
    this.cam = { x: 0, y: 0, h: 0, z: 3, init: false };
    this.shake = 0;
    this.time = 0;
    this._feedSeen = 0;
    this.popups = [];

    this._buildGeometry();
    this._buildTrees();
    this._buildSprites();
    this._buildGrassPattern();
    this._buildMinimap();
    this._initParticles();
  }

  // ---------------------------------------------------------------- setup

  _buildGeometry() {
    const { track, line, corners } = this.session;
    const pts = track.points;
    const n = pts.length;
    // Long paths are split into ~120 m chunks with a bounding circle, so each frame only
    // strokes what's on screen (the whole 5.9 km loop at 30 m wide is expensive)
    const edge = (off) => chunked(n, i => {
      const q = pts[i % n];
      return [q.x - Math.cos(q.h) * off, q.y + Math.sin(q.h) * off];
    });
    this.pCenter = edge(0);
    this.pLeft = edge(TRACK_HALF_WIDTH - 0.35);
    this.pRight = edge(-(TRACK_HALF_WIDTH - 0.35));

    // Corner zones (kerbs + gravel) in centerline index ranges
    const zone = (s0, s1, off) => {
      const p = new Path2D();
      let i = indexAt(line, s0);
      const i1 = indexAt(line, s1);
      let first = true;
      while (i !== i1) {
        const q = pts[i];
        const x = q.x - Math.cos(q.h) * off, y = q.y + Math.sin(q.h) * off;
        first ? p.moveTo(x, y) : p.lineTo(x, y);
        first = false;
        i = (i + 1) % n;
      }
      return p;
    };
    this.kerbs = [];
    this.gravel = [];
    for (const c of corners) {
      const a = c.sEntry - 25, b = c.sExit + 25;
      this.kerbs.push(zone(a, b, TRACK_HALF_WIDTH + KERB_WIDTH / 2), zone(a, b, -(TRACK_HALF_WIDTH + KERB_WIDTH / 2)));
      this.gravel.push(zone(c.sEntry - 40, c.sExit + 60, 0));
    }

    this.pLine = chunked(line.n, i => [line.x[i % line.n], line.y[i % line.n]]);

    // Start/finish: across the track at line s=0
    this.startPose = sampleLine(line, 0);

    // Brake boards (300/200/100 m) on the outside of braking corners
    this.boards = [];
    for (const c of corners) {
      if (c.vLimit > 70) continue;
      const k = sampleLine(line, c.sApex).curvature;
      const outside = k > 0 ? 1 : -1; // + = left side
      for (const m of [300, 200, 100]) {
        const p = sampleLine(line, c.sEntry - m);
        const side = outside * (TRACK_HALF_WIDTH + KERB_WIDTH + 4) - p.offset;
        this.boards.push({ x: p.x + p.nx * side, y: p.y + p.ny * side, h: p.heading, label: String(m / 100) });
      }
    }

    // Corner labels + badge anchors on the inside of each apex
    this.cornerAnchors = corners.map(c => {
      const p = sampleLine(line, c.sApex);
      const inside = p.curvature > 0 ? -1 : 1;
      const side = inside * 34;
      return { name: c.name, x: p.x + p.nx * side, y: p.y + p.ny * side };
    });

    // Grandstands + pit building along the main straight (either side of the line)
    this.stands = [];
    for (let s = -520; s <= 420; s += 90) {
      const p = sampleLine(line, s);
      const off = TRACK_HALF_WIDTH + 22 + p.offset;
      this.stands.push({ x: p.x - p.nx * off, y: p.y - p.ny * off, h: p.heading, w: 70, d: 14 });
    }
    this.pits = [];
    for (let s = -480; s <= 380; s += 110) {
      const p = sampleLine(line, s);
      const off = TRACK_HALF_WIDTH + 34 - p.offset;
      this.pits.push({ x: p.x + p.nx * off, y: p.y + p.ny * off, h: p.heading, w: 100, d: 18 });
    }

    // Bounds for the minimap
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
    this.bounds = { minX, maxX, minY, maxY };
  }

  _buildTrees() {
    const { track } = this.session;
    const pts = track.points.filter((_, i) => i % 5 === 0);
    const cell = 60, grid = new Map();
    for (const p of pts) {
      const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      (grid.get(k) || grid.set(k, []).get(k)).push(p);
    }
    const nearTrack = (x, y) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const p of grid.get(`${cx + dx},${cy + dy}`) || []) {
          if (Math.hypot(p.x - x, p.y - y) < TREE_CLEARANCE) return true;
        }
      }
      return false;
    };
    const rnd = mulberry32(1922); // Monza opened in 1922
    const { minX, maxX, minY, maxY } = this.bounds;
    const trees = [];
    let guard = 0;
    while (trees.length < TREE_COUNT && guard++ < TREE_COUNT * 20) {
      const x = minX - 250 + rnd() * (maxX - minX + 500);
      const y = minY - 250 + rnd() * (maxY - minY + 500);
      // Clumpy forest: smooth "noise" decides where the park is dense
      const density = 0.5 + 0.25 * Math.sin(x * 0.011 + 1.3) * Math.cos(y * 0.009) + 0.25 * Math.sin((x + y) * 0.006);
      if (rnd() > density) continue;
      if (nearTrack(x, y)) continue;
      trees.push(x, y, 3 + rnd() * 4.5, rnd() < 0.35 ? 1 : 0);
    }
    this.trees = Float32Array.from(trees);
  }

  _buildSprites() {
    const make = (rgb) => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, `rgba(${rgb},1)`);
      grad.addColorStop(0.45, `rgba(${rgb},0.55)`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return c;
    };
    this.sprites = [make('205,205,210'), make('176,150,108'), make('255,210,120')]; // smoke, dust, spark
  }

  _buildGrassPattern() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = T.trkGrass;
    g.fillRect(0, 0, 128, 128);
    const rnd = mulberry32(7);
    for (let i = 0; i < 900; i++) {
      const light = rnd() < 0.5;
      g.fillStyle = light ? 'rgba(255,255,230,0.05)' : 'rgba(0,20,0,0.07)';
      g.fillRect(Math.floor(rnd() * 128), Math.floor(rnd() * 128), 2, 2);
    }
    this.grassPattern = this.ctx.createPattern(c, 'repeat');
  }

  _buildMinimap() {
    const size = 170;
    const { minX, maxX, minY, maxY } = this.bounds;
    const scale = (size - 20) / Math.max(maxX - minX, maxY - minY);
    this.mini = { size, scale, ox: (size - (maxX - minX) * scale) / 2 - minX * scale, oy: (size + (maxY - minY) * scale) / 2 + minY * scale };
    const { line } = this.session;
    const sectorPath = (a, b) => {
      const p = new Path2D();
      let first = true;
      for (let i = 0; i < line.n; i += 3) {
        if (line.s[i] < a || line.s[i] > b) continue;
        const [x, y] = this._mini(line.x[i], line.y[i]);
        first ? p.moveTo(x, y) : p.lineTo(x, y);
        first = false;
      }
      return p;
    };
    const [e1, e2] = this.session.sectorEnds;
    this.miniSectors = [sectorPath(0, e1), sectorPath(e1, e2), sectorPath(e2, line.length)];
  }

  _mini(x, y) {
    return [this.mini.ox + x * this.mini.scale, this.mini.oy - y * this.mini.scale];
  }

  _initParticles() {
    const N = MAX_PARTICLES;
    this.pX = new Float32Array(N); this.pY = new Float32Array(N);
    this.pVX = new Float32Array(N); this.pVY = new Float32Array(N);
    this.pLife = new Float32Array(N); this.pMax = new Float32Array(N);
    this.pSize = new Float32Array(N); this.pGrow = new Float32Array(N);
    this.pKind = new Uint8Array(N); this.pAlpha = new Float32Array(N);
    this.pHead = 0;
  }

  spawn(kind, x, y, vx, vy, life, size, grow, alpha) {
    const i = this.pHead;
    this.pHead = (i + 1) % MAX_PARTICLES;
    this.pX[i] = x; this.pY[i] = y; this.pVX[i] = vx; this.pVY[i] = vy;
    this.pLife[i] = life; this.pMax[i] = life; this.pSize[i] = size; this.pGrow[i] = grow;
    this.pKind[i] = kind; this.pAlpha[i] = alpha;
  }

  resize(cssW, cssH, dpr) {
    this.dpr = Math.min(dpr || 1, 2);
    this.W = cssW; this.H = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
  }

  // ---------------------------------------------------------------- frame

  draw(dt) {
    if (!this.W || !this.H) return;
    this.time += dt;
    const { ctx } = this;
    const s = this.session;
    const car = s.car;
    const pose = car.pose();

    this._consumeFeed(pose);
    this._emitFx(dt, pose);
    this._updateCamera(dt, pose, car.v);

    // World pass
    const { cam } = this;
    const sh = this.shake > 0.01 ? this.shake : 0;
    this.shake *= Math.exp(-dt * 5);
    const jx = sh ? (Math.random() - 0.5) * sh * 10 : 0, jy = sh ? (Math.random() - 0.5) * sh * 10 : 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = T.trkGrassDark;
    ctx.fillRect(0, 0, this.W, this.H);

    ctx.save();
    ctx.translate(this.W / 2 + jx, this.H * 0.58 + jy);
    ctx.rotate(-cam.h);
    ctx.scale(cam.z, -cam.z);
    ctx.translate(-cam.x, -cam.y);
    this._worldMatrix = ctx.getTransform();
    this.viewR = Math.hypot(this.W, this.H) / cam.z * 0.62;

    this._drawGround();
    this._drawTrack();
    this._drawMarks();
    this._drawBuildings();
    this._drawBoards();
    this._drawGhost();
    this._drawParticles(dt, 0);
    this._drawCar(pose, car);
    this._drawParticles(0, 2);
    this._drawTrees();
    ctx.restore();

    // Screen pass
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawLabels();
    this._drawPopups(dt);
    this._drawMinimap(pose);
    this._drawGG(car);
  }

  _updateCamera(dt, pose, v) {
    const cam = this.cam;
    const lead = Math.min(140, 12 + v * 1.1);
    const tx = pose.x + Math.sin(pose.lineHeading) * lead;
    const ty = pose.y + Math.cos(pose.lineHeading) * lead;
    // Visible height grows with speed so braking points come into view in time
    const visible = 90 + v * 2.4;
    const tz = this.H / visible;
    if (!cam.init) {
      Object.assign(cam, { x: tx, y: ty, h: pose.lineHeading, z: tz, init: true });
      return;
    }
    const kPos = 1 - Math.exp(-dt * 4);
    const kRot = 1 - Math.exp(-dt * 2.2);
    const kZoom = 1 - Math.exp(-dt * 1.5);
    cam.x += (tx - cam.x) * kPos;
    cam.y += (ty - cam.y) * kPos;
    let dh = pose.lineHeading - cam.h;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    cam.h += dh * kRot;
    cam.z += (tz - cam.z) * kZoom;
  }

  _inView(x, y, pad = 0) {
    const dx = x - this.cam.x, dy = y - this.cam.y;
    const r = this.viewR + pad;
    return dx * dx + dy * dy < r * r;
  }

  _drawGround() {
    const { ctx } = this;
    // Grass texture in world space: it scrolls under the car, which is what sells speed
    const m = new DOMMatrix().scaleSelf(0.25, 0.25);
    this.grassPattern.setTransform(m);
    ctx.fillStyle = this.grassPattern;
    ctx.fillRect(this.cam.x - this.viewR, this.cam.y - this.viewR, this.viewR * 2, this.viewR * 2);
  }

  /** Stroke only the chunks of a chunked path that can be on screen. */
  _strokeChunks(chunks, width) {
    const pad = width / 2;
    for (const c of chunks) if (this._inView(c.x, c.y, c.r + pad)) this.ctx.stroke(c.p);
  }

  _drawTrack() {
    const { ctx } = this;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const runoff = (TRACK_HALF_WIDTH + KERB_WIDTH + RUNOFF_WIDTH) * 2;
    // Barrier = a slightly fatter dark stroke under the runoff. Round joins can't cusp the
    // way offset curves do around tight chicanes.
    ctx.strokeStyle = T.trkBarrier;
    ctx.lineWidth = runoff + 2.4;
    this._strokeChunks(this.pCenter, runoff + 2.4);
    ctx.strokeStyle = T.trkRunoff;
    ctx.lineWidth = runoff;
    this._strokeChunks(this.pCenter, runoff);
    ctx.strokeStyle = T.trkGravel;
    ctx.lineWidth = runoff - 6;
    for (const g of this.gravel) ctx.stroke(g);

    // Kerbs sit under the asphalt edge so their inner half reads as the white line's partner
    ctx.lineWidth = KERB_WIDTH;
    ctx.strokeStyle = T.trkKerbWhite;
    for (const k of this.kerbs) ctx.stroke(k);
    ctx.setLineDash([2.5, 2.5]);
    ctx.strokeStyle = T.trkKerbRed;
    for (const k of this.kerbs) ctx.stroke(k);
    ctx.setLineDash([]);

    ctx.strokeStyle = T.trkAsphalt;
    ctx.lineWidth = TRACK_HALF_WIDTH * 2;
    this._strokeChunks(this.pCenter, TRACK_HALF_WIDTH * 2);
    ctx.strokeStyle = T.trkAsphaltDark;
    ctx.lineWidth = TRACK_HALF_WIDTH * 0.9;
    ctx.globalAlpha = 0.35; // rubbered-in groove
    this._strokeChunks(this.pLine, TRACK_HALF_WIDTH);
    ctx.globalAlpha = 1;

    ctx.lineCap = 'butt';
    ctx.strokeStyle = T.trkLine;
    ctx.lineWidth = 0.25;
    this._strokeChunks(this.pLeft, 1);
    this._strokeChunks(this.pRight, 1);

    ctx.strokeStyle = T.trkRacingLine;
    ctx.lineWidth = 0.35;
    ctx.setLineDash([3, 5]);
    this._strokeChunks(this.pLine, 1);
    ctx.setLineDash([]);

    // Chequered start/finish
    const p = this.startPose;
    ctx.save();
    ctx.translate(p.x - p.nx * p.offset, p.y - p.ny * p.offset);
    ctx.rotate(-p.heading);
    const sq = 1;
    for (let i = -6; i < 6; i++) for (let j = 0; j < 2; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
      ctx.fillRect(i * sq, j * sq - 1, sq, sq);
    }
    ctx.restore();
  }

  _drawMarks() {
    const { ctx } = this;
    const s = this.session;

    // Grip trail: where you used the tyres, colored by how hard (last lap faint, this lap bold)
    const drawTrail = (arr, alpha) => {
      if (arr.length < 6) return;
      const buckets = [[T.trailGood, new Path2D()], [T.trailEdge, new Path2D()], [T.trailOver, new Path2D()]];
      for (let i = 3; i < arr.length; i += 3) {
        const x0 = arr[i - 3], y0 = arr[i - 2], x1 = arr[i], y1 = arr[i + 1];
        if (!this._inView(x1, y1, 20) || Math.hypot(x1 - x0, y1 - y0) > 12) continue;
        const u = arr[i + 2];
        const b = u > 0.98 ? 2 : u > 0.85 ? 1 : 0;
        buckets[b][1].moveTo(x0, y0);
        buckets[b][1].lineTo(x1, y1);
      }
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 0.9;
      ctx.lineCap = 'round';
      for (const [color, path] of buckets) { ctx.strokeStyle = color; ctx.stroke(path); }
      ctx.globalAlpha = 1;
    };
    drawTrail(s.lastTrail, 0.35);
    drawTrail(s.trail, 0.8);

    // Skid marks — the bullet holes. Kept all session.
    const sk = s.skids;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (let i = 0; i < s.skidCount; i++) {
      const o = i * 5;
      const x = sk[o + 2], y = sk[o + 3];
      if (!this._inView(x, y, 10)) continue;
      const a = sk[o + 4];
      const b = a > 0.66 ? 2 : a > 0.33 ? 1 : 0;
      paths[b].moveTo(sk[o], sk[o + 1]);
      paths[b].lineTo(x, y);
    }
    ctx.lineWidth = 0.32;
    ctx.lineCap = 'round';
    [0.18, 0.32, 0.5].forEach((alpha, b) => {
      ctx.strokeStyle = `rgba(${T.trkSkid},${alpha})`;
      ctx.stroke(paths[b]);
    });

    // Brake points: last lap white ticks, PB lap gold ticks
    const tick = (sPos, color, width) => {
      const p = sampleLine(s.line, sPos);
      const cxp = p.x - p.nx * p.offset, cyp = p.y - p.ny * p.offset;
      const hx = p.nx * TRACK_HALF_WIDTH, hy = p.ny * TRACK_HALF_WIDTH;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cxp + hx, cyp + hy);
      ctx.lineTo(cxp + hx * 0.55, cyp + hy * 0.55);
      ctx.moveTo(cxp - hx, cyp - hy);
      ctx.lineTo(cxp - hx * 0.55, cyp - hy * 0.55);
      ctx.stroke();
    };
    for (const v of Object.values(s.pbBrakePoints)) tick(v, T.pbGold, 0.9);
    for (const v of Object.values(s.grader.lastLapBrakePoints)) tick(v, 'rgba(255,255,255,0.9)', 0.6);
    for (const v of Object.values(s.grader.brakePoints)) tick(v, T.accent, 0.6);
  }

  _drawBuildings() {
    const { ctx } = this;
    const box = (b, roof, side) => {
      if (!this._inView(b.x, b.y, 80)) return;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(-b.h);
      ctx.fillStyle = T.trkShadow;
      ctx.fillRect(-b.d / 2 + 2, -b.w / 2 - 2, b.d, b.w);
      ctx.fillStyle = side;
      ctx.fillRect(-b.d / 2, -b.w / 2, b.d, b.w);
      ctx.fillStyle = roof;
      for (let r = 0; r < 4; r++) ctx.fillRect(-b.d / 2 + 1 + r * (b.d - 2) / 4, -b.w / 2 + 1, (b.d - 2) / 4 - 0.8, b.w - 2);
      ctx.restore();
    };
    for (const b of this.stands) box(b, '#8a93a5', '#5d6574');
    for (const b of this.pits) box(b, '#b8b2a4', '#8f8a7e');
  }

  _drawBoards() {
    const { ctx } = this;
    for (const b of this.boards) {
      if (!this._inView(b.x, b.y, 10)) continue;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(-b.h);
      ctx.fillStyle = T.trkShadow;
      ctx.fillRect(-1.1, -0.5, 2.6, 1.2);
      ctx.fillStyle = '#f6f6f2';
      ctx.fillRect(-1.3, -0.3, 2.6, 1.2);
      ctx.restore();
    }
  }

  _drawGhost() {
    const g = this.session.ghostPose();
    if (!g || !this._inView(g.x, g.y, 10)) return;
    const { ctx } = this;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(-g.heading);
    ctx.fillStyle = T.trkGhost;
    roundRect(ctx, -CAR_WID / 2, -CAR_LEN / 2, CAR_WID, CAR_LEN, 0.6);
    ctx.fill();
    ctx.restore();
  }

  _drawCar(pose, car) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(-pose.heading);
    // Never let the car shrink below a readable size when zoomed out at speed
    const minLenPx = 22;
    const k = Math.max(1, minLenPx / (CAR_LEN * this.cam.z));
    ctx.scale(k, k);
    // soft shadow down-right like the rest of the scene
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(ctx, -CAR_WID / 2 + 0.35, -CAR_LEN / 2 - 0.35, CAR_WID, CAR_LEN, 0.7);
    ctx.fill();
    // tyres
    ctx.fillStyle = '#151515';
    for (const [x, y] of [[-1, 1.35], [1, 1.35], [-1, -1.35], [1, -1.35]]) ctx.fillRect(x * 0.95 - 0.18, y - 0.35, 0.36, 0.7);
    // body
    ctx.fillStyle = this.carColor;
    roundRect(ctx, -CAR_WID / 2, -CAR_LEN / 2, CAR_WID, CAR_LEN, 0.7);
    ctx.fill();
    // cabin + windscreen
    ctx.fillStyle = 'rgba(20,24,32,0.85)';
    roundRect(ctx, -0.72, -0.55, 1.44, 1.7, 0.35);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,200,230,0.55)';
    ctx.fillRect(-0.66, 0.75, 1.32, 0.32);
    // brake lights
    const braking = this.session.brake > 0.05;
    ctx.fillStyle = braking ? '#ff2a1a' : '#6a1410';
    ctx.fillRect(-0.85, -CAR_LEN / 2, 0.45, 0.18);
    ctx.fillRect(0.4, -CAR_LEN / 2, 0.45, 0.18);
    if (braking) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(this.sprites[2], -2, -CAR_LEN / 2 - 1.8, 4, 3);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  _drawTrees() {
    const { ctx } = this;
    const t = this.trees;
    // shadows first so canopies overlap them
    ctx.fillStyle = T.trkShadow;
    for (let i = 0; i < t.length; i += 4) {
      if (!this._inView(t[i], t[i + 1], 12)) continue;
      ctx.beginPath();
      ctx.ellipse(t[i] + t[i + 2] * 0.35, t[i + 1] - t[i + 2] * 0.25, t[i + 2] * 1.05, t[i + 2] * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < t.length; i += 4) {
      const x = t[i], y = t[i + 1], r = t[i + 2];
      if (!this._inView(x, y, 12)) continue;
      const pine = t[i + 3] > 0.5;
      ctx.fillStyle = pine ? T.trkPineDark : T.trkTreeDark;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pine ? T.trkPineLight : T.trkTreeLight;
      ctx.beginPath(); ctx.arc(x - r * 0.25, y + r * 0.25, r * 0.55, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- effects

  _emitFx(dt, pose) {
    const car = this.session.car;
    const v = car.v;
    const back = { x: pose.x - Math.sin(pose.heading) * 1.8, y: pose.y - Math.cos(pose.heading) * 1.8 };
    const rate = (k) => Math.random() < k * dt * 60;
    if (car.surface === 'runoff' && v > 4) {
      if (rate(Math.min(1, v / 25))) this.spawn(1, back.x + rand(1.5), back.y + rand(1.5), rand(1.5), rand(1.5), 1.6, 2.2, 3.5, 0.6);
    } else if (car.sliding && v > 5) {
      const heavy = car.locked || car.wheelspin > 0.3 || car.spinTimer > 0 || car.oversteer > 0.3;
      if (rate(heavy ? 1 : 0.35)) this.spawn(0, back.x + rand(1), back.y + rand(1), rand(0.8), rand(0.8), heavy ? 1.8 : 1.1, 1.6, heavy ? 3 : 1.8, heavy ? 0.5 : 0.28);
    }
    if (car.surface === 'kerb' && v > 10 && rate(0.25)) this.shake = Math.max(this.shake, 0.08);
  }

  _drawParticles(dt, onlyKind) {
    const { ctx } = this;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      if (dt) {
        this.pLife[i] -= dt;
        this.pX[i] += this.pVX[i] * dt; this.pY[i] += this.pVY[i] * dt;
        this.pSize[i] += this.pGrow[i] * dt;
      }
      if ((onlyKind === 2) !== (this.pKind[i] === 2)) continue;
      const lf = 1 - this.pLife[i] / this.pMax[i];
      const a = Math.min(1, lf * 4) * Math.min(1, (1 - lf) * 2.5) * this.pAlpha[i];
      if (a <= 0.01) continue;
      const sz = this.pSize[i];
      ctx.globalAlpha = a;
      ctx.drawImage(this.sprites[this.pKind[i]], this.pX[i] - sz, this.pY[i] - sz, sz * 2, sz * 2);
    }
    ctx.globalAlpha = 1;
  }

  _consumeFeed(pose) {
    const feed = this.session.feed;
    // feed is pruned from the front; track by event time
    for (const e of feed) {
      if (e.seq <= this._feedSeen) continue;
      this._feedSeen = e.seq;
      if (e.type === 'corner') {
        const a = this.cornerAnchors.find(c => c.name === e.name);
        let sub = e.tone === 'bad' ? '' : `${Math.round(e.vMin * 3.6)} / ${Math.round(e.vLimit * 3.6)} km/h`;
        if (e.brakeVsPB != null && Math.abs(e.brakeVsPB) >= 3) {
          sub += `  ·  brake ${Math.abs(Math.round(e.brakeVsPB))} m ${e.brakeVsPB > 0 ? 'later' : 'earlier'}`;
        }
        this.popups.push({ x: a.x, y: a.y, text: e.grade, sub, color: TONE_COLOR[e.tone], t: 0, big: e.tone === 'perfect' });
        if (e.tone === 'perfect') this._sparkle(a.x, a.y);
      } else if (e.type === 'wall') {
        this.shake = 1;
        for (let k = 0; k < 10; k++) this.spawn(2, pose.x, pose.y, rand(8), rand(8), 0.5, 0.4, 0.2, 1);
      } else if (e.type === 'offtrack') {
        this.shake = Math.max(this.shake, 0.4);
      } else if (e.type === 'spin') {
        this.shake = Math.max(this.shake, 0.5);
      } else if (e.type === 'lap' && e.pb) {
        this._sparkle(pose.x, pose.y, 40);
      }
    }
  }

  _sparkle(x, y, n = 18) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 10;
      this.spawn(2, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.9 + Math.random() * 0.5, 0.8, 0.3, 1);
    }
  }

  // ---------------------------------------------------------------- screen space

  _project(x, y) {
    const m = this._worldMatrix;
    // canvas matrix is in device pixels; divide back to CSS pixels
    return [(m.a * x + m.c * y + m.e) / this.dpr, (m.b * x + m.d * y + m.f) / this.dpr];
  }

  _drawLabels() {
    const { ctx } = this;
    const s = this.session;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Brake board numbers
    ctx.font = `bold ${Math.max(9, Math.min(15, this.cam.z * 1.4))}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = '#1a1a1a';
    for (const b of this.boards) {
      if (!this._inView(b.x, b.y, 5)) continue;
      const [x, y] = this._project(b.x, b.y);
      ctx.fillText(b.label, x, y);
    }
    // Corner names + the last grade you earned there (a persistent mark)
    for (const a of this.cornerAnchors) {
      if (!this._inView(a.x, a.y, 40)) continue;
      const [x, y] = this._project(a.x, a.y);
      ctx.font = `600 11px 'Share Tech Mono', monospace`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(a.name.toUpperCase(), x, y);
      const g = s.grader.lastGrades[a.name];
      if (g) pill(ctx, x, y + 15, g.grade, TONE_COLOR[g.tone], 10);
    }
  }

  _drawPopups(dt) {
    const { ctx } = this;
    this.popups = this.popups.filter(p => (p.t += dt) < 2.2);
    for (const p of this.popups) {
      const [x, y0] = this._project(p.x, p.y);
      const k = p.t / 2.2;
      const pop = p.t < 0.15 ? 0.6 + p.t / 0.15 * 0.6 : Math.max(1, 1.2 - (p.t - 0.15) * 1.5);
      const y = y0 - 30 - k * 40;
      ctx.globalAlpha = Math.min(1, (1 - k) * 3);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(pop, pop);
      ctx.font = `900 ${p.big ? 24 : 19}px 'Share Tech Mono', monospace`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      if (p.sub) {
        ctx.font = `12px 'Share Tech Mono', monospace`;
        ctx.strokeText(p.sub, 0, 18);
        ctx.fillStyle = '#f0f0f0';
        ctx.fillText(p.sub, 0, 18);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  _drawMinimap(pose) {
    const { ctx } = this;
    const s = this.session;
    const { size } = this.mini;
    const x0 = this.W - size - 12, y0 = 46; // below the CONTROLS button
    ctx.save();
    ctx.translate(x0, y0);
    ctx.fillStyle = 'rgba(10,12,20,0.55)';
    roundRect(ctx, 0, 0, size, size, 12);
    ctx.fill();
    // Sectors in their last colour — you can see your lap on the map
    const last = s.timer.lastSectorColors || [];
    this.miniSectors.forEach((p, i) => {
      ctx.strokeStyle = SECTOR_COLOR[last[i]] || 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.stroke(p);
    });
    // Corner grade dots
    for (const a of this.cornerAnchors) {
      const g = s.grader.lastGrades[a.name];
      if (!g) continue;
      const [mx, my] = this._mini(a.x, a.y);
      ctx.fillStyle = TONE_COLOR[g.tone];
      ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2); ctx.fill();
    }
    const ghost = s.ghostPose();
    if (ghost) {
      const [gx, gy] = this._mini(ghost.x, ghost.y);
      ctx.fillStyle = T.trkGhost;
      ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.fill();
    }
    const [cx, cy] = this._mini(pose.x, pose.y);
    const pulse = 4 + Math.sin(this.time * 6) * 1.2;
    ctx.fillStyle = this.carColor;
    ctx.beginPath(); ctx.arc(cx, cy, pulse, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /** Friction-circle meter: where you are on the grip budget, front and rear. */
  _drawGG(car) {
    const { ctx } = this;
    const r = 42;
    const cx = 14 + r, cy = this.H - 14 - r - 18;
    const c = car.c;
    const grip = c.mu * (9.81 + c.downforce * car.v * car.v);
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,20,0.55)';
    roundRect(ctx, cx - r - 8, cy - r - 8, r * 2 + 16, r * 2 + 34, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    // dot: right = turning right, up = braking
    const gx = Math.max(-1.2, Math.min(1.2, car.aLat / grip)), gy = Math.max(-1.2, Math.min(1.2, -car.aLong / grip));
    const u = Math.max(car.usageF, car.usageR);
    ctx.fillStyle = u > 0.98 ? T.gradeBad : u > 0.85 ? T.gradeWarn : T.gradeGreat;
    ctx.beginPath(); ctx.arc(cx + gx * r, cy - gy * r, 5, 0, Math.PI * 2); ctx.fill();
    // front / rear usage bars
    const bar = (label, val, y) => {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(cx - r + 12, y, r * 2 - 12, 5);
      ctx.fillStyle = val > 0.98 ? T.gradeBad : val > 0.85 ? T.gradeWarn : T.gradeGreat;
      ctx.fillRect(cx - r + 12, y, (r * 2 - 12) * Math.min(1, val), 5);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = `9px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx - r, y + 3);
    };
    bar('F', car.usageF, cy + r + 6);
    bar('R', car.usageR, cy + r + 15);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- helpers

/** Split a closed polyline (point i → [x, y], i in [0, n]) into Path2D chunks with bounds. */
function chunked(n, at, size = 60) {
  const chunks = [];
  for (let start = 0; start < n; start += size) {
    const end = Math.min(n, start + size);
    const p = new Path2D();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = start; i <= end; i++) {
      const [x, y] = at(i);
      i === start ? p.moveTo(x, y) : p.lineTo(x, y);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    chunks.push({ p, x: (minX + maxX) / 2, y: (minY + maxY) / 2, r: Math.hypot(maxX - minX, maxY - minY) / 2 });
  }
  return chunks;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rand(k) {
  return (Math.random() - 0.5) * 2 * k;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pill(ctx, x, y, text, color, size) {
  ctx.font = `700 ${size}px 'Share Tech Mono', monospace`;
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = 'rgba(10,12,20,0.7)';
  roundRect(ctx, x - w / 2, y - size * 0.8, w, size * 1.6, size * 0.8);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}
