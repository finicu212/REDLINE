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
  let clickOriginY = 0;           // Y position at mousedown (0% throttle anchor)
  const THROTTLE_DRAG_PX = 120;   // pixels of upward drag for 100% throttle
  let spaceHeld = $state(false);
  let braking = $state(false);
  let showHint = $state(true);
  let isTouchDevice = $state(false);
  let showDebug = $state(true);
  let debugState = $state(null);

  // --- Touch state ---
  // Touch anywhere on the main area = throttle (Y maps to 0–1, lower = more)
  // Visible on-screen buttons handle shift up/down and brake
  let touchThrottle = $state(0);
  let touchBraking = $state(false);
  /** @type {Set<number>} touch identifiers currently providing throttle */
  const throttleTouches = new Set();

  // --- Gamepad state ---
  let gamepadThrottle = $state(0);
  let gamepadBraking = $state(false);
  let gpShiftUpPrev = false;
  let gpShiftDownPrev = false;

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
    clickOriginY = e.clientY;
    mouseThrottle = 0;
    showHint = false;
  }

  function onMouseUp() {
    mouseHeld = false;
    mouseThrottle = 0;
  }

  function onMouseMove(e) {
    if (mouseHeld) {
      // Upward drag from click origin → throttle 0–1
      const dragUp = clickOriginY - e.clientY;
      mouseThrottle = Math.max(0, Math.min(1, dragUp / THROTTLE_DRAG_PX));
    }
  }

  // --- Touch handlers ---
  // Touches on the main sim area = throttle (Y position: top=0%, bottom=100%)
  // On-screen buttons handle shift and brake via their own touch events

  function touchYToThrottle(clientY) {
    const h = window.innerHeight;
    return Math.max(0, Math.min(1, clientY / h));
  }

  function onTouchStart(e) {
    // Ignore touches that land on a touch-btn (they handle themselves)
    if (e.target.closest('.touch-btn')) return;
    e.preventDefault();
    showHint = false;
    isTouchDevice = true;

    for (const touch of e.changedTouches) {
      throttleTouches.add(touch.identifier);
      touchThrottle = touchYToThrottle(touch.clientY);
    }
  }

  function onTouchMove(e) {
    if (e.target.closest('.touch-btn')) return;
    e.preventDefault();

    for (const touch of e.changedTouches) {
      if (throttleTouches.has(touch.identifier)) {
        touchThrottle = touchYToThrottle(touch.clientY);
      }
    }
  }

  function onTouchEnd(e) {
    for (const touch of e.changedTouches) {
      throttleTouches.delete(touch.identifier);
    }
    if (throttleTouches.size === 0) touchThrottle = 0;
  }

  // Button handlers for on-screen controls
  function onShiftUpTouch(e) { e.preventDefault(); drivetrain.shiftUp(); }
  function onShiftDownTouch(e) { e.preventDefault(); drivetrain.shiftDown(); }
  function onBrakeStart(e) { e.preventDefault(); touchBraking = true; }
  function onBrakeEnd(e) { e.preventDefault(); touchBraking = false; }

  // --- Gamepad polling (called each frame) ---
  function pollGamepad() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[0];
    if (!gp) {
      gamepadThrottle = 0;
      gamepadBraking = false;
      return;
    }

    // Standard mapping: buttons[7] = RT (throttle), buttons[6] = LT (brake)
    gamepadThrottle = gp.buttons[7] ? gp.buttons[7].value : 0;
    gamepadBraking = gp.buttons[6] ? gp.buttons[6].value > 0.1 : false;

    // RB (buttons[5]) = shift up, LB (buttons[4]) = shift down — edge-triggered
    const shiftUp = gp.buttons[5] ? gp.buttons[5].pressed : false;
    const shiftDown = gp.buttons[4] ? gp.buttons[4].pressed : false;

    if (shiftUp && !gpShiftUpPrev) drivetrain.shiftUp();
    if (shiftDown && !gpShiftDownPrev) drivetrain.shiftDown();
    gpShiftUpPrev = shiftUp;
    gpShiftDownPrev = shiftDown;
  }

  onMount(() => {
    // Detect touch device and default debug off
    isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouchDevice) showDebug = false;

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);

    let animFrameId;
    let lastTime = performance.now();

    function loop(now) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      // Poll gamepad each frame
      pollGamepad();

      // Combine all input sources: take max throttle, OR brakes
      throttle = Math.max(
        spaceHeld ? 1 : 0,
        mouseHeld ? mouseThrottle : 0,
        touchThrottle,
        gamepadThrottle,
      );
      throttle = Math.max(0, Math.min(1, throttle));
      const isBraking = braking || touchBraking || gamepadBraking;

      drivetrain.update(dt, throttle, isBraking);

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
          braking: isBraking,
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
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      if (engineAudio) engineAudio.stop();
    };
  });
</script>

<div class="sim">
  <div class="cylinder-area">
    <CylinderBank {rpm} cylinders={config.cylinders} layout={config.layout} {throttle} />
  </div>

  <!-- Throttle cylinder indicator -->
  <div class="throttle-cyl">
    <div class="throttle-cyl-fill" style="height: {throttle * 100}%"></div>
    <span class="throttle-cyl-label">{(throttle * 100).toFixed(0)}</span>
  </div>

  {#if showDebug && debugState}
    <DebugOverlay data={debugState} />
  {/if}

  <!-- On-screen touch controls (visible on touch devices) -->
  {#if isTouchDevice}
    <div class="touch-controls">
      <button class="touch-btn brake-btn"
        ontouchstart={onBrakeStart}
        ontouchend={onBrakeEnd}
        ontouchcancel={onBrakeEnd}
      >BRK</button>
      <div class="shift-btns">
        <button class="touch-btn shift-up-btn"
          ontouchstart={onShiftUpTouch}
        >&uarr;</button>
        <button class="touch-btn shift-down-btn"
          ontouchstart={onShiftDownTouch}
        >&darr;</button>
      </div>
    </div>
  {/if}

  <div class="hud">
    <div class="hud-left">
      <Odometer {speed} />
    </div>

    <div class="hud-center">
      {#if showHint}
        <p class="hint">{isTouchDevice ? 'TOUCH to rev \u00b7 buttons to shift/brake' : 'SPACE rev \u00b7 DRAG throttle \u00b7 S/B brake \u00b7 UP/DOWN shift \u00b7 ` debug'}</p>
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
    height: 100dvh;
    display: flex;
    flex-direction: column;
    user-select: none;
    touch-action: none;
    position: relative;
    overflow: hidden;
  }

  .cylinder-area {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hud {
    height: clamp(140px, 28vh, 280px);
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
    color: var(--c-text-ghost);
    letter-spacing: 0.1em;
    animation: fade 4s forwards;
    text-align: center;
    max-width: 80vw;
  }

  @keyframes fade {
    0% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }

  .throttle-cyl {
    position: absolute;
    left: 18px;
    top: 50%;
    transform: translateY(-50%);
    width: 20px;
    height: 100px;
    background: rgba(20, 20, 30, 0.85);
    border: 1px solid #333;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    align-items: flex-end;
    z-index: 50;
  }

  .throttle-cyl-fill {
    width: 100%;
    background: linear-gradient(to top, #ff6020, #ff4010);
    border-radius: 0 0 3px 3px;
    transition: height 0.04s linear;
  }

  .throttle-cyl-label {
    position: absolute;
    width: 100%;
    text-align: center;
    top: -16px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 0.55rem;
    color: #777;
  }

  /* --- On-screen touch controls --- */
  .touch-controls {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 60;
  }

  .touch-btn {
    pointer-events: auto;
    position: absolute;
    font-family: 'Share Tech Mono', monospace;
    font-size: 1.1rem;
    font-weight: bold;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    background: rgba(20, 20, 30, 0.6);
    color: rgba(255, 255, 255, 0.5);
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }

  .touch-btn:active {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
  }

  .brake-btn {
    left: 10px;
    bottom: clamp(140px, 28vh, 280px);
    width: 56px;
    height: 56px;
    margin-bottom: 12px;
    font-size: 0.8rem;
    color: rgba(100, 160, 255, 0.6);
    border-color: rgba(100, 160, 255, 0.25);
  }

  .brake-btn:active {
    background: rgba(100, 160, 255, 0.2);
    color: #6af;
  }

  .shift-btns {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 12px;
    pointer-events: auto;
  }

  .shift-up-btn,
  .shift-down-btn {
    position: static;
    width: 56px;
    height: 56px;
  }

  /* --- Mobile portrait: compact HUD --- */
  @media (max-width: 600px) {
    .hud {
      height: clamp(100px, 22vh, 160px);
      padding: 0.4rem;
      gap: 0.4rem;
    }

    .hud-left {
      display: none;
    }

    .throttle-cyl {
      display: none;
    }

    .brake-btn {
      bottom: clamp(100px, 22vh, 160px);
    }
  }
</style>
