<script>
  import Customizer from './Customizer.svelte';
  import Sim from './Sim.svelte';

  let screen = $state('customizer');
  let engineConfig = $state({});

  function handleStart(config) {
    engineConfig = config;
    screen = 'sim';
  }
</script>

<main>
  {#if screen === 'customizer'}
    <Customizer onstart={handleStart} />
  {:else}
    <Sim config={engineConfig} />
  {/if}
</main>

<style>
  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(:root) {
    /* Core palette */
    --c-accent: #ff4020;
    --c-accent-glow: rgba(255, 64, 32, 0.4);
    --c-accent-dim: rgba(255, 64, 32, 0.1);
    --c-accent-glow-strong: rgba(255, 64, 32, 0.5);

    /* Surfaces */
    --c-bg-deep: #0f0f1a;
    --c-bg-panel: #1a1a2e;
    --c-bg-inset: #111;
    --c-bg-overlay: rgba(10, 10, 20, 0.88);

    /* Borders */
    --c-border-subtle: #333;
    --c-border-mid: #444;
    --c-border-focus: #555;

    /* Text */
    --c-text-primary: #eee;
    --c-text-secondary: #ccc;
    --c-text-muted: #999;
    --c-text-dim: #888;
    --c-text-faint: #777;
    --c-text-subtle: #666;
    --c-text-ghost: #555;
    --c-text-disabled: #444;

    /* Debug bars */
    --c-bar-rpm: #ff4020;
    --c-bar-speed: #2196f3;
    --c-bar-torque: #ff9800;
    --c-bar-inertia: #9c27b0;
    --c-bar-pbr: #4caf50;

    /* Status pills */
    --c-status-on-bg: #1b3a1b;
    --c-status-on: #4caf50;
    --c-status-brake-bg: #3a1b1b;
    --c-status-brake: #ff6060;
    --c-status-limiter-bg: #3a1b1b;
    --c-status-limiter: #ff4020;
    --c-status-shift-bg: #3a3a1b;
    --c-status-shift: #ffc107;
    --c-status-osc-bg: #1b2a3a;
    --c-status-osc: #42a5f5;

    /* Turbo */
    --c-bar-boost: #ce93d8;
    --c-status-turbo-bg: #2a1b3a;
    --c-status-turbo: #ce93d8;
  }

  :global(body) {
    background: var(--c-bg-deep);
    color: var(--c-text-primary);
    font-family: 'Share Tech Mono', monospace;
    overflow: hidden;
    height: 100vh;
    width: 100vw;
  }

  main {
    height: 100vh;
    width: 100vw;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
