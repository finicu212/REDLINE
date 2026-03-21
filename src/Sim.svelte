<script>
  import { onMount } from 'svelte';
  import Tachometer from './Tachometer.svelte';
  import CylinderBank from './CylinderBank.svelte';
  import Odometer from './Odometer.svelte';

  let { config } = $props();

  const IDLE_RPM = 850;
  const MAX_RPM = 9000;

  let rpm = $state(IDLE_RPM);
  let revving = $state(false);
  let showHint = $state(true);

  /** @type {import('./engine/audio.js').EngineAudio} */
  const engineAudio = config.engineAudio;

  function onKeyDown(e) {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      revving = true;
      showHint = false;
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      revving = false;
    }
  }

  function onMouseDown() {
    revving = true;
    showHint = false;
  }

  function onMouseUp() {
    revving = false;
  }

  onMount(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);

    let animFrameId;
    function loop() {
      const target = revving ? MAX_RPM : IDLE_RPM;
      const rate = revving ? 0.04 : 0.025;
      rpm += (target - rpm) * rate;
      if (engineAudio) engineAudio.setRPM(rpm, revving);
      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animFrameId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      if (engineAudio) engineAudio.stop();
    };
  });
</script>

<div class="sim">
  <div class="cylinder-area">
    <CylinderBank {rpm} cylinders={config.cylinders} layout={config.layout} />
  </div>

  <div class="hud">
    <div class="hud-left">
      <Odometer {rpm} />
    </div>

    <div class="hud-center">
      {#if showHint}
        <p class="hint">HOLD SPACE &middot; HOLD CLICK</p>
      {/if}
    </div>

    <div class="hud-right">
      <Tachometer {rpm} />
    </div>
  </div>
</div>

<style>
  .sim {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    user-select: none;
  }

  .cylinder-area {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hud {
    height: 280px;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: 1.5rem;
  }

  .hud-left,
  .hud-center,
  .hud-right {
    display: flex;
    align-items: flex-end;
  }

  .hud-center {
    flex: 1;
    justify-content: center;
  }

  .hint {
    font-size: 0.8rem;
    color: #555;
    letter-spacing: 0.15em;
    animation: fade 3s forwards;
  }

  @keyframes fade {
    0% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }
</style>
