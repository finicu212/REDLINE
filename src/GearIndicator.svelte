<script>
  let { gear = 'N', speed = 0, clutchHeld = false, showShift = false, onshiftup, onshiftdown } = $props();
</script>

<div class="gear-hud">
  <div class="gear-row">
    <div class="gear-display" class:clutch-in={clutchHeld}>{gear}</div>
    <div class="shift-hint" class:visible={showShift} aria-hidden={!showShift}>
      <button tabindex={showShift ? 0 : -1} title="Shift up (↑)" onclick={onshiftup}>&#9650;</button>
      <button tabindex={showShift ? 0 : -1} title="Shift down (↓)" onclick={onshiftdown}>&#9660;</button>
    </div>
  </div>
  <div class="speed-display">{Math.round(speed)} <span class="unit">km/h</span></div>
</div>

<style>
  .gear-hud {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .gear-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    /* reserve the hint's width so the gear letter doesn't jump when it appears */
    padding-left: 1.4rem;
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

  .shift-hint {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 1rem;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.6s;
  }

  .shift-hint.visible {
    opacity: 1;
    pointer-events: auto;
  }

  .shift-hint button {
    background: transparent;
    border: 1px solid var(--c-border-subtle);
    color: var(--c-text-ghost);
    font-size: 0.5rem;
    line-height: 1;
    padding: 2px 0;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.2s, border-color 0.2s;
  }

  .shift-hint button:hover {
    color: var(--c-accent);
    border-color: var(--c-accent);
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
