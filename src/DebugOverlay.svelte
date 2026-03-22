<script>
  import { onMount } from 'svelte';
  import { sparklineGrid, sparklineLine } from './engine/tokens.js';

  let { data } = $props();

  // Rolling frame time history for sparkline
  const DT_HISTORY_LEN = 60;
  let dtHistory = $state(new Array(DT_HISTORY_LEN).fill(0));
  let dtIdx = 0;
  let sparkCanvas;

  $effect(() => {
    if (!data) return;
    dtHistory[dtIdx] = data.dt * 1000; // ms
    dtIdx = (dtIdx + 1) % DT_HISTORY_LEN;
    // trigger reactivity
    dtHistory = dtHistory;
  });

  $effect(() => {
    if (!sparkCanvas) return;
    const ctx = sparkCanvas.getContext('2d');
    const w = sparkCanvas.width;
    const h = sparkCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background line at 16.67ms (60fps)
    const targetY = h - (16.67 / 33) * h;
    ctx.strokeStyle = sparklineGrid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(w, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sparkline
    ctx.strokeStyle = sparklineLine;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < DT_HISTORY_LEN; i++) {
      const idx = (dtIdx + i) % DT_HISTORY_LEN;
      const x = (i / (DT_HISTORY_LEN - 1)) * w;
      const val = Math.min(dtHistory[idx], 33);
      const y = h - (val / 33) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  function fmt(v, d = 0) {
    return typeof v === 'number' ? v.toFixed(d) : '—';
  }
</script>

<div class="debug-overlay">
  <div class="debug-title">DEBUG <span class="key-hint">`</span></div>

  <div class="debug-grid">
    <!-- Row: RPM -->
    <span class="label">RPM</span>
    <div class="bar-container">
      <div class="bar rpm-bar" class:overrev={data?.rpm > 7200} style="width: {data ? Math.min(100, (data.rpm / 9000) * 100) : 0}%"></div>
      <span class="bar-value">{fmt(data?.rpm, 0)}</span>
    </div>

    <!-- Row: Speed -->
    <span class="label">SPD</span>
    <div class="bar-container">
      <div class="bar speed-bar" style="width: {data ? Math.min(100, (data.speed / 250) * 100) : 0}%"></div>
      <span class="bar-value">{fmt(data?.speed, 1)} km/h</span>
    </div>

    <!-- Row: Torque -->
    <span class="label">TRQ</span>
    <div class="bar-container">
      <div class="bar torque-bar" style="width: {data ? Math.min(100, (data.torqueNm / 250) * 100) : 0}%"></div>
      <span class="bar-value">{fmt(data?.torqueNm, 0)} Nm</span>
    </div>

    <!-- Row: Throttle -->
    <span class="label">THR</span>
    <div class="bar-container">
      <div class="bar throttle-bar" style="width: {data ? (data.throttle || 0) * 100 : 0}%"></div>
      <span class="bar-value">{fmt(data?.throttle * 100, 0)}%</span>
    </div>

    <!-- Row: Boost -->
    <span class="label">BST</span>
    <div class="bar-container">
      <div class="bar boost-bar" style="width: {data ? Math.min(100, ((data.boostPsi || 0) / 14.7) * 100) : 0}%"></div>
      <span class="bar-value">{fmt(data?.boostPsi, 1)} psi</span>
    </div>

    <!-- Row: Gear + indicators -->
    <span class="label">GER</span>
    <div class="indicators">
      <span class="indicator gear-ind">{data?.gearLabel || 'N'}</span>
      {#if data?.throttle > 0}<span class="indicator on">THR {(data.throttle * 100).toFixed(0)}%</span>{/if}
      {#if data?.braking}<span class="indicator brake">BRK</span>{/if}
      {#if data?.revLimiterActive}<span class="indicator limiter">LIM</span>{/if}
      {#if data?.clutchHeld}<span class="indicator clutch">CLT</span>{/if}
      {#if data?.clutchEngaging}<span class="indicator shift">ENG</span>{/if}
      <span class="indicator" class:osc-active={data?.shiftOscAmplitude > 0.01}>OSC</span>
      {#if data?.bovActive}<span class="indicator bov">BOV</span>{/if}
      <span class="indicator" class:turbo-active={(data?.turboSpool || 0) > 0.1}>TRB {((data?.turboSpool || 0) * 100).toFixed(0)}%</span>
    </div>

    <!-- Row: Shift oscillation -->
    <span class="label">OSC</span>
    <div class="bar-container osc-bar-container">
      <div class="bar osc-bar" style="width: {Math.abs(data?.shiftOscillation || 0) * 50}%; left: {(data?.shiftOscillation || 0) < 0 ? 50 + (data?.shiftOscillation || 0) * 50 : 50}%"></div>
      <span class="bar-value">{fmt(data?.shiftOscAmplitude, 2)}</span>
    </div>

    <!-- Row: Inertia -->
    <span class="label">J</span>
    <div class="bar-container">
      <div class="bar inertia-bar" style="width: {data ? Math.min(100, (data.effectiveInertia / 7) * 100) : 0}%"></div>
      <span class="bar-value">{fmt(data?.effectiveInertia, 2)} kg·m²</span>
    </div>

    <!-- Row: Detune -->
    <span class="label">DET</span>
    <div class="bar-container">
      <div class="bar pbr-bar" style="width: {data ? Math.min(100, (data.detune / 1400) * 100) : 0}%"></div>
      <span class="bar-value">{fmt(data?.detune, 0)} ¢</span>
    </div>
  </div>

  <!-- Audio band gains -->
  <div class="debug-subtitle">AUDIO BANDS</div>
  <div class="band-bars">
    {#each Object.entries(data?.bandGains || {}) as [name, val]}
      <div class="band-row">
        <span class="band-label">{name}</span>
        <div class="band-track">
          <div class="band-fill" style="width: {(val || 0) * 100}%"></div>
        </div>
        <span class="band-val">{(val || 0).toFixed(2)}</span>
      </div>
    {/each}
  </div>

  <!-- Frame timing sparkline -->
  <div class="debug-subtitle">FRAME <span class="dt-val">{fmt(data?.dt * 1000, 1)} ms</span></div>
  <canvas bind:this={sparkCanvas} width="160" height="32" class="sparkline"></canvas>
</div>

<style>
  .debug-overlay {
    position: absolute;
    top: 44px;
    right: 12px;
    background: var(--c-bg-overlay);
    border: 1px solid var(--c-bg-panel);
    border-radius: 6px;
    padding: 10px 12px;
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(0.5rem, 1.2vmin, 0.65rem);
    color: var(--c-text-muted);
    min-width: min(220px, 45vw);
    max-width: min(280px, 50vw);
    z-index: 100;
    pointer-events: none;
  }

  .debug-title {
    font-size: 0.6rem;
    color: var(--c-text-ghost);
    letter-spacing: 0.2em;
    margin-bottom: 6px;
    text-transform: uppercase;
  }
  .key-hint {
    color: var(--c-text-disabled);
    font-size: 0.55rem;
  }

  .debug-grid {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 3px 6px;
    align-items: center;
  }

  .label {
    color: var(--c-text-subtle);
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .bar-container {
    position: relative;
    height: 12px;
    background: var(--c-bg-panel);
    border-radius: 2px;
    overflow: hidden;
  }

  .bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.05s linear;
  }

  .rpm-bar { background: var(--c-bar-rpm); }
  .rpm-bar.overrev { background: #ff3030; }
  .speed-bar { background: var(--c-bar-speed); }
  .torque-bar { background: var(--c-bar-torque); }
  .throttle-bar { background: var(--c-bar-throttle, #4caf50); }
  .inertia-bar { background: var(--c-bar-inertia); }
  .pbr-bar { background: var(--c-bar-pbr); }
  .boost-bar { background: var(--c-bar-boost, #ce93d8); }

  .bar-value {
    position: absolute;
    right: 4px;
    top: 0;
    line-height: 12px;
    font-size: 0.55rem;
    color: var(--c-text-secondary);
    text-shadow: 0 0 3px #000;
  }

  .indicators {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .indicator {
    padding: 1px 5px;
    border-radius: 2px;
    font-size: 0.55rem;
    letter-spacing: 0.05em;
    background: var(--c-bg-panel);
    color: var(--c-text-dim);
  }
  .gear-ind { color: var(--c-accent); font-weight: bold; font-size: 0.7rem; }
  .on { background: var(--c-status-on-bg); color: var(--c-status-on); }
  .brake { background: var(--c-status-brake-bg); color: var(--c-status-brake); }
  .limiter { background: var(--c-status-limiter-bg); color: var(--c-status-limiter); }
  .clutch { background: #1a2a15; color: #b4ff64; }
  .shift { background: var(--c-status-shift-bg); color: var(--c-status-shift); }
  .osc-active { background: var(--c-status-osc-bg); color: var(--c-status-osc); }
  .bov { background: var(--c-status-turbo-bg, #2a1b3a); color: var(--c-status-turbo, #ce93d8); }
  .turbo-active { background: var(--c-status-turbo-bg, #2a1b3a); color: var(--c-status-turbo, #ce93d8); }

  .osc-bar-container { background: var(--c-bg-panel); }
  .osc-bar { background: var(--c-status-osc); position: absolute; height: 100%; transition: none; }

  .debug-subtitle {
    font-size: 0.55rem;
    color: var(--c-text-ghost);
    letter-spacing: 0.15em;
    text-transform: uppercase;
    margin-top: 8px;
    margin-bottom: 3px;
  }
  .dt-val {
    color: var(--c-status-on);
    letter-spacing: 0;
  }

  .band-bars {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .band-row {
    display: grid;
    grid-template-columns: 50px 1fr 30px;
    gap: 4px;
    align-items: center;
  }

  .band-label {
    font-size: 0.5rem;
    color: var(--c-text-subtle);
    text-align: right;
    text-transform: uppercase;
  }

  .band-track {
    height: 8px;
    background: var(--c-bg-panel);
    border-radius: 2px;
    overflow: hidden;
  }

  .band-fill {
    height: 100%;
    background: var(--c-bar-torque);
    border-radius: 2px;
    transition: width 0.05s linear;
  }

  .band-val {
    font-size: 0.5rem;
    color: var(--c-text-faint);
  }

  .sparkline {
    display: block;
    width: 100%;
    height: 32px;
    background: var(--c-bg-inset);
    border-radius: 2px;
  }
</style>
