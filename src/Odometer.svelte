<script>
  import { onMount } from 'svelte';

  let { speed = 0 } = $props();

  const STORAGE_KEY = 'redline_km';

  let stored = parseFloat(localStorage.getItem(STORAGE_KEY));
  let km = $state(Number.isFinite(stored) ? stored : 0);

  let display = $derived(String(Math.floor(km)).padStart(6, '0') + ' KM');

  $effect(() => {
    if (Number.isFinite(km)) localStorage.setItem(STORAGE_KEY, String(km));
  });

  onMount(() => {
    let animFrameId;
    let lastTime = performance.now();

    function loop(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      if (Number.isFinite(speed) && speed > 0) {
        km += (speed / 3600) * dt; // km/h → km/s → km per frame
      }
      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameId);
  });
</script>

<div class="odometer">{display}</div>

<style>
  .odometer {
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(0.9rem, 2.5vmin, 1.4rem);
    color: var(--c-text-secondary);
    background: var(--c-bg-inset);
    padding: clamp(0.2rem, 0.8vmin, 0.4rem) clamp(0.4rem, 1.2vmin, 0.8rem);
    border: 1px solid var(--c-border-subtle);
    border-radius: 4px;
    letter-spacing: 0.15em;
    white-space: nowrap;
  }
</style>
