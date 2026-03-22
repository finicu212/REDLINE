<script>
  import { onMount } from 'svelte';
  import {
    cylIdle, cylPower, cylPowerStroke, cylPowerGlow,
    cylBrake, cylBrakeStroke, cylBrakeGlow,
    cylFiringOn, cylFiringOff, borderMid,
  } from './engine/tokens.js';

  let { rpm = 850, cylinders = 4, layout = 'inline', throttle = 0 } = $props();

  const FIRING_ORDERS = {
    4: [0, 2, 3, 1],
    6: [0, 3, 1, 4, 2, 5],
  };

  let firingStates = $state([false, false, false, false, false, false]);

  let positions = $derived(getCylinderPositions(cylinders, layout));
  let svgWidth = $derived(layout === 'v' && cylinders === 6 ? 280 : 30 + cylinders * 70);
  let svgHeight = $derived(layout === 'v' ? PAD * 2 + CYL_H + V_GAP : PAD * 2 + CYL_H);

  const PAD = 34;
  const CYL_H = 60;
  const V_GAP = 80;

  // Colors — from tokens
  const COL_IDLE = cylIdle;
  const COL_POWER = cylPower;
  const COL_POWER_STROKE = cylPowerStroke;
  const COL_POWER_GLOW = cylPowerGlow;
  const COL_BRAKE = cylBrake;
  const COL_BRAKE_STROKE = cylBrakeStroke;
  const COL_BRAKE_GLOW = cylBrakeGlow;

  function getCylinderPositions(count, lay) {
    const p = [];
    if (lay === 'v' && count === 6) {
      const centerY = PAD + CYL_H / 2 + V_GAP / 2;
      for (let i = 0; i < 3; i++) {
        p.push({ x: 60 + i * 70, y: centerY - V_GAP / 2, angle: -12 });
        p.push({ x: 60 + i * 70, y: centerY + V_GAP / 2, angle: 12 });
      }
    } else {
      for (let i = 0; i < count; i++) {
        p.push({ x: 30 + i * 70, y: PAD + CYL_H / 2, angle: 0 });
      }
    }
    return p;
  }

  function getFiringColor(firing) {
    if (!firing) return { fill: COL_IDLE, stroke: borderMid, glow: '' };
    if (throttle > 0.1) return { fill: COL_POWER, stroke: COL_POWER_STROKE, glow: `filter: drop-shadow(0 0 12px ${COL_POWER_GLOW})` };
    return { fill: COL_BRAKE, stroke: COL_BRAKE_STROKE, glow: `filter: drop-shadow(0 0 10px ${COL_BRAKE_GLOW})` };
  }

  onMount(() => {
    let animFrameId;
    let lastFireTime = 0;
    let firingIndex = 0;

    function loop(now) {
      const order = FIRING_ORDERS[cylinders] || FIRING_ORDERS[4];
      const interval = 60000 / rpm / (cylinders / 2);
      const flashDuration = Math.max(30, interval * 0.3);

      if (now - lastFireTime >= interval) {
        const cylIdx = order[firingIndex % order.length];
        firingStates[cylIdx] = true;
        setTimeout(() => {
          firingStates[cylIdx] = false;
        }, flashDuration);
        firingIndex++;
        lastFireTime = now;
      }

      animFrameId = requestAnimationFrame(loop);
    }
    lastFireTime = performance.now();
    animFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameId);
  });
</script>

<svg class="cylinder-svg" style="max-width: {svgWidth}px" viewBox="0 0 {svgWidth} {svgHeight}">
  {#each positions as pos, i}
    {@const col = getFiringColor(firingStates[i])}
    <g transform="translate({pos.x}, {pos.y}) rotate({pos.angle})">
      <rect
        x="-22"
        y="-30"
        width="44"
        height="60"
        rx="6"
        ry="6"
        fill={col.fill}
        stroke={col.stroke}
        stroke-width="2"
        style={col.glow}
      />
      <text
        x="0"
        y="4"
        text-anchor="middle"
        fill={firingStates[i] ? cylFiringOn : cylFiringOff}
        font-size="12"
        font-family="Share Tech Mono, monospace"
      >
        {i + 1}
      </text>
    </g>
  {/each}
</svg>

<style>
  .cylinder-svg {
    width: clamp(180px, 60vw, 100%);
    height: auto;
  }
</style>
