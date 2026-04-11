<script>
  let { gear = 'N', speed = 0, clutchHeld = false, showShift = false, onshiftup, onshiftdown } = $props();
</script>

<div class="gear-hud">
  <div class="shift-hint" class:visible={showShift} aria-hidden={!showShift}>
    <span>PRESS</span>
    <button class="key" tabindex={showShift ? 0 : -1} title="Shift up" onclick={onshiftup}>&uarr;</button>
    <span>/</span>
    <button class="key" tabindex={showShift ? 0 : -1} title="Shift down" onclick={onshiftdown}>&darr;</button>
    <span>TO SHIFT</span>
  </div>
  <div class="gear-display" class:clutch-in={clutchHeld}>{gear}</div>
  <div class="speed-display">{Math.round(speed)} <span class="unit">km/h</span></div>
</div>

<style>
  .gear-hud {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .gear-display {
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(1.6rem, 4vmin, 2.4rem);
    color: var(--c-accent);
    text-shadow: 0 0 16px var(--c-accent-glow-strong);
    line-height: 1;
    transition: opacity 0.08s;
  }

  .gear-display.clutch-in {
    opacity: 0.45;
  }

  /* Takes its space even while hidden, so the gear letter never jumps */
  .shift-hint {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(0.5rem, 1.1vmin, 0.65rem);
    letter-spacing: 0.12em;
    color: var(--c-text-subtle);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.6s;
  }

  .shift-hint.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* Keycap: flat top, thicker bottom edge like a physical arrow key */
  .key {
    min-width: 1.6em;
    height: 1.6em;
    padding: 0 0.3em;
    font-family: inherit;
    font-size: 1.1em;
    line-height: 1;
    color: var(--c-text-muted);
    background: var(--c-bg-panel);
    border: 1px solid var(--c-border-mid);
    border-bottom-width: 3px;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, transform 0.05s;
  }

  .key:hover {
    color: var(--c-accent);
    border-color: var(--c-accent);
  }

  .key:active {
    transform: translateY(2px);
    border-bottom-width: 1px;
  }

  .speed-display {
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(0.7rem, 2vmin, 1rem);
    color: var(--c-text-muted);
    letter-spacing: 0.1em;
  }

  .unit {
    font-size: clamp(0.5rem, 1.2vmin, 0.7rem);
    color: var(--c-text-subtle);
  }
</style>
