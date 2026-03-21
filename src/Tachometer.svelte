<script>
  import { onMount } from 'svelte';

  let { rpm = 850 } = $props();

  let canvasEl;

  const SIZE = 240;
  const CENTER = SIZE / 2;
  const RADIUS = SIZE / 2 - 16;
  const MAX_RPM = 9000;
  const REDLINE_RPM = 7500;

  const START_ANGLE = (225 * Math.PI) / 180;
  const END_ANGLE = (-45 * Math.PI) / 180;
  const SWEEP = START_ANGLE - END_ANGLE;

  function rpmToAngle(r) {
    return START_ANGLE - (Math.min(r, MAX_RPM) / MAX_RPM) * SWEEP;
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
    for (let i = 0; i <= 9; i++) {
      const r = (i * 1000) / MAX_RPM;
      const angle = START_ANGLE - r * SWEEP;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const inner = RADIUS - 20;
      const outer = RADIUS - 6;

      ctx.beginPath();
      ctx.moveTo(CENTER + inner * cos, CENTER - inner * sin);
      ctx.lineTo(CENTER + outer * cos, CENTER - outer * sin);
      ctx.strokeStyle = i * 1000 >= REDLINE_RPM ? '#ff4020' : '#ccc';
      ctx.lineWidth = i * 1000 >= REDLINE_RPM ? 3 : 2;
      ctx.stroke();

      ctx.fillStyle = i * 1000 >= REDLINE_RPM ? '#ff4020' : '#999';
      ctx.font = '10px Share Tech Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelR = RADIUS - 32;
      ctx.fillText(String(i), CENTER + labelR * cos, CENTER - labelR * sin);
    }

    // Red zone arc
    const redStart = rpmToAngle(MAX_RPM);
    const redEnd = rpmToAngle(REDLINE_RPM);
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
