<script>
  import { onMount } from 'svelte';

  let { rpm = 850 } = $props();

  const MAX_RPM = 9000;
  const STORAGE_KEY = 'redline_km';

  let km = $state(parseFloat(localStorage.getItem(STORAGE_KEY)) || 0);

  let display = $derived(String(Math.floor(km)).padStart(6, '0') + ' KM');

  $effect(() => {
    localStorage.setItem(STORAGE_KEY, String(km));
  });

  onMount(() => {
    let animFrameId;
    function loop() {
      if (rpm > 1000) {
        km += (rpm / MAX_RPM) * 0.0003;
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
