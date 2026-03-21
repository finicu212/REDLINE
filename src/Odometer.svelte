<script>
  import { onMount } from 'svelte';

  let { speed = 0 } = $props();

  const STORAGE_KEY = 'redline_km';

  let km = $state(parseFloat(localStorage.getItem(STORAGE_KEY)) || 0);

  let display = $derived(String(Math.floor(km)).padStart(6, '0') + ' KM');

  $effect(() => {
    localStorage.setItem(STORAGE_KEY, String(km));
  });

  onMount(() => {
    let animFrameId;
    let lastTime = performance.now();

    function loop(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      if (speed > 0) {
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
    font-size: 1.4rem;
    color: #ccc;
    background: #111;
    padding: 0.4rem 0.8rem;
    border: 1px solid #333;
    border-radius: 4px;
    letter-spacing: 0.15em;
  }
</style>
