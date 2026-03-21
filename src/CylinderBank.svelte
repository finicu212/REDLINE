<script>
  import { onMount } from 'svelte';

  let { rpm = 850, cylinders = 4, layout = 'inline' } = $props();

  const FIRING_ORDERS = {
    4: [0, 2, 3, 1],
    6: [0, 3, 1, 4, 2, 5],
  };

  let firingStates = $state([false, false, false, false, false, false]);

  let positions = $derived(getCylinderPositions(cylinders, layout));
  let svgWidth = $derived(layout === 'v' && cylinders === 6 ? 280 : 30 + cylinders * 70);
  // Inline: PAD + CYL_H + PAD. V-layout: PAD + CYL_H/2 + V_GAP + CYL_H/2 + PAD
  let svgHeight = $derived(layout === 'v' ? PAD * 2 + CYL_H + V_GAP : PAD * 2 + CYL_H);

  // Cylinder rect is 60px tall centered at origin (y=-30 to y=+30).
  // Padding = 34px ensures glow filter + rect edges stay inside the viewBox.
  const PAD = 34;
  const CYL_H = 60;
  const V_GAP = 80; // vertical distance between V-layout row centers

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

<svg width={svgWidth} height={svgHeight} viewBox="0 0 {svgWidth} {svgHeight}">
  {#each positions as pos, i}
    <g transform="translate({pos.x}, {pos.y}) rotate({pos.angle})">
      <rect
        x="-22"
        y="-30"
        width="44"
        height="60"
        rx="6"
        ry="6"
        fill={firingStates[i] ? '#ff4020' : '#2a2a3e'}
        stroke={firingStates[i] ? '#ff6040' : '#444'}
        stroke-width="2"
        style={firingStates[i]
          ? 'filter: drop-shadow(0 0 12px rgba(255, 64, 32, 0.8))'
          : ''}
      />
      <text
        x="0"
        y="4"
        text-anchor="middle"
        fill={firingStates[i] ? '#fff' : '#666'}
        font-size="12"
        font-family="Share Tech Mono, monospace"
      >
        {i + 1}
      </text>
    </g>
  {/each}
</svg>
