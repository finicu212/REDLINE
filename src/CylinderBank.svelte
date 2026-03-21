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
  let svgHeight = $derived(layout === 'v' ? 180 : 140);

  function getCylinderPositions(count, lay) {
    const p = [];
    if (lay === 'v' && count === 6) {
      for (let i = 0; i < 3; i++) {
        p.push({ x: 60 + i * 70, y: 20, angle: -12 });
        p.push({ x: 60 + i * 70, y: 100, angle: 12 });
      }
    } else {
      for (let i = 0; i < count; i++) {
        p.push({ x: 30 + i * 70, y: 50, angle: 0 });
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
