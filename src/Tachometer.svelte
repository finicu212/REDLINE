<script>
  import { onMount } from 'svelte';
  import { TACHO_MAX_RPM, TACHO_REDLINE_RPM } from './engine/constants.js';
  import {
    tachoBlack, tachoDark, tachoWhite, tachoDim,
    tachoNeedle, tachoNeedleGlow, tachoRed, tachoRedDim,
    tachoTickMid, tachoInnerRing, tachoGrid,
  } from './engine/tokens.js';

  let { rpm = 850 } = $props();

  let canvasEl;
  let containerEl;

  const SIZE = 280;
  const CENTER = SIZE / 2;
  const RADIUS = SIZE / 2 - 20;

  const DIAL_MAX = TACHO_MAX_RPM;
  const TICK_COUNT = DIAL_MAX / 1000;

  // Sweep: 225° (bottom-left) to -45° (bottom-right) = 270° arc
  const START_ANGLE = (225 * Math.PI) / 180;
  const SWEEP = (270 * Math.PI) / 180;

  // Needle smoothing: limited angular velocity (max RPM/s the needle can track)
  const NEEDLE_MAX_RPM_PER_SEC = 12000; // needle can traverse full range in ~0.6s
  let smoothedRPM = 850;

  function rpmToAngle(r) {
    return START_ANGLE - (Math.min(r, DIAL_MAX) / DIAL_MAX) * SWEEP;
  }

  // Honda EK color palette — from tokens
  const EK_BLACK = tachoBlack;
  const EK_DARK = tachoDark;
  const EK_WHITE = tachoWhite;
  const EK_DIM = tachoDim;
  const EK_NEEDLE = tachoNeedle;
  const EK_NEEDLE_GLOW = tachoNeedleGlow;
  const EK_RED = tachoRed;
  const EK_RED_DIM = tachoRedDim;

  function drawTacho(ctx, dt) {
    // Smooth the needle: chase target RPM with limited speed
    const diff = rpm - smoothedRPM;
    const maxStep = NEEDLE_MAX_RPM_PER_SEC * dt;
    if (Math.abs(diff) > maxStep) {
      smoothedRPM += Math.sign(diff) * maxStep;
    } else {
      smoothedRPM = rpm;
    }

    ctx.clearRect(0, 0, SIZE + 1, SIZE + 1);

    // --- Outer ring ---
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS + 4, 0, Math.PI * 2);
    ctx.fillStyle = EK_DARK;
    ctx.fill();
    ctx.strokeStyle = tachoGrid;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // --- Dial face ---
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = EK_BLACK;
    ctx.fill();

    // --- Red zone arc (filled wedge) ---
    const redStartAngle = -(rpmToAngle(DIAL_MAX));
    const redEndAngle = -(rpmToAngle(TACHO_REDLINE_RPM));
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS - 2, redEndAngle, redStartAngle);
    ctx.arc(CENTER, CENTER, RADIUS - 16, redStartAngle, redEndAngle, true);
    ctx.closePath();
    ctx.fillStyle = EK_RED_DIM;
    ctx.fill();

    // --- Minor tick marks (every 500 RPM) ---
    for (let i = 0; i <= DIAL_MAX / 500; i++) {
      const tickRPM = i * 500;
      const isMajor = tickRPM % 1000 === 0;
      if (isMajor) continue; // drawn separately below

      const frac = tickRPM / DIAL_MAX;
      const angle = START_ANGLE - frac * SWEEP;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const inner = RADIUS - 10;
      const outer = RADIUS - 4;

      ctx.beginPath();
      ctx.moveTo(CENTER + inner * cos, CENTER - inner * sin);
      ctx.lineTo(CENTER + outer * cos, CENTER - outer * sin);
      ctx.strokeStyle = tickRPM >= TACHO_REDLINE_RPM ? EK_RED : tachoTickMid;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- Major tick marks + numbers (every 1000 RPM) ---
    for (let i = 0; i <= TICK_COUNT; i++) {
      const tickRPM = i * 1000;
      const frac = tickRPM / DIAL_MAX;
      const angle = START_ANGLE - frac * SWEEP;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const inRedzone = tickRPM >= TACHO_REDLINE_RPM;

      // Tick line
      const inner = RADIUS - 18;
      const outer = RADIUS - 4;
      ctx.beginPath();
      ctx.moveTo(CENTER + inner * cos, CENTER - inner * sin);
      ctx.lineTo(CENTER + outer * cos, CENTER - outer * sin);
      ctx.strokeStyle = inRedzone ? EK_RED : EK_WHITE;
      ctx.lineWidth = inRedzone ? 2.5 : 2;
      ctx.stroke();

      // Number label
      ctx.fillStyle = inRedzone ? EK_RED : EK_WHITE;
      ctx.font = 'bold 13px Share Tech Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelR = RADIUS - 30;
      ctx.fillText(String(i), CENTER + labelR * cos, CENTER - labelR * sin);
    }

    // --- Center text ---
    ctx.fillStyle = EK_DIM;
    ctx.font = '9px Share Tech Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('RPM', CENTER, CENTER + 22);
    ctx.fillText('x1000', CENTER, CENTER + 33);

    // --- Needle (yellow-orange, EK style) ---
    const angle = rpmToAngle(smoothedRPM);
    const needleLen = RADIUS - 26;
    const tailLen = 14; // counterweight behind pivot
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Needle shadow/glow
    ctx.save();
    ctx.shadowColor = EK_NEEDLE_GLOW;
    ctx.shadowBlur = 10;

    // Main needle body (tapered)
    ctx.beginPath();
    const perpX = -sinA * 1.5;
    const perpY = cosA * 1.5;
    // Tip
    ctx.moveTo(CENTER + needleLen * cosA, CENTER - needleLen * sinA);
    // Base left
    ctx.lineTo(CENTER + perpX - tailLen * cosA, CENTER - perpY + tailLen * sinA);
    // Base right
    ctx.lineTo(CENTER - perpX - tailLen * cosA, CENTER + perpY + tailLen * sinA);
    ctx.closePath();
    ctx.fillStyle = EK_NEEDLE;
    ctx.fill();

    ctx.restore();

    // Center cap (dark with bright rim)
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 7, 0, Math.PI * 2);
    ctx.fillStyle = tachoInnerRing;
    ctx.fill();
    ctx.strokeStyle = EK_NEEDLE;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = EK_NEEDLE;
    ctx.fill();
  }

  function updateCanvasSize() {
    if (!containerEl || !canvasEl) return;
    const rect = containerEl.getBoundingClientRect();
    const cssSize = Math.min(rect.width, rect.height);
    const dpr = window.devicePixelRatio || 1;
    const bufferSize = Math.round(cssSize * dpr);
    canvasEl.width = bufferSize;
    canvasEl.height = bufferSize;
    canvasEl.style.width = cssSize + 'px';
    canvasEl.style.height = cssSize + 'px';
  }

  onMount(() => {
    updateCanvasSize();
    const ro = new ResizeObserver(updateCanvasSize);
    ro.observe(containerEl);

    let animFrameId;
    let lastTime = performance.now();

    function frame(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const ctx = canvasEl.getContext('2d');
      const scale = canvasEl.width / SIZE;
      ctx.save();
      ctx.scale(scale, scale);
      drawTacho(ctx, Math.min(dt, 0.05));
      ctx.restore();
      animFrameId = requestAnimationFrame(frame);
    }
    animFrameId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(animFrameId);
      ro.disconnect();
    };
  });
</script>

<div bind:this={containerEl} class="tachometer-container">
  <canvas bind:this={canvasEl} class="tachometer"></canvas>
</div>

<style>
  .tachometer-container {
    width: clamp(160px, 28vmin, 280px);
    aspect-ratio: 1;
  }

  .tachometer {
    display: block;
  }

  @media (max-width: 600px) {
    .tachometer-container {
      width: clamp(100px, 22vmin, 160px);
    }
  }
</style>
