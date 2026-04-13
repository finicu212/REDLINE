# REDLINE

Browser-based engine simulator with realistic drivetrain physics, layered audio synthesis, turbocharger model, and a manual clutch transmission. Runs on desktop and mobile.

**[Try it live](https://redline.finicu.workers.dev)**

## Features

- **Drivetrain physics** — torque curve interpolation, constant-power throttle model (BeamNG-style), angular acceleration, rev limiter with tight fuel-cut hysteresis. Honda S2000 AP1 gearbox. Engine allows over-rev past redline (no damage modeled).
- **Manual clutch** — hold Shift/C to decouple engine from wheels. Shift gears while clutch is held, release to feel spring-damper engagement. Clutchless shifts also work for convenience (auto-engages spring-damper).
- **Spring-damper clutch engagement** — replaces instant RPM snap with torsional spring-damper coupling engine and wheel inertias. Oscillation frequency and damping emerge from physics per gear.
- **Turbocharger** — BeamNG-style exhaust energy model with spool lag, wastegate, compressor back-pressure, and blow-off valve. Boost adds torque proportional to manifold pressure.
- **13-layer engine audio** — Web Audio API with frequency-band samples (low/mid/high) crossfading by RPM and throttle. Separate on/off-throttle sample sets, REV redline loop, limiter gated loop, transmission whine, 4-band decel layers, and synthesized shift thuds.
- **Multi-sample engine banks** — profiles can ship one loop per recorded RPM (`profile.audio.bank`); audio pitches each physically (`1200·log2(rpm/recorded)` cents) and equal-power crossfades the two nearest. Off-throttle reuses the bank through an RPM-tracking lowpass. Real-car profiles: Opel Astra G 2.0 DTI (VGT turbo-diesel, no BOV), 370Z VQ37, DeLorean PRV V6, Corvette C6 LS3, Chevelle SS 454, Ferrari 458 F136 — published power/torque, gearing, tires and mass. Sources and licenses in `public/audio/CREDITS.md`.
- **Limiter styles** — per profile: `hard` (GT-style bounce: timed fuel cut, sharp audio chop, exhaust pop per cut; 458, LS3, 370Z; the SuperSports track tune uses a tight 20 ms stutter), `soft` (torque taper holds RPM at redline while the engine keeps singing, with a gentle hunt; DeLorean, 454, and the Astra diesel's governor), `none`, or legacy hysteresis. Straight-cut gear whine and the limiter loop are kept for the track car only; road cars get a quiet helical gear hum.
- **Exhaust convolution reverb** — procedurally generated impulse response from pipe geometry via ConvolverNode. Equal-power dry/wet crossfade.
- **Per-cylinder variation** — subtle timing jitter (±8%) and brightness/detune offsets per cylinder break mechanical perfection in both audio and visuals.
- **Idle realism** — idle air control holds RPM near 850, per-cylinder firing pulses add ±15 RPM flutter at ~14 Hz. Not a perfect flat line.
- **Continuous throttle** — 0–1 pedal position from keyboard (space = WOT), mouse drag, touch Y-position, or gamepad right trigger. Partial throttle blends on/off samples with volume scaling.
- **Turbos** — Opel 2.0 DTI (factory VGT diesel, published on-boost curve), SuperSports (aftermarket single), 370Z and LS3 (aftermarket twin kits) boost on top of their NA curves, with BOV.
- **Supercharger** — 454 runs a period Roots blower: boost tracks crank speed with no lag (full from ~2500 RPM), bypass valve dumps it at part throttle, belt drive costs crank torque, synthesized rotor whine pitched by crank × pulley.
- **Boost gauge** — BeamNG-style dial (−1…+1.5 bar) beside the tach on turbo cars: orange arc for boost, blue for intake vacuum on petrol turbos; diesels read ~0 off-boost (unthrottled intake).
- **Analog tachometer** — DPR-aware canvas gauge with needle smoothing, redline arc, and glow. Responsive via ResizeObserver.
- **Monza time attack** — top-down 2D Autodromo Nazionale (GP layout, 5.8 km) built from real straights/radii. Every car follows the same minimum-curvature racing line; you drive the engine and brakes and have to nail each corner's entry speed. Standing start, the clock runs from the line, PBs are saved per car.
- **Tyre model** — per-axle friction circle with weight transfer (braking loads the nose → sharper turn-in, looser rear; throttle loads the rear → push). Front saturates first → understeer and run wide; rear first → oversteer, yaw, spins. Grip-limited brakes: ABS/EBD cars brake at the limit, older cars lock up (no steering). Wheelspin on no-TC cars, stability control on TC cars. Downforce, kerbs, gravel traps, tyre walls, track limits.
- **Per-car chassis** — grip, downforce, weight distribution, CG height, brake bias, FWD/RWD, ABS, TC, tuned per car (slicks + aero SuperSports, 50/50 LS3, rear-engined DeLorean, bias-ply 454...).
- **Player feedback everywhere** (Gabe Newell's "bullet holes": the world should acknowledge you) — persistent skid marks, a grip-usage trail painted on the track (green/amber/red), brake-point ticks (this lap / last lap / PB in gold), corner grades that pop at each apex and stay as badges (PERFECT / GREAT / GOOD / SAFE / TOO HOT / SPIN / OFF TRACK / FLAT OUT, with speed vs limit), clean-corner streaks, purple/green/yellow sectors, live delta and a PB ghost, speed-trap records, NEW PERSONAL BEST celebration, friction-circle meter with front/rear usage bars, tyre smoke, gravel dust, kerb rumble, screen shake.
- **Tyre audio** — squeal that starts just *before* the limit (listen for it), higher screech when locked, gravel crunch, kerb rumble at the stripe rate, barrier thump.
- **Color token system** — all colors in `tokens.js` + CSS custom properties. Canvas/SVG code imports JS tokens; stylesheets use `var(--c-*)`.
- **Responsive layout** — works on desktop and mobile. Touch devices get on-screen clutch/shift/brake buttons and Y-axis throttle.
- **Debug overlay** — real-time bars for RPM (red on over-rev), speed, torque, throttle, boost, inertia, detune, clutch/engagement status, turbo spool, BOV, oscillation, audio band gains, and frame timing sparkline. Toggle with backtick.

## Controls

| Input | Action |
|---|---|
| **Space** | Full throttle (WOT); 35% in neutral |
| **Click + drag up** | Proportional throttle (mouse Y) |
| **Touch drag up** | Proportional throttle |
| **Shift / C** | Clutch (hold to decouple, shift, release to engage) |
| **Arrow Up / Down** | Shift up / down (works with or without clutch; no over-rev protection — money shifts allowed) |
| **PRESS ↑ / ↓ TO SHIFT** | Keycap hint above the gear after ~3 s idle in neutral; keys are clickable |
| **S** or **B** | Brake (ramps in like a foot — ease off to trail-brake) |
| **R** | Back to the grid (PBs and marks stay) |
| **Backtick (`)** | Toggle debug overlay |
| **Gamepad RT / LT** | Throttle / brake |
| **Gamepad LB** | Clutch |
| **Gamepad RB** | Shift up |
| **Gamepad Dpad Down** | Shift down |
| **Touch CLT** | Clutch button |
| **Touch BRK** | Brake button |

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Pick an engine / sound variant, then **START ENGINE**.

## Tech Stack

- [Svelte 5](https://svelte.dev/) with runes (`$state`, `$derived`, `$effect`, `$props`)
- [Vite 6](https://vite.dev/) + [Cloudflare Vite Plugin](https://developers.cloudflare.com/workers/frameworks/framework-guides/vite/)
- Web Audio API (AudioContext, ConvolverNode, OscillatorNode)
- Canvas API / SVG
- Vitest for testing
- Cloudflare Workers for hosting (CD via GitHub Actions on tag push)

## Project Structure

```
src/
├── App.svelte            — screen router (customizer → sim), global CSS tokens
├── Customizer.svelte     — engine config picker + audio loader
├── Sim.svelte            — main loop, input handling (keyboard/mouse/touch/gamepad)
├── Tachometer.svelte     — DPR-aware canvas analog gauge
├── TrackView.svelte      — canvas host for the track renderer
├── TrackHud.svelte       — lap/sector/delta/streak HUD + banners
├── GearIndicator.svelte  — gear letter + speed display
├── Odometer.svelte       — distance counter (localStorage persistence)
├── DebugOverlay.svelte   — debug panel with bars, sparkline, status pills
├── engine/
│   ├── constants.js      — RPM limits, normalizeRPM()
│   ├── drivetrain.js     — physics: torque, gears, clutch, turbo, spring-damper
│   ├── audio.js          — 13-layer Web Audio engine + exhaust reverb + turbo whine
│   └── tokens.js         — color token system (JS exports + CSS vars)
├── track/
│   ├── geometry.js       — Monza as straights + arcs, loop closure, corners
│   ├── racingLine.js     — minimum-curvature line, curvature, speed limits/profile
│   ├── dynamics.js       — tyres: friction circle, weight transfer, slides, spins, runoff
│   ├── timing.js         — laps, sectors, delta, ghost trace, corner grading
│   ├── session.js        — frame orchestration, marks (skids/trail/brake points), records
│   ├── autopilot.js      — reference driver (tests, playtests)
│   ├── render.js         — top-down canvas renderer, camera, FX, minimap, g-g meter
│   ├── storage.js        — safe localStorage for PBs
│   └── __tests__/
│   └── __tests__/        — vitest test suites
└── main.js               — Svelte mount point
```
