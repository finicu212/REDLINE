/**
 * EngineAudio — Web Audio API engine sound with crossfade between frequency layers.
 *
 * Uses BAC engine samples from markeasting/engine-audio. Samples are frequency-band
 * layers (low/mid/high) of the same engine recording. All play simultaneously;
 * crossfade weights shift the tonal balance as RPM changes.
 *
 * All zones are derived from the shared RPM constants — change REDLINE_RPM in
 * constants.js and audio automatically scales to match.
 *
 * Architecture:
 *   - A single playbackRate drives pitch for ALL bands (they're from the same
 *     recording, so they must stay in sync). This is the "RPM sound".
 *   - Crossfade gains shift low→mid→high as normalized RPM goes 0→1.
 *   - The SAMPLE_RPM constant is the RPM at which the recording sounds "native".
 *     playbackRate = currentRPM / SAMPLE_RPM.
 */

import { IDLE_RPM, REDLINE_RPM, normalizeRPM } from './constants.js';

// The RPM at which the raw samples sound correct without pitch shift.
// All BAC samples were recorded at this engine speed.
const SAMPLE_RPM = 1000;

const SAMPLES = {
  on: [
    { band: 'low',  file: '/audio/BAC_Mono_onlow.wav' },
    { band: 'mid',  file: '/audio/BAC_Mono_onmid.wav' },
    { band: 'high', file: '/audio/BAC_Mono_onhigh.wav' },
  ],
  off: [
    { band: 'low',      file: '/audio/BAC_Mono_offlow.wav' },
    { band: 'mid',      file: '/audio/BAC_Mono_offmid.wav' },
    { band: 'high',     file: '/audio/BAC_Mono_offhigh.wav' },
    { band: 'veryhigh', file: '/audio/BAC_Mono_offveryhigh.wav' },
  ],
};

const ALL_FILES = [...SAMPLES.on, ...SAMPLES.off];

/**
 * Compute per-band gains from normalized RPM (0–1).
 *
 * Three overlapping triangular windows across the 0–1 range:
 *   low:  peaks at 0.0, fades to 0 by 0.5
 *   mid:  peaks at 0.5, fades to 0 at 0.0 and 1.0
 *   high: peaks at 1.0, fades to 0 by 0.5
 *
 * Equal-power (cos/sin) curves at the crossover points prevent volume dips.
 */
function computeBandGains(nRPM) {
  // Clamp to [0, 1] — below idle or above redline should pin to the edges
  const n = Math.max(0, Math.min(1, nRPM));

  let low = 0, mid = 0, high = 0;

  if (n < 0.35) {
    // Pure low zone (0 – 0.35)
    low = 1;
  } else if (n < 0.55) {
    // Low → mid crossfade (0.35 – 0.55)
    const t = (n - 0.35) / 0.2;
    low  = Math.cos(t * Math.PI / 2);
    mid  = Math.sin(t * Math.PI / 2);
  } else if (n < 0.7) {
    // Pure mid zone (0.55 – 0.7)
    mid = 1;
  } else if (n < 0.9) {
    // Mid → high crossfade (0.7 – 0.9)
    const t = (n - 0.7) / 0.2;
    mid  = Math.cos(t * Math.PI / 2);
    high = Math.sin(t * Math.PI / 2);
  } else {
    // Pure high zone (0.9 – 1.0)
    high = 1;
  }

  return { low, mid, high };
}

export class EngineAudio {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {Map<string, AudioBuffer>} keyed by file path */
    this.buffers = new Map();
    /** @type {GainNode|null} */
    this.masterGain = null;

    this._sources = {};
    this._gains = {};
    this._throttle = true;
    this._started = false;
  }

  /**
   * Load and decode all audio samples.
   * @param {(progress: number) => void} onProgress
   */
  async init(onProgress) {
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.5;
    this.masterGain.connect(this.ctx.destination);

    let loaded = 0;
    for (const entry of ALL_FILES) {
      try {
        const res = await fetch(entry.file);
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
        this.buffers.set(entry.file, audioBuf);
      } catch (e) {
        console.warn(`Failed to load ${entry.file}:`, e);
      }
      loaded++;
      if (onProgress) onProgress(loaded / ALL_FILES.length);
    }
  }

  /** Resume the AudioContext (must be called from a user gesture). */
  start() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Update engine sound for the given RPM and throttle state.
   * @param {number} rpm
   * @param {boolean} [throttle=true]
   */
  setRPM(rpm, throttle = true) {
    if (!this.ctx || this.buffers.size === 0) return;

    const clamped = Math.max(IDLE_RPM, Math.min(rpm, REDLINE_RPM));

    // Switch sample set if throttle state changed
    if (throttle !== this._throttle || !this._started) {
      this._throttle = throttle;
      this._rebuildSources();
      this._started = true;
    }

    const set = throttle ? SAMPLES.on : SAMPLES.off;
    const now = this.ctx.currentTime;

    // Single playbackRate for all bands — they're from the same recording
    const pitchRate = clamped / SAMPLE_RPM;
    for (const entry of set) {
      const src = this._sources[entry.band];
      if (src) {
        src.playbackRate.setTargetAtTime(pitchRate, now, 0.03);
      }
    }

    // Crossfade based on normalized RPM (0 = idle, 1 = redline)
    const nRPM = normalizeRPM(clamped);
    const gains = computeBandGains(nRPM);

    // Apply gains with smoothing
    for (const entry of set) {
      const gain = this._gains[entry.band];
      if (!gain) continue;

      let val = gains[entry.band] || 0;

      // Off-throttle veryhigh: subtle blend in the top 20%
      if (entry.band === 'veryhigh' && !throttle && nRPM > 0.8) {
        val = ((nRPM - 0.8) / 0.2) * 0.4;
      }

      gain.gain.setTargetAtTime(val, now, 0.05);
    }
  }

  /** Gracefully stop all audio. */
  stop() {
    this._fadeOutAll();
    if (this.ctx) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => {
        if (this.ctx) this.ctx.suspend();
      }, 300);
    }
  }

  /** @private */
  _rebuildSources() {
    this._fadeOutAll();
    const set = this._throttle ? SAMPLES.on : SAMPLES.off;

    for (const entry of set) {
      const buf = this.buffers.get(entry.file);
      if (!buf) continue;

      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.masterGain);

      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.connect(gain);
      source.start(this.ctx.currentTime);

      this._sources[entry.band] = source;
      this._gains[entry.band] = gain;
    }
  }

  /** @private */
  _fadeOutAll() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const band of Object.keys(this._gains)) {
      const gain = this._gains[band];
      if (gain) gain.gain.setTargetAtTime(0, now, 0.033);
      const src = this._sources[band];
      if (src) setTimeout(() => { try { src.stop(); } catch {} }, 300);
    }
    this._sources = {};
    this._gains = {};
  }
}
