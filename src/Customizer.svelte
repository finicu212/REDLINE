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
    color: #ff4020;
    text-shadow: 0 0 30px rgba(255, 64, 32, 0.4);
  }

  .subtitle {
    font-size: 1rem;
    color: #666;
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
    color: #888;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }

  .toggle-row {
    display: flex;
    gap: 0.5rem;
  }

  .toggle-row button {
    background: #1a1a2e;
    border: 1px solid #333;
    color: #888;
    padding: 0.5rem 1.5rem;
    font-family: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .toggle-row button:hover:not(:disabled) {
    border-color: #555;
    color: #ccc;
  }

  .toggle-row button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .toggle-row button.active {
    border-color: #ff4020;
    color: #ff4020;
    background: rgba(255, 64, 32, 0.1);
  }

  .start-btn {
    margin-top: 1rem;
    background: transparent;
    border: 2px solid #ff4020;
    color: #ff4020;
    padding: 1rem 3rem;
    font-family: inherit;
    font-size: 1.2rem;
    letter-spacing: 0.2em;
    cursor: pointer;
    transition: all 0.3s;
  }

  .start-btn:hover {
    background: #ff4020;
    color: #0f0f1a;
    box-shadow: 0 0 30px rgba(255, 64, 32, 0.4);
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
    color: #666;
  }

  .progress-bar {
    width: 200px;
    height: 4px;
    background: #1a1a2e;
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #ff4020;
    transition: width 0.2s;
  }
</style>
