<script>
  import Customizer from './Customizer.svelte';
  import Sim from './Sim.svelte';

  let screen = $state('customizer');
  let engineConfig = $state({ cylinders: 4, layout: 'inline' });

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

  :global(body) {
    background: #0f0f1a;
    color: #eee;
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
