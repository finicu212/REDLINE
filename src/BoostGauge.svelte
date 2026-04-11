<script>
  import { tachoBlack, tachoDark, tachoWhite, tachoDim, tachoNeedle, tachoGrid, cylBrake, accent } from './engine/tokens.js';

  // bar gauge (BeamNG-style): vacuum below zero, boost above
  let { bar = 0, minBar = -1, maxBar = 1.5 } = $props();

  const SIZE = 120;
  const C = SIZE / 2;
  const R = SIZE / 2 - 10;
  // 270° sweep, same orientation as the tachometer (min at bottom-left)
  const START = 225;
  const SWEEP = 270;

  const clamp = v => Math.max(minBar, Math.min(maxBar, v));
  const angleOf = v => START - ((clamp(v) - minBar) / (maxBar - minBar)) * SWEEP;
  const pt = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return [C + r * Math.cos(a), C - r * Math.sin(a)];
  };
  function arc(v0, v1, r) {
    const a0 = angleOf(v0), a1 = angleOf(v1);
    const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
    const large = Math.abs(a0 - a1) > 180 ? 1 : 0;
    const sweep = a0 > a1 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
  }

  const ticks = [];
  for (let v = minBar; v <= maxBar + 1e-9; v += 0.25) {
    const major = Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
    ticks.push({ v, major, zero: Math.abs(v) < 1e-9 });
  }

  let needle = $derived(pt(angleOf(bar), R - 12));
  let fillPath = $derived(Math.abs(bar) < 0.01 ? '' : arc(0, bar, R - 4));
</script>

<div class="boost-gauge">
  <svg viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="Boost {bar.toFixed(2)} bar">
    <circle cx={C} cy={C} r={R + 4} fill={tachoDark} stroke={tachoGrid} stroke-width="1.5" />
    <circle cx={C} cy={C} r={R} fill={tachoBlack} />

    <path d={arc(minBar, maxBar, R - 4)} stroke={tachoGrid} stroke-width="4" fill="none" />
    {#if fillPath}
      <path d={fillPath} stroke={bar < 0 ? cylBrake : accent} stroke-width="4" fill="none" stroke-linecap="butt" />
    {/if}

    {#each ticks as t}
      {@const [x0, y0] = pt(angleOf(t.v), R - (t.major ? 12 : 9))}
      {@const [x1, y1] = pt(angleOf(t.v), R - 6)}
      <line x1={x0} y1={y0} x2={x1} y2={y1}
        stroke={t.zero ? tachoWhite : tachoDim} stroke-width={t.zero ? 2 : t.major ? 1.2 : 0.8} />
      {#if t.major}
        {@const [lx, ly] = pt(angleOf(t.v), R - 20)}
        <text x={lx} y={ly} class="tick-label" fill={t.zero ? tachoWhite : tachoDim}>{t.v}</text>
      {/if}
    {/each}

    <line x1={C} y1={C} x2={needle[0]} y2={needle[1]} stroke={tachoNeedle} stroke-width="2" stroke-linecap="round" />
    <circle cx={C} cy={C} r="4" fill={tachoDark} stroke={tachoNeedle} stroke-width="1" />

    <text x={C} y={C + 38} class="readout" fill={tachoWhite}>{bar >= 0 ? '+' : ''}{bar.toFixed(2)}</text>
    <text x={C} y={C + 46} class="unit" fill={tachoDim}>BAR</text>
  </svg>
</div>

<style>
  .boost-gauge {
    width: clamp(100px, 17vmin, 150px);
    aspect-ratio: 1;
  }

  svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .tick-label {
    font-family: 'Share Tech Mono', monospace;
    font-size: 8px;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .readout {
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    text-anchor: middle;
  }

  .unit {
    font-family: 'Share Tech Mono', monospace;
    font-size: 6px;
    letter-spacing: 0.15em;
    text-anchor: middle;
  }
</style>
