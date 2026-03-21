/**
 * EngineAudio — Web Audio API engine sound with crossfade between frequency layers.
 *
 * Uses BAC engine samples from markeasting/engine-audio. The samples are split
 * by throttle state (on/off) and frequency band (low/mid/high), all recorded
 * at ~1000 RPM. Pitch shifting via playbackRate simulates RPM changes.
 *
 * RPM-to-layer crossfade zones:
 *   850–3000  → low
 *   3000–5000 → low ↔ mid crossfade
 *   5000–6500 → mid ↔ high crossfade
 *   6500–9000 → high (+ veryhigh blend on off-throttle)
 */

const REFERENCE_RPM = 1000;

const SAMPLES = {
  on: [
    { band: 'low',  file: '/audio/BAC_Mono_onlow.wav',  minRPM: 850,  maxRPM: 5000 },
    { band: 'mid',  file: '/audio/BAC_Mono_onmid.wav',  minRPM: 3000, maxRPM: 6500 },
    { band: 'high', file: '/audio/BAC_Mono_onhigh.wav', minRPM: 5000, maxRPM: 9000 },
  ],
  off: [
    { band: 'low',      file: '/audio/BAC_Mono_offlow.wav',      minRPM: 850,  maxRPM: 5000 },
    { band: 'mid',      file: '/audio/BAC_Mono_offmid.wav',      minRPM: 3000, maxRPM: 6500 },
    { band: 'high',     file: '/audio/BAC_Mono_offhigh.wav',     minRPM: 5000, maxRPM: 9000 },
    { band: 'veryhigh', file: '/audio/BAC_Mono_offveryhigh.wav', minRPM: 6500, maxRPM: 9000 },
  ],
};

const ALL_FILES = [...SAMPLES.on, ...SAMPLES.off];

// Crossfade zones: RPM ranges where two layers blend
const ZONES = [
  { lo: 850,  hi: 3000, lower: 'low',  upper: 'low' },   // pure low
  { lo: 3000, hi: 5000, lower: 'low',  upper: 'mid' },   // low → mid
  { lo: 5000, hi: 6500, lower: 'mid',  upper: 'high' },  // mid → high
  { lo: 6500, hi: 9000, lower: 'high', upper: 'high' },   // pure high
];

export class EngineAudio {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {Map<string, AudioBuffer>} keyed by file path */
    this.buffers = new Map();
    /** @type {GainNode|null} */
    this.masterGain = null;

    // Active layer sources and gains (keyed by band name)
    this._sources = {};
    this._gains = {};
    this._throttle = true; // true = revving (on), false = decel (off)
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
   * @param {boolean} [throttle=true] - true if revving, false if decelerating
   */
  setRPM(rpm, throttle = true) {
    if (!this.ctx || this.buffers.size === 0) return;

    const clamped = Math.max(850, Math.min(rpm, 9000));

    // Switch sample set if throttle state changed
    if (throttle !== this._throttle || !this._started) {
      this._throttle = throttle;
      this._rebuildSources();
      this._started = true;
    }

    const set = throttle ? SAMPLES.on : SAMPLES.off;
    const now = this.ctx.currentTime;

    // Pitch shift all active sources based on RPM
    const pitchRate = Math.max(0.7, Math.min(4.0, clamped / REFERENCE_RPM));
    for (const entry of set) {
      const src = this._sources[entry.band];
      if (src) src.playbackRate.value = pitchRate;
    }

    // Find current crossfade zone
    let zone = ZONES[0];
    for (const z of ZONES) {
      if (clamped >= z.lo) zone = z;
    }

    // Compute per-band gain
    const bandGains = {};
    for (const entry of set) {
      bandGains[entry.band] = 0;
    }

    if (zone.lower === zone.upper) {
      // Pure zone — single band at full volume
      bandGains[zone.lower] = 1;
    } else {
      // Crossfade zone — equal-power blend
      const t = (clamped - zone.lo) / (zone.hi - zone.lo);
      bandGains[zone.lower] = Math.cos(t * Math.PI / 2);
      bandGains[zone.upper] = Math.sin(t * Math.PI / 2);
    }

    // Off-throttle: blend veryhigh above 6500
    if (!throttle && bandGains.veryhigh !== undefined && clamped > 6500) {
      const t = (clamped - 6500) / (9000 - 6500);
      bandGains.veryhigh = t * 0.5; // subtle blend
    }

    // Apply gains with smoothing
    for (const entry of set) {
      const gain = this._gains[entry.band];
      if (gain) {
        const val = bandGains[entry.band] || 0;
        gain.gain.setTargetAtTime(val, now, 0.05);
      }
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

  /** @private Rebuild all source nodes for current throttle state. */
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

  /** @private Fade out and stop all current sources. */
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
