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
  let showDebug = $state(true);
  let debugState = $state(null);

  // --- Touch state ---
  let touchThrottle = $state(0);
  let touchBraking = $state(false);
  const SWIPE_THRESHOLD = 40;     // px to trigger a gear shift swipe
  /** @type {Map<number, {startY: number, zone: 'top'|'bottom', shifted: boolean}>} */
  const activeTouches = new Map();

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
  // Bottom half: throttle zone — Y position maps to throttle (bottom=100%, mid=0%)
  // Top half: swipe up = shift up, swipe down = shift down

  function onTouchStart(e) {
    e.preventDefault();
    showHint = false;
    const midY = window.innerHeight / 2;

    for (const touch of e.changedTouches) {
      const zone = touch.clientY >= midY ? 'bottom' : 'top';
      activeTouches.set(touch.identifier, {
        startY: touch.clientY,
        zone,
        shifted: false,
      });

      if (zone === 'bottom') {
        // Map Y within bottom half: mid-screen = 0%, bottom edge = 100%
        const frac = (touch.clientY - midY) / midY;
        touchThrottle = Math.max(0, Math.min(1, frac));
      }
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    const midY = window.innerHeight / 2;

    for (const touch of e.changedTouches) {
      const info = activeTouches.get(touch.identifier);
      if (!info) continue;

      if (info.zone === 'bottom') {
        // Update analog throttle from current Y
        const frac = (touch.clientY - midY) / midY;
        touchThrottle = Math.max(0, Math.min(1, frac));
      } else if (info.zone === 'top' && !info.shifted) {
        // Check for swipe gesture
        const dy = touch.clientY - info.startY;
        if (Math.abs(dy) >= SWIPE_THRESHOLD) {
          if (dy < 0) drivetrain.shiftUp();
          else drivetrain.shiftDown();
          info.shifted = true;
        }
      }
    }
  }

  function onTouchEnd(e) {
    for (const touch of e.changedTouches) {
      activeTouches.delete(touch.identifier);
    }
    // If no bottom-half touches remain, release throttle
    let hasBottomTouch = false;
    for (const info of activeTouches.values()) {
      if (info.zone === 'bottom') { hasBottomTouch = true; break; }
    }
    if (!hasBottomTouch) touchThrottle = 0;
  }

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

  <div class="hud">
    <div class="hud-left">
      <Odometer {speed} />
    </div>

    <div class="hud-center">
      {#if showHint || showDebug}
        <p class="hint" class:hint-persist={showDebug}>SPACE / TOUCH bottom &middot; DRAG up throttle &middot; SWIPE top shift &middot; S/B brake &middot; UP/DOWN shift &middot; GAMEPAD RT/LT/RB/LB &middot; ` debug</p>
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
    touch-action: none;
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
    color: var(--c-text-ghost);
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
</style>
