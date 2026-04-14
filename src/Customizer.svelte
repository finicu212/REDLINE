<script>
  import { EngineAudio } from './engine/audio.js';
  import { PROFILE_LIST } from './engine/profiles.js';
  import { loadRecord } from './track/storage.js';
  import { fmtLap } from './track/format.js';
  import { onMount } from 'svelte';
  import { getMonza } from './track/session.js';

  // Build the track + racing line (~0.5 s) while the menu idles, not when START is pressed
  onMount(() => {
    const id = setTimeout(getMonza, 300);
    return () => clearTimeout(id);
  });

  const records = Object.fromEntries(PROFILE_LIST.map(p => [p.id, loadRecord(p.id)]));


  let { onstart } = $props();

  let selectedId = $state(PROFILE_LIST[0].id);
  let loading = $state(false);
  let loadProgress = $state(0);

  let selectedProfile = $derived(PROFILE_LIST.find(p => p.id === selectedId));

  // Aftermarket boost adds to the NA curve; turbos settle ~90% of max boost, blowers hit 100%
  function boostFactor(profile) {
    const t = profile.turbo;
    if (profile.supercharger) return 1 + profile.supercharger.torqueGain; // full boost from 2500 RPM
    return t && typeof t === 'object' && !t.curveIncludesBoost ? 1 + t.torqueGain * 0.9 : 1;
  }

  function peakHP(profile) {
    const RPM_TO_RADS = (2 * Math.PI) / 60;
    let max = 0;
    for (const [r, t] of profile.torqueCurve) {
      const hp = (t * r * RPM_TO_RADS) / 745.7;
      if (hp > max) max = hp;
    }
    return Math.round(max * boostFactor(profile));
  }

  function peakTorque(profile) {
    let max = 0, atRPM = 0;
    for (const [r, t] of profile.torqueCurve) {
      if (t > max) { max = t; atRPM = r; }
    }
    return { nm: Math.round(max * boostFactor(profile)), rpm: atRPM };
  }

  async function handleStart() {
    const profile = selectedProfile;
    loading = true;
    const engineAudio = new EngineAudio(profile);
    await engineAudio.init((progress) => {
      loadProgress = progress;
    });
    engineAudio.start();
    onstart({ profile, engineAudio });
  }
</script>

<div class="customizer">
  <h1 class="title">REDLINE</h1>
  <p class="subtitle">Engine Simulator</p>

  <div class="profiles">
    {#each PROFILE_LIST as profile (profile.id)}
      {@const pt = peakTorque(profile)}
      <button
        class="profile-card"
        class:selected={selectedId === profile.id}
        onclick={() => selectedId = profile.id}
      >
        <div class="card-name">{profile.name}</div>
        <div class="card-desc">{profile.description}</div>
        {#if profile.vehicle}
          <div class="card-desc">{profile.vehicle}</div>
        {/if}
        <div class="card-stats">
          <span>{peakHP(profile)} HP</span>
          <span>{pt.nm} Nm</span>
          <span>{profile.gearRatios.length - 1}-speed</span>
        </div>
        <div class="card-meta">
          <span>{profile.cylinders}cyl {profile.layout === 'v' ? 'V' : 'I'}</span>
          <span>Redline {profile.redlineRPM}</span>
        </div>
        {#if records[profile.id]?.bestLap}
          <div class="card-pb">MONZA PB <b>{fmtLap(records[profile.id].bestLap)}</b></div>
        {/if}
        {#if profile.sound}
          <div class="card-sound">{profile.sound}</div>
        {/if}
      </button>
    {/each}
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

  .profiles {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
    max-width: 900px;
  }

  .profile-card {
    background: var(--c-bg-panel);
    border: 1px solid var(--c-border-subtle);
    color: var(--c-text-dim);
    padding: 1rem 1.2rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s;
    text-align: left;
    min-width: 140px;
    max-width: 160px;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .profile-card:hover {
    border-color: var(--c-border-focus);
    color: var(--c-text-secondary);
  }

  .profile-card.selected {
    border-color: var(--c-accent);
    color: var(--c-accent);
    background: var(--c-accent-dim);
  }

  .card-name {
    font-size: 1.1rem;
    font-weight: bold;
    letter-spacing: 0.1em;
  }

  .card-desc {
    font-size: 0.65rem;
    color: var(--c-text-subtle);
    letter-spacing: 0.05em;
  }

  .card-stats {
    display: flex;
    gap: 0.5rem;
    font-size: 0.7rem;
    color: var(--c-text-secondary);
    flex-wrap: wrap;
  }

  .card-meta {
    display: flex;
    gap: 0.5rem;
    font-size: 0.6rem;
    color: var(--c-text-ghost);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .card-pb {
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    color: var(--c-text-subtle);
  }

  .card-pb b {
    color: var(--c-pb-gold);
    font-weight: normal;
  }

  .card-sound {
    font-size: 0.55rem;
    color: var(--c-text-subtle);
    line-height: 1.3;
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

  @media (max-width: 600px) {
    .profiles {
      gap: 0.5rem;
    }
    .profile-card {
      min-width: 120px;
      max-width: 140px;
      padding: 0.75rem 0.9rem;
    }
    .title {
      font-size: 2.5rem;
    }
  }
</style>
