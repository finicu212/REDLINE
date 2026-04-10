# REDLINE

Browser-based engine simulator with realistic drivetrain physics, layered audio synthesis, turbocharger model, and a manual clutch transmission. Runs on desktop and mobile.

**[Try it live](https://redline.finicu.workers.dev)**

## Features

- **Drivetrain physics** — torque curve interpolation, constant-power throttle model (BeamNG-style), angular acceleration, rev limiter with tight fuel-cut hysteresis. Honda S2000 AP1 gearbox. Engine allows over-rev past redline (no damage modeled).
- **Manual clutch** — hold Shift/C to decouple engine from wheels. Shift gears while clutch is held, release to feel spring-damper engagement. Clutchless shifts also work for convenience (auto-engages spring-damper).
- **Spring-damper clutch engagement** — replaces instant RPM snap with torsional spring-damper coupling engine and wheel inertias. Oscillation frequency and damping emerge from physics per gear.
- **Turbocharger** — BeamNG-style exhaust energy model with spool lag, wastegate, compressor back-pressure, and blow-off valve. Boost adds torque proportional to manifold pressure.
- **13-layer engine audio** — Web Audio API with frequency-band samples (low/mid/high) crossfading by RPM and throttle. Separate on/off-throttle sample sets, REV redline loop, limiter gated loop, transmission whine, 4-band decel layers, and synthesized shift thuds.
- **Multi-sample engine banks** — profiles can ship one loop per recorded RPM (`profile.audio.bank`); audio pitches each physically (`1200·log2(rpm/recorded)` cents) and equal-power crossfades the two nearest. Off-throttle reuses the bank through an RPM-tracking lowpass. Real-car profiles: AE86 4A-GE, Astra G 1.6, 370Z VQ37, DeLorean PRV V6, Corvette C6 LS3, Chevelle SS 454, Ferrari 458 F136 — published power/torque, gearing, tires and mass. Sources and licenses in `public/audio/CREDITS.md`.
- **Limiter styles** — per profile: `hard` (timed fuel cut, sharp audio chop), `soft` (torque taper into a smoothed partial cut), `none` (carb/points era: valve-float falloff is the ceiling), or legacy hysteresis. Straight-cut gear whine and the limiter loop are kept for the track car only; road cars get a quiet helical gear hum.
- **Exhaust convolution reverb** — procedurally generated impulse response from pipe geometry via ConvolverNode. Equal-power dry/wet crossfade.
- **Per-cylinder variation** — subtle timing jitter (±8%) and brightness/detune offsets per cylinder break mechanical perfection in both audio and visuals.
- **Idle realism** — idle air control holds RPM near 850, per-cylinder firing pulses add ±15 RPM flutter at ~14 Hz. Not a perfect flat line.
- **Continuous throttle** — 0–1 pedal position from keyboard (space = WOT), mouse drag, touch Y-position, or gamepad right trigger. Partial throttle blends on/off samples with volume scaling.
- **Analog tachometer** — DPR-aware canvas gauge with needle smoothing, redline arc, and glow. Responsive via ResizeObserver.
- **Cylinder visualization** — SVG cylinder bank with firing-order animations, per-cylinder brightness variation, and throttle-colored fills (orange = power, blue = engine braking). Supports inline-4, inline-6, and V6.
- **Color token system** — all colors in `tokens.js` + CSS custom properties. Canvas/SVG code imports JS tokens; stylesheets use `var(--c-*)`.
- **Responsive layout** — works on desktop and mobile. Touch devices get on-screen clutch/shift/brake buttons and Y-axis throttle.
- **Debug overlay** — real-time bars for RPM (red on over-rev), speed, torque, throttle, boost, inertia, detune, clutch/engagement status, turbo spool, BOV, oscillation, audio band gains, and frame timing sparkline. Toggle with backtick.

## Controls

| Input | Action |
|---|---|
| **Space** | Full throttle (WOT) |
| **Click + drag up** | Proportional throttle (mouse Y) |
| **Touch drag up** | Proportional throttle |
| **Shift / C** | Clutch (hold to decouple, shift, release to engage) |
| **Arrow Up / Down** | Shift up / down (works with or without clutch) |
| **S** or **B** | Brake |
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
├── CylinderBank.svelte   — SVG cylinder bank with firing-order animation
├── GearIndicator.svelte  — gear letter + speed display
├── Odometer.svelte       — distance counter (localStorage persistence)
├── DebugOverlay.svelte   — debug panel with bars, sparkline, status pills
├── engine/
│   ├── constants.js      — RPM limits, normalizeRPM()
│   ├── drivetrain.js     — physics: torque, gears, clutch, turbo, spring-damper
│   ├── audio.js          — 13-layer Web Audio engine + exhaust reverb + turbo whine
│   └── tokens.js         — color token system (JS exports + CSS vars)
│   └── __tests__/        — vitest test suites
└── main.js               — Svelte mount point
```
