# REDLINE

Browser-based engine simulator with realistic drivetrain physics, layered audio synthesis, and an interactive manual transmission.

## Features

- **Drivetrain physics** - torque curve interpolation, angular acceleration model, rev limiter with fuel-cut hysteresis, and over-rev protection on downshifts. Gear ratios based on the Honda S2000 AP1 gearbox.
- **Engine audio** - Web Audio API with multi-layer frequency-band samples (low/mid/high) that crossfade based on RPM. Separate sample sets for throttle-on and throttle-off (engine braking).
- **Analog tachometer** - canvas-rendered dial with redline arc, sweep needle, and glow effects.
- **Cylinder visualization** - SVG cylinder bank with firing-order animations. Supports inline-4, inline-6, and V6 layouts.
- **Speedometer & gear indicator** - live km/h readout and current gear display.

## Controls

| Input | Action |
|---|---|
| Hold **Space** or **Click** | Rev the engine |
| **Up Arrow** | Shift up |
| **Down Arrow** | Shift down |

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in your browser. Choose your cylinder count and layout, then hit **START ENGINE**.

## Tech Stack

- [Svelte 5](https://svelte.dev/) with runes (`$state`, `$derived`, `$props`)
- [Vite 6](https://vite.dev/)
- Web Audio API
- Canvas API / SVG

## Project Structure

```
src/
  App.svelte            # Screen router (customizer / sim)
  Customizer.svelte     # Engine config menu + audio loader
  Sim.svelte            # Main simulation loop + HUD layout
  Tachometer.svelte     # Canvas-rendered analog tachometer
  CylinderBank.svelte   # SVG cylinder firing visualization
  Odometer.svelte       # Speed display
  GearIndicator.svelte  # Current gear display
  engine/
    constants.js        # Shared RPM limits and helpers
    drivetrain.js       # Physics simulation (torque, inertia, gears)
    audio.js            # Web Audio engine sound synthesis
```