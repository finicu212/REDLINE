<script>
  let { gear = 'N', speed = 0, clutchHeld = false } = $props();
</script>

<div class="gear-hud">
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
