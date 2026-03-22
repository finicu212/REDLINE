<script>
  import { onMount } from 'svelte';
  import Tachometer from './Tachometer.svelte';
  import CylinderBank from './CylinderBank.svelte';
  import Odometer from './Odometer.svelte';
  import GearIndicator from './GearIndicator.svelte';
  import DebugOverlay from './DebugOverlay.svelte';
  import { Drivetrain } from './engine/drivetrain.js';

  let { config } = $props();

  let rpm = $state(850);
  let speed = $state(0);
  let gearLabel = $state('N');
  let throttle = $state(0);       // continuous 0–1
  let mouseHeld = $state(false);
  let mouseThrottle = $state(0);  // throttle from mouse Y position
  let spaceHeld = $state(false);
  let braking = $state(false);
  let showHint = $state(true);
  let showDebug = $state(true);
  let debugState = $state(null);

  /** @type {import('./engine/audio.js').EngineAudio} */
  const engineAudio = config.engineAudio;
  const drivetrain = new Drivetrain();

  function onKeyDown(e) {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      spaceHeld = true;
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
    if ((e.code === 'KeyS' || e.code === 'KeyB') && !e.repeat) {
      braking = true;
    }
    if (e.code === 'Backquote' && !e.repeat) {
      showDebug = !showDebug;
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      spaceHeld = false;
    }
    if (e.code === 'KeyS' || e.code === 'KeyB') {
      braking = false;
    }
  }

  function onMouseDown(e) {
    mouseHeld = true;
    mouseThrottle = 1 - (e.clientY / window.innerHeight);
    showHint = false;
  }

  function onMouseUp() {
    mouseHeld = false;
    mouseThrottle = 0;
  }

  function onMouseMove(e) {
    if (mouseHeld) {
      mouseThrottle = 1 - (e.clientY / window.innerHeight);
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);

    let animFrameId;
    let lastTime = performance.now();

    function loop(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      // Combine inputs: space = full throttle, mouse Y = analog, take max
      throttle = Math.max(spaceHeld ? 1 : 0, mouseHeld ? mouseThrottle : 0);
      throttle = Math.max(0, Math.min(1, throttle));

      drivetrain.update(dt, throttle, braking);

      const state = drivetrain.getState();
      state.throttle = throttle;

      rpm = state.rpm;
      speed = state.speed;
      gearLabel = state.gearLabel;

      if (engineAudio) engineAudio.setEngineState(state);

      if (showDebug) {
        debugState = {
          ...state,
          throttle,
          braking,
          dt,
          bandGains: engineAudio ? { ...engineAudio.debugBandGains } : {},
          detune: engineAudio ? engineAudio.debugDetune : 0,
          shiftOsc: engineAudio ? engineAudio.debugShiftOsc : 0,
        };
      }

      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animFrameId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      if (engineAudio) engineAudio.stop();
    };
  });
</script>

<div class="sim">
  <div class="cylinder-area">
    <CylinderBank {rpm} cylinders={config.cylinders} layout={config.layout} {throttle} />
  </div>

  {#if showDebug && debugState}
    <DebugOverlay data={debugState} />
  {/if}

  <div class="hud">
    <div class="hud-left">
      <Odometer {speed} />
    </div>

    <div class="hud-center">
      {#if showHint || showDebug}
        <p class="hint" class:hint-persist={showDebug}>SPACE full rev &middot; CLICK+DRAG analog throttle &middot; S / B brake &middot; UP/DOWN shift &middot; ` debug</p>
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
    position: relative;
  }

  .cylinder-area {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hud {
    height: clamp(160px, 32vh, 280px);
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: clamp(0.5rem, 2vw, 1.5rem);
    gap: clamp(0.5rem, 2vw, 1rem);
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

  .hud-left,
  .hud-right {
    flex-shrink: 0;
  }

  .hint {
    font-size: clamp(0.5rem, 1.2vw, 0.7rem);
    color: #555;
    letter-spacing: 0.1em;
    animation: fade 4s forwards;
  }

  .hint-persist {
    animation: none;
    opacity: 1;
  }

  @keyframes fade {
    0% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }
</style>
