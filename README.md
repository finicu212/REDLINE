# REDLINE

Browser-based engine simulator with realistic drivetrain physics, layered audio synthesis, and an interactive manual transmission. Runs on desktop and mobile.

## Features

- **Drivetrain physics** — torque curve interpolation, constant-power throttle model (BeamNG-style), angular acceleration, rev limiter with fuel-cut hysteresis, over-rev protection on downshifts, and post-shift drivetrain oscillation. Honda S2000 AP1 gearbox.
- **13-layer engine audio** — Web Audio API with frequency-band samples (low/mid/high) crossfading by RPM and throttle. Separate on/off-throttle sample sets, REV redline loop, limiter gated loop, transmission whine, 4-band decel layers, and synthesized shift thuds.
- **Exhaust convolution reverb** — procedurally generated impulse response from pipe length/diameter parameters via ConvolverNode. Equal-power dry/wet crossfade.
- **Per-cylinder variation** — subtle timing jitter (±8%) and brightness/detune offsets per cylinder break mechanical perfection in both audio and visuals.
- **Continuous throttle** — 0–1 pedal position from keyboard (space = WOT), mouse drag, touch Y-position, or gamepad right trigger. Partial throttle blends on/off samples with volume scaling.
- **Analog tachometer** — DPR-aware canvas gauge with needle smoothing, redline arc, and glow. Responsive via ResizeObserver.
- **Cylinder visualization** — SVG cylinder bank with firing-order animations, per-cylinder brightness variation, and throttle-colored fills (orange = power, blue = engine braking). Supports inline-4, inline-6, and V6.
- **Color token system** — all colors in `tokens.js` + CSS custom properties. Canvas/SVG code imports JS tokens; stylesheets use `var(--c-*)`.
- **Responsive layout** — works on desktop and mobile. Touch devices get on-screen shift/brake buttons and Y-axis throttle.
- **Debug overlay** — real-time bars for RPM, speed, torque, throttle, inertia, detune, shift oscillation, audio band gains, and frame timing sparkline. Toggle with backtick.

## Controls

| Input | Action |
|---|---|
| **Space** | Full throttle (WOT) |
| **Click + drag up** | Proportional throttle (mouse Y) |
| **Touch** | Throttle from Y position (top = 0%, bottom = 100%) |
| **Gamepad RT / LT** | Throttle / brake |
| **Arrow Up / Down** | Shift up / down |
| **Gamepad RB / LB** | Shift up / down |
| **S** or **B** | Brake |
| **Backtick (`)** | Toggle debug overlay |

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Choose cylinder count and layout, then **START ENGINE**.

## Tech Stack

- [Svelte 5](https://svelte.dev/) with runes (`$state`, `$derived`, `$effect`, `$props`)
- [Vite 6](https://vite.dev/)
- Web Audio API (AudioContext, ConvolverNode, OscillatorNode)
- Canvas API / SVG
- Vitest for testing

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
│   ├── drivetrain.js     — physics: torque, gears, shift oscillation
│   ├── audio.js          — 13-layer Web Audio engine + exhaust reverb
│   └── tokens.js         — color token system (JS exports + CSS vars)
│   └── __tests__/        — vitest test suites
└── main.js               — Svelte mount point
```