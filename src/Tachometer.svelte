<script>
  import { onMount } from 'svelte';
  import { TACHO_MAX_RPM, TACHO_REDLINE_RPM } from './engine/constants.js';

  let { rpm = 850 } = $props();

  let canvasEl;

  const SIZE = 240;
  const CENTER = SIZE / 2;
  const RADIUS = SIZE / 2 - 16;

  // Dial goes to 8000, tick marks every 1000
  const DIAL_MAX = TACHO_MAX_RPM;
  const TICK_COUNT = DIAL_MAX / 1000;

  const START_ANGLE = (225 * Math.PI) / 180;
  const END_ANGLE = (-45 * Math.PI) / 180;
  const SWEEP = START_ANGLE - END_ANGLE;

  function rpmToAngle(r) {
    return START_ANGLE - (Math.min(r, DIAL_MAX) / DIAL_MAX) * SWEEP;
  }

  function drawTacho(ctx) {
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Dial face
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Tick marks
    for (let i = 0; i <= TICK_COUNT; i++) {
      const tickRPM = i * 1000;
      const r = tickRPM / DIAL_MAX;
      const angle = START_ANGLE - r * SWEEP;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const inner = RADIUS - 20;
      const outer = RADIUS - 6;
      const inRedzone = tickRPM >= TACHO_REDLINE_RPM;

      ctx.beginPath();
      ctx.moveTo(CENTER + inner * cos, CENTER - inner * sin);
      ctx.lineTo(CENTER + outer * cos, CENTER - outer * sin);
      ctx.strokeStyle = inRedzone ? '#ff4020' : '#ccc';
      ctx.lineWidth = inRedzone ? 3 : 2;
      ctx.stroke();

      ctx.fillStyle = inRedzone ? '#ff4020' : '#999';
      ctx.font = '10px Share Tech Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelR = RADIUS - 32;
      ctx.fillText(String(i), CENTER + labelR * cos, CENTER - labelR * sin);
    }

    // Red zone arc
    const redStart = rpmToAngle(DIAL_MAX);
    const redEnd = rpmToAngle(TACHO_REDLINE_RPM);
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS - 10, -redStart, -redEnd);
    ctx.strokeStyle = 'rgba(255, 64, 32, 0.3)';
    ctx.lineWidth = 6;
    ctx.stroke();

    // RPM label
    ctx.fillStyle = '#666';
    ctx.font = '10px Share Tech Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('RPM x1000', CENTER, CENTER + 30);

    // REDLINE label
    ctx.fillStyle = '#ff4020';
    ctx.font = 'bold 9px Share Tech Mono, monospace';
    ctx.fillText('REDLINE', CENTER, CENTER + 44);

    // Needle
    const angle = rpmToAngle(rpm);
    const needleLen = RADIUS - 24;
    ctx.beginPath();
    ctx.moveTo(CENTER, CENTER);
    ctx.lineTo(CENTER + needleLen * Math.cos(angle), CENTER - needleLen * Math.sin(angle));
    ctx.strokeStyle = '#ff4020';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(255, 64, 32, 0.6)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center cap
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4020';
    ctx.fill();
  }

  onMount(() => {
    const ctx = canvasEl.getContext('2d');
    let animFrameId;
    function frame() {
      drawTacho(ctx);
      animFrameId = requestAnimationFrame(frame);
    }
    animFrameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animFrameId);
  });
</script>

<canvas bind:this={canvasEl} width={SIZE} height={SIZE} class="tachometer"></canvas>

<style>
  .tachometer {
    display: block;
  }
</style>
