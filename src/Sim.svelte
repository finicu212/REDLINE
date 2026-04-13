<script>
  import { onMount } from 'svelte';
  import Tachometer from './Tachometer.svelte';
  import TrackView from './TrackView.svelte';
  import TrackHud from './TrackHud.svelte';
  import { RaceSession } from './track/session.js';
  import { Autopilot } from './track/autopilot.js';
  import Odometer from './Odometer.svelte';
  import GearIndicator from './GearIndicator.svelte';
  import DebugOverlay from './DebugOverlay.svelte';
  import BoostGauge from './BoostGauge.svelte';
  import { Drivetrain } from './engine/drivetrain.js';

  let { config } = $props();

  let rpm = $state(850);
  let manifoldBar = $state(0);
  let speed = $state(0);
  let gearLabel = $state('N');
  let throttle = $state(0);       // continuous 0–1
  let mouseHeld = $state(false);
  let mouseThrottle = $state(0);  // throttle from mouse Y position
  let clickOriginY = 0;           // Y position at mousedown (0% throttle anchor)
  const THROTTLE_DRAG_PX = 120;   // pixels of upward drag for 100% throttle
  // In neutral an on/off key would slam the limiter; cap it (analog inputs keep full range)
  const NEUTRAL_DISCRETE_THROTTLE = 0.35;
  const NEUTRAL_HINT_MS = 3000;   // idle in neutral this long → show shift controls
  let neutralSince = performance.now();
  let neutralIdle = $state(false);
  let spaceHeld = $state(false);
  let braking = $state(false);
  let clutchHeld = $state(false);
  let showHint = $state(true);
  let showControls = $state(false);
  let isTouchDevice = $state(false);
  let showDebug = $state(false);
  let debugState = $state(null);

  // --- Touch state ---
  // Touch anywhere = throttle. Drag UP from touch origin = more throttle (same as mouse).
  let touchThrottle = $state(0);
  let touchBraking = $state(false);
  const TOUCH_THROTTLE_PX = 120;  // px of upward drag for 100% (matches mouse THROTTLE_DRAG_PX)
  /** @type {Map<number, number>} touch id → startY */
  const throttleTouches = new Map();

  // --- Gamepad state ---
  let gamepadThrottle = $state(0);
  let gamepadBrake = $state(0);
  let gamepadClutch = $state(false);
  let gpShiftUpPrev = false;
  let gpShiftDownPrev = false;

  /** @type {import('./engine/audio.js').EngineAudio} */
  const engineAudio = config.engineAudio;
  const drivetrain = new Drivetrain(config.profile);
  const race = new RaceSession(config.profile);
  let frame = $state(0);
  // Keyboard brake is on/off: ramp it like a foot so trail-braking is possible
  const BRAKE_APPLY_PER_S = 8;
  const BRAKE_RELEASE_PER_S = 12;
  let brakePedal = 0;
  let devPilot = null;

  function onKeyDown(e) {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      spaceHeld = true;
      showHint = false;
    }
    if ((e.code === 'KeyC' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) {
      clutchHeld = true;
      drivetrain.clutchHeld = true;
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
    if (e.code === 'KeyR' && !e.repeat) {
      race.resetToGrid(drivetrain);
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      spaceHeld = false;
    }
    if (e.code === 'KeyS' || e.code === 'KeyB') {
      braking = false;
    }
    if (e.code === 'KeyC' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      clutchHeld = false;
      drivetrain.clutchHeld = false;
    }
  }

  function onMouseDown(e) {
    if (e.target.closest?.('.shift-hint')) return;
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
  // Drag UP from touch origin = throttle 0→1 over TOUCH_THROTTLE_PX (mirrors mouse drag)

  function onTouchStart(e) {
    if (e.target.closest('.touch-btn, .shift-hint')) return;
    e.preventDefault();
    showHint = false;
    isTouchDevice = true;

    for (const touch of e.changedTouches) {
      throttleTouches.set(touch.identifier, touch.clientY);
    }
    // Touch down alone = 0% throttle (must drag up)
  }

  function onTouchMove(e) {
    if (e.target.closest('.touch-btn')) return;
    e.preventDefault();

    for (const touch of e.changedTouches) {
      const originY = throttleTouches.get(touch.identifier);
      if (originY !== undefined) {
        const dragUp = originY - touch.clientY;
        touchThrottle = Math.max(0, Math.min(1, dragUp / TOUCH_THROTTLE_PX));
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
  let touchClutch = $state(false);
  function onShiftUpTouch(e) { e.preventDefault(); drivetrain.shiftUp(); }
  function onShiftDownTouch(e) { e.preventDefault(); drivetrain.shiftDown(); }
  function onBrakeStart(e) { e.preventDefault(); touchBraking = true; }
  function onBrakeEnd(e) { e.preventDefault(); touchBraking = false; }
  function onClutchStart(e) { e.preventDefault(); touchClutch = true; drivetrain.clutchHeld = true; }
  function onClutchEnd(e) { e.preventDefault(); touchClutch = false; drivetrain.clutchHeld = false; }

  // --- Gamepad polling (called each frame) ---
  function pollGamepad() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[0];
    if (!gp) {
      gamepadThrottle = 0;
      gamepadBrake = 0;
      return;
    }

    // Standard mapping: buttons[7] = RT (throttle), buttons[6] = LT (brake)
    gamepadThrottle = gp.buttons[7] ? gp.buttons[7].value : 0;
    gamepadBrake = gp.buttons[6] ? gp.buttons[6].value : 0;

    // LB (buttons[4]) = clutch (hold)
    gamepadClutch = gp.buttons[4] ? gp.buttons[4].pressed : false;

    // RB (buttons[5]) = shift up, dpad down (buttons[13]) = shift down — edge-triggered
    const shiftUp = gp.buttons[5] ? gp.buttons[5].pressed : false;
    const shiftDown = gp.buttons[13] ? gp.buttons[13].pressed : false;

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
      const discreteThrottle = drivetrain.gear === 0 ? NEUTRAL_DISCRETE_THROTTLE : 1;
      throttle = Math.max(
        spaceHeld ? discreteThrottle : 0,
        mouseHeld ? mouseThrottle : 0,
        touchThrottle,
        gamepadThrottle,
      );
      throttle = Math.max(0, Math.min(1, throttle));
      const digitalBrake = braking || touchBraking ? 1 : 0;
      const stepDt = Math.min(0.05, Math.max(0, dt));
      brakePedal = digitalBrake > brakePedal
        ? Math.min(digitalBrake, brakePedal + BRAKE_APPLY_PER_S * stepDt)
        : Math.max(digitalBrake, brakePedal - BRAKE_RELEASE_PER_S * stepDt);
      const brake = Math.max(brakePedal, gamepadBrake > 0.05 ? gamepadBrake : 0);
      const isBraking = brake > 0;

      drivetrain.clutchHeld = clutchHeld || touchClutch || gamepadClutch;

      // Dev-only: `window.__redlineAutopilot = true` lets the test driver take over (playtests)
      if (import.meta.env.DEV && window.__redlineAutopilot) {
        devPilot ??= new Autopilot(race, config.profile, { margin: window.__redlineAutopilot.margin ?? 0.95 });
        const ai = devPilot.drive(drivetrain);
        throttle = ai.throttle;
        race.step(dt, drivetrain, ai);
      } else {
        race.step(dt, drivetrain, { throttle, brake });
      }
      frame++;

      const state = drivetrain.getState();
      state.throttle = throttle;

      if (drivetrain.gear !== 0) neutralSince = now;
      neutralIdle = now - neutralSince > NEUTRAL_HINT_MS;

      rpm = state.rpm;
      manifoldBar = state.manifoldBar;
      speed = state.speed;
      gearLabel = state.gearLabel;

      if (engineAudio) {
        engineAudio.setEngineState(state);
        engineAudio.setTyreState(race.car, race.feed, race.time);
      }

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

<div class="sim" class:sim-touch={isTouchDevice}>
  <div class="cylinder-area">
    <TrackView session={race} carColor={config.profile.color} />
    <TrackHud session={race} tick={frame} />
  </div>

  <!-- Throttle bar -->
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
      <div class="touch-left">
        <button class="touch-btn clutch-btn"
          ontouchstart={onClutchStart}
          ontouchend={onClutchEnd}
          ontouchcancel={onClutchEnd}
        >CLT</button>
        <button class="touch-btn brake-btn"
          ontouchstart={onBrakeStart}
          ontouchend={onBrakeEnd}
          ontouchcancel={onBrakeEnd}
        >BRK</button>
      </div>
      <div class="touch-right">
        <button class="touch-btn shift-up-btn"
          ontouchstart={onShiftUpTouch}
        >&uarr;</button>
        <button class="touch-btn shift-down-btn"
          ontouchstart={onShiftDownTouch}
        >&darr;</button>
      </div>
    </div>
  {/if}

  <!--
    Desktop: bottom bar with odometer | gear | tachometer
    Mobile:  tachometer centered in main area, gear below it, bottom bar minimal
  -->
  <div class="hud">
    <div class="hud-left">
      <Odometer {speed} />
    </div>

    <div class="hud-center">
      {#if showHint}
        <p class="hint">{isTouchDevice ? 'DRAG UP to go · BRK to brake' : 'SPACE go · S brake · ↑↓ shift · R reset'}</p>
      {/if}
      <GearIndicator gear={gearLabel} {speed} clutchHeld={drivetrain.clutchHeld}
        showShift={neutralIdle}
        onshiftup={() => drivetrain.shiftUp()}
        onshiftdown={() => drivetrain.shiftDown()} />
    </div>

    <button class="info-btn" onclick={() => showControls = !showControls}>CONTROLS</button>

    {#if showControls}
      <div class="controls-popup" onclick={() => showControls = false}>
        <div class="controls-card" onclick={(e) => e.stopPropagation()}>
          <div class="controls-title">CONTROLS</div>
          <div class="controls-section">
            <div class="controls-heading">Keyboard + Mouse</div>
            <div class="controls-row"><span class="controls-key">SPACE</span> Full throttle (35% in neutral)</div>
            <div class="controls-row"><span class="controls-key">CLICK+DRAG UP</span> Proportional throttle</div>
            <div class="controls-row"><span class="controls-key">SHIFT / C</span> Clutch (hold to shift)</div>
            <div class="controls-row"><span class="controls-key">{'\u2191'} {'\u2193'}</span> Shift up / down</div>
            <div class="controls-row"><span class="controls-key">S / B</span> Brake</div>
            <div class="controls-row"><span class="controls-key">R</span> Back to the grid</div>
            <div class="controls-row"><span class="controls-key">`</span> Toggle debug</div>
          </div>
          <div class="controls-section">
            <div class="controls-heading">Touch</div>
            <div class="controls-row"><span class="controls-key">DRAG UP</span> Throttle</div>
            <div class="controls-row"><span class="controls-key">CLT</span> Hold clutch, then shift</div>
            <div class="controls-row"><span class="controls-key">{'\u2191'} {'\u2193'} BRK</span> On-screen buttons</div>
          </div>
          <div class="controls-section">
            <div class="controls-heading">Gamepad</div>
            <div class="controls-row"><span class="controls-key">RT</span> Throttle</div>
            <div class="controls-row"><span class="controls-key">LT</span> Brake</div>
            <div class="controls-row"><span class="controls-key">LB</span> Clutch (hold to shift)</div>
            <div class="controls-row"><span class="controls-key">RB</span> Shift up</div>
            <div class="controls-row"><span class="controls-key">DPAD {'\u2193'}</span> Shift down</div>
          </div>
          <button class="controls-close" onclick={() => showControls = false}>CLOSE</button>
        </div>
      </div>
    {/if}

    <div class="hud-right">
      {#if config.profile.turbo || config.profile.supercharger}
        <BoostGauge bar={manifoldBar} />
      {/if}
      <Tachometer {rpm} redline={config.profile.redlineRPM} maxRPM={config.profile.tachoMaxRPM} />
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
    position: relative;
  }

  /* --- Desktop HUD: bottom bar with odometer | gear | tachometer --- */
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

  .hud-right {
    gap: clamp(0.25rem, 1vw, 0.75rem);
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

  /* --- Info / controls popup --- */
  .info-btn {
    position: absolute;
    top: 12px;
    right: 12px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(20, 20, 30, 0.7);
    color: rgba(255, 255, 255, 0.6);
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(0.6rem, 1.2vw, 0.75rem);
    letter-spacing: 0.1em;
    cursor: pointer;
    z-index: 90;
    padding: 0.35em 0.8em;
    -webkit-tap-highlight-color: transparent;
  }

  .info-btn:hover {
    border-color: rgba(255, 255, 255, 0.4);
    color: rgba(255, 255, 255, 0.85);
    background: rgba(30, 30, 45, 0.8);
  }

  .controls-popup {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .controls-card {
    background: var(--c-bg-panel);
    border: 1px solid var(--c-border-subtle);
    border-radius: 8px;
    padding: 1.2rem 1.5rem;
    font-family: 'Share Tech Mono', monospace;
    max-width: min(360px, 90vw);
    width: 100%;
  }

  .controls-title {
    font-size: 0.7rem;
    color: var(--c-text-ghost);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    margin-bottom: 0.8rem;
  }

  .controls-section {
    margin-bottom: 0.7rem;
  }

  .controls-heading {
    font-size: 0.6rem;
    color: var(--c-text-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 0.3rem;
  }

  .controls-row {
    font-size: 0.65rem;
    color: var(--c-text-dim);
    padding: 0.15rem 0;
  }

  .controls-key {
    color: var(--c-text-secondary);
    margin-right: 0.4rem;
  }

  .controls-close {
    margin-top: 0.5rem;
    width: 100%;
    padding: 0.4rem;
    background: transparent;
    border: 1px solid var(--c-border-subtle);
    border-radius: 4px;
    color: var(--c-text-ghost);
    font-family: inherit;
    font-size: 0.6rem;
    letter-spacing: 0.15em;
    cursor: pointer;
  }

  .controls-close:hover {
    border-color: var(--c-text-muted);
    color: var(--c-text-muted);
  }

  /* --- Throttle bar (desktop: left edge, mobile: left column) --- */
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
    display: flex;
    justify-content: space-between;
    align-items: stretch;
  }

  .touch-left,
  .touch-right {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
    padding: 10px;
    pointer-events: none;
  }

  .touch-btn {
    pointer-events: auto;
    font-family: 'Share Tech Mono', monospace;
    font-size: 1.1rem;
    font-weight: bold;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    background: rgba(20, 20, 30, 0.6);
    color: rgba(255, 255, 255, 0.5);
    width: 56px;
    height: 56px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
    flex-shrink: 0;
  }

  .touch-btn:active {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
  }

  .clutch-btn {
    font-size: 0.7rem;
    color: rgba(180, 255, 100, 0.6);
    border-color: rgba(180, 255, 100, 0.25);
  }

  .clutch-btn:active {
    background: rgba(180, 255, 100, 0.2);
    color: #bf6;
  }

  .brake-btn {
    font-size: 0.8rem;
    color: rgba(100, 160, 255, 0.6);
    border-color: rgba(100, 160, 255, 0.25);
  }

  .brake-btn:active {
    background: rgba(100, 160, 255, 0.2);
    color: #6af;
  }

  /* =================================================================
     MOBILE: tachometer centered + gear below it, controls on sides
     ================================================================= */
  @media (max-width: 600px) {
    /* Restructure: cylinders top, tachometer+gear center, minimal bottom */
    .sim-touch {
      /* On mobile touch, reorder via grid */
      display: grid;
      grid-template-rows: auto 1fr auto;
      grid-template-columns: 1fr;
    }

    .sim-touch .cylinder-area {
      grid-row: 1;
      flex: none;
      height: 52vh;
    }

    /* Move tachometer from hud-right to center of the screen */
    .sim-touch .hud {
      grid-row: 2;
      height: auto;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 0.5rem;
      gap: 0.4rem;
    }

    .sim-touch .hud-left {
      display: none;
    }

    .sim-touch .hud-right {
      order: -1;
      align-items: center;
    }

    .sim-touch .hud-center {
      flex: none;
    }

    /* Throttle bar: reposition to left column, taller on mobile */
    .sim-touch .throttle-cyl {
      left: 12px;
      top: 50%;
      height: 30vh;
      width: 16px;
    }

    .sim-touch .throttle-cyl-label {
      font-size: 0.5rem;
    }

    /* Touch buttons: bigger tap targets on mobile */
    .touch-left,
    .touch-right {
      padding: 0 8px;
    }

    .touch-btn {
      width: 52px;
      height: 52px;
    }

    .hint {
      font-size: 0.55rem;
    }
  }
</style>
