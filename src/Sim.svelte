<script>
  import { onMount } from 'svelte';
  import Tachometer from './Tachometer.svelte';
  import CylinderBank from './CylinderBank.svelte';
  import Odometer from './Odometer.svelte';
  import GearIndicator from './GearIndicator.svelte';
  import { Drivetrain } from './engine/drivetrain.js';

  let { config } = $props();

  let rpm = $state(850);
  let speed = $state(0);
  let gearLabel = $state('N');
  let revving = $state(false);
  let showHint = $state(true);

  /** @type {import('./engine/audio.js').EngineAudio} */
  const engineAudio = config.engineAudio;
  const drivetrain = new Drivetrain();

  function onKeyDown(e) {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      revving = true;
      showHint = false;
    }
    if (e.code === 'ArrowUp' && !e.repeat) {
      e.preventDefault();
      drivetrain.shiftUp();
    }
    if (e.code === 'ArrowDown' && !e.repeat) {
      e.preventDefault();
      drivetrain.shiftDown();
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
    let lastTime = performance.now();

    function loop(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      drivetrain.update(dt, revving);
      rpm = drivetrain.rpm;
      speed = drivetrain.speed;
      gearLabel = drivetrain.gearLabel;

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
      <Odometer {speed} />
    </div>

    <div class="hud-center">
      {#if showHint}
        <p class="hint">HOLD SPACE / CLICK to rev &middot; UP/DOWN to shift</p>
      {/if}
      <GearIndicator gear={gearLabel} {speed} />
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
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .hint {
    font-size: 0.7rem;
    color: #555;
    letter-spacing: 0.1em;
    animation: fade 4s forwards;
  }

  @keyframes fade {
    0% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }
</style>
