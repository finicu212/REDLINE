<script>
  import { EngineAudio } from './engine/audio.js';

  let { onstart } = $props();

  let cylinders = $state(4);
  let layout = $state('inline');
  let loading = $state(false);
  let loadProgress = $state(0);

  const engineAudio = new EngineAudio();

  async function handleStart() {
    loading = true;
    await engineAudio.init((progress) => {
      loadProgress = progress;
    });
    engineAudio.start();
    onstart({ cylinders, layout, engineAudio });
  }
</script>

<div class="customizer">
  <h1 class="title">REDLINE</h1>
  <p class="subtitle">Engine Simulator</p>

  <div class="option-group">
    <span class="label">Cylinders</span>
    <div class="toggle-row">
      <button class:active={cylinders === 4} disabled={layout === 'v'} onclick={() => cylinders = 4}>4</button>
      <button class:active={cylinders === 6} onclick={() => cylinders = 6}>6</button>
    </div>
  </div>

  <div class="option-group">
    <span class="label">Layout</span>
    <div class="toggle-row">
      <button class:active={layout === 'inline'} onclick={() => layout = 'inline'}>Inline</button>
      <button class:active={layout === 'v'} onclick={() => { layout = 'v'; cylinders = 6; }}>V-Layout</button>
    </div>
  </div>

  {#if loading}
    <div class="loading">
      <div class="progress-bar">
        <div class="progress-fill" style="width: {loadProgress * 100}%"></div>
      </div>
      <p>Loading audio samples...</p>
    </div>
  {:else}
    <button class="start-btn" onclick={handleStart}>START ENGINE</button>
  {/if}
</div>

<style>
  .customizer {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
  }

  .title {
    font-size: 4rem;
    letter-spacing: 0.3em;
    color: var(--c-accent);
    text-shadow: 0 0 30px var(--c-accent-glow);
  }

  .subtitle {
    font-size: 1rem;
    color: var(--c-text-subtle);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .option-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .label {
    font-size: 0.8rem;
    color: var(--c-text-dim);
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }

  .toggle-row {
    display: flex;
    gap: 0.5rem;
  }

  .toggle-row button {
    background: var(--c-bg-panel);
    border: 1px solid var(--c-border-subtle);
    color: var(--c-text-dim);
    padding: 0.5rem 1.5rem;
    font-family: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .toggle-row button:hover:not(:disabled) {
    border-color: var(--c-border-focus);
    color: var(--c-text-secondary);
  }

  .toggle-row button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .toggle-row button.active {
    border-color: var(--c-accent);
    color: var(--c-accent);
    background: var(--c-accent-dim);
  }

  .start-btn {
    margin-top: 1rem;
    background: transparent;
    border: 2px solid var(--c-accent);
    color: var(--c-accent);
    padding: 1rem 3rem;
    font-family: inherit;
    font-size: 1.2rem;
    letter-spacing: 0.2em;
    cursor: pointer;
    transition: all 0.3s;
  }

  .start-btn:hover {
    background: var(--c-accent);
    color: var(--c-bg-deep);
    box-shadow: 0 0 30px var(--c-accent-glow);
  }

  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .loading p {
    font-size: 0.8rem;
    color: var(--c-text-subtle);
  }

  .progress-bar {
    width: 200px;
    height: 4px;
    background: var(--c-bg-panel);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--c-accent);
    transition: width 0.2s;
  }
</style>
