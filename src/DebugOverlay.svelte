<script>
  import { onMount } from 'svelte';

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
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(w, targetY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sparkline
    ctx.strokeStyle = '#4caf50';
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
      <div class="bar rpm-bar" style="width: {data ? Math.min(100, (data.rpm / 7200) * 100) : 0}%"></div>
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

    <!-- Row: Gear + indicators -->
    <span class="label">GER</span>
    <div class="indicators">
      <span class="indicator gear-ind">{data?.gearLabel || 'N'}</span>
      {#if data?.throttle > 0}<span class="indicator on">THR {(data.throttle * 100).toFixed(0)}%</span>{/if}
      {#if data?.braking}<span class="indicator brake">BRK</span>{/if}
      {#if data?.revLimiterActive}<span class="indicator limiter">LIM</span>{/if}
      {#if data?.shifting}<span class="indicator shift">SHF</span>{/if}
      <span class="indicator" class:osc-active={data?.shiftOscAmplitude > 0.01}>OSC</span>
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
    top: 12px;
    right: 12px;
    background: rgba(10, 10, 20, 0.88);
    border: 1px solid #2a2a3e;
    border-radius: 6px;
    padding: 10px 12px;
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(0.5rem, 1.2vmin, 0.65rem);
    color: #999;
    min-width: min(220px, 45vw);
    max-width: min(280px, 50vw);
    z-index: 100;
    pointer-events: none;
  }

  .debug-title {
    font-size: 0.6rem;
    color: #555;
    letter-spacing: 0.2em;
    margin-bottom: 6px;
    text-transform: uppercase;
  }
  .key-hint {
    color: #444;
    font-size: 0.55rem;
  }

  .debug-grid {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 3px 6px;
    align-items: center;
  }

  .label {
    color: #666;
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .bar-container {
    position: relative;
    height: 12px;
    background: #1a1a2e;
    border-radius: 2px;
    overflow: hidden;
  }

  .bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.05s linear;
  }

  .rpm-bar { background: #ff4020; }
  .speed-bar { background: #2196f3; }
  .torque-bar { background: #ff9800; }
  .throttle-bar { background: #4caf50; }
  .inertia-bar { background: #9c27b0; }
  .pbr-bar { background: #4caf50; }

  .bar-value {
    position: absolute;
    right: 4px;
    top: 0;
    line-height: 12px;
    font-size: 0.55rem;
    color: #ccc;
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
    background: #1a1a2e;
    color: #888;
  }
  .gear-ind { color: #ff4020; font-weight: bold; font-size: 0.7rem; }
  .on { background: #1b3a1b; color: #4caf50; }
  .brake { background: #3a1b1b; color: #ff6060; }
  .limiter { background: #3a1b1b; color: #ff4020; }
  .shift { background: #3a3a1b; color: #ffc107; }
  .osc-active { background: #1b2a3a; color: #42a5f5; }

  .osc-bar-container { background: #1a1a2e; }
  .osc-bar { background: #42a5f5; position: absolute; height: 100%; transition: none; }

  .debug-subtitle {
    font-size: 0.55rem;
    color: #555;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    margin-top: 8px;
    margin-bottom: 3px;
  }
  .dt-val {
    color: #4caf50;
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
    color: #666;
    text-align: right;
    text-transform: uppercase;
  }

  .band-track {
    height: 8px;
    background: #1a1a2e;
    border-radius: 2px;
    overflow: hidden;
  }

  .band-fill {
    height: 100%;
    background: #ff9800;
    border-radius: 2px;
    transition: width 0.05s linear;
  }

  .band-val {
    font-size: 0.5rem;
    color: #777;
  }

  .sparkline {
    display: block;
    width: 100%;
    height: 32px;
    background: #111;
    border-radius: 2px;
  }
</style>
