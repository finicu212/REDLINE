/**
 * EngineAudio — Web Audio API engine sound with multiple layered systems.
 *
 * Layers:
 *   1. Engine tone    — BAC frequency bands (low/mid/high), crossfaded by normalized RPM
 *   2. Decel tone     — tw_off 4-band stack (verylow/low/lowmid/high) on throttle release
 *   3. Rev limiter    — limiter.wav gated loop when fuel cut is active
 *   4. Transmission   — trany_power_high.wav pitched by vehicle speed, louder in higher gears
 *   5. Shift thud     — synthesized low-freq transient on gear change
 *
 * Accepts a rich engine state object from drivetrain.getState().
 */

import { IDLE_RPM, REDLINE_RPM, normalizeRPM } from './constants.js';

const SAMPLE_RPM = 1000;

// --- Sample definitions ---

const ENGINE_ON = [
  { band: 'low',  file: '/audio/BAC_Mono_onlow.wav' },
  { band: 'mid',  file: '/audio/BAC_Mono_onmid.wav' },
  { band: 'high', file: '/audio/BAC_Mono_onhigh.wav' },
];

const ENGINE_OFF = [
  { band: 'verylow', file: '/audio/tw_offverylow_4.wav' },
  { band: 'low',     file: '/audio/tw_offlow_4.wav' },
  { band: 'lowmid',  file: '/audio/tw_offlowmid_4.wav' },
  { band: 'high',    file: '/audio/tw_offhigh_4.wav' },
];

const REV_FILE = '/audio/REV.wav';          // on-throttle near-redline loop, plays at native pitch
const LIMITER_FILE = '/audio/limiter.wav';
const TRANY_FILE = '/audio/trany_power_high.wav';

const ALL_FILES = [
  ...ENGINE_ON, ...ENGINE_OFF,
  { file: REV_FILE },
  { file: LIMITER_FILE },
  { file: TRANY_FILE },
];

// nRPM threshold where REV.wav starts fading in and pitched layers fade out
const REV_BLEND_START = 0.82;
const REV_BLEND_END = 0.95;

// --- Crossfade helpers ---

/** 3-band crossfade for on-throttle (low/mid/high). */
function computeOnGains(nRPM) {
  const n = Math.max(0, Math.min(1, nRPM));
  let low = 0, mid = 0, high = 0;

  if (n < 0.35) {
    low = 1;
  } else if (n < 0.55) {
    const t = (n - 0.35) / 0.2;
    low = Math.cos(t * Math.PI / 2);
    mid = Math.sin(t * Math.PI / 2);
  } else if (n < 0.7) {
    mid = 1;
  } else if (n < 0.9) {
    const t = (n - 0.7) / 0.2;
    mid  = Math.cos(t * Math.PI / 2);
    high = Math.sin(t * Math.PI / 2);
  } else {
    high = 1;
  }

  return { low, mid, high };
}

/** 4-band crossfade for off-throttle (verylow/low/lowmid/high). */
function computeOffGains(nRPM) {
  const n = Math.max(0, Math.min(1, nRPM));
  let verylow = 0, low = 0, lowmid = 0, high = 0;

  if (n < 0.2) {
    verylow = 1;
  } else if (n < 0.35) {
    const t = (n - 0.2) / 0.15;
    verylow = Math.cos(t * Math.PI / 2);
    low     = Math.sin(t * Math.PI / 2);
  } else if (n < 0.5) {
    low = 1;
  } else if (n < 0.65) {
    const t = (n - 0.5) / 0.15;
    low    = Math.cos(t * Math.PI / 2);
    lowmid = Math.sin(t * Math.PI / 2);
  } else if (n < 0.8) {
    lowmid = 1;
  } else if (n < 0.92) {
    const t = (n - 0.8) / 0.12;
    lowmid = Math.cos(t * Math.PI / 2);
    high   = Math.sin(t * Math.PI / 2);
  } else {
    high = 1;
  }

  return { verylow, low, lowmid, high };
}

// --- Main class ---

export class EngineAudio {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {Map<string, AudioBuffer>} */
    this.buffers = new Map();
    /** @type {GainNode|null} */
    this.masterGain = null;

    // Engine tone layer
    this._onSources = {};
    this._onGains = {};
    this._offSources = {};
    this._offGains = {};
    this._throttle = true;

    // REV layer (near-redline on-throttle, native pitch)
    this._revSource = null;
    this._revGain = null;

    // Limiter layer
    this._limiterSource = null;
    this._limiterGain = null;
    this._limiterActive = false;

    // Transmission whine layer
    this._tranySource = null;
    this._tranyGain = null;

    // Shift thud
    this._lastGear = -1;

    this._started = false;

    // Debug state (read by DebugOverlay)
    this.debugBandGains = {};
    this.debugPlaybackRate = 0;
  }

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

  start() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Update all audio layers from drivetrain state.
   * @param {object} state - from drivetrain.getState()
   */
  setEngineState(state) {
    if (!this.ctx || this.buffers.size === 0) return;

    const { rpm, throttle, gear, speed, shifting, revLimiterActive } = state;
    const clamped = Math.max(IDLE_RPM, Math.min(rpm, REDLINE_RPM));
    const nRPM = normalizeRPM(clamped);
    const now = this.ctx.currentTime;

    // --- 1. Engine tone layers ---
    if (throttle !== this._throttle || !this._started) {
      this._throttle = throttle;
      this._rebuildEngineSources();
      this._started = true;
    }

    const pitchRate = clamped / SAMPLE_RPM;
    this.debugPlaybackRate = pitchRate;

    if (throttle) {
      // On-throttle: 3-band pitched layers + REV.wav at top end
      const gains = computeOnGains(nRPM);

      // Compute REV crossfade: 0 below REV_BLEND_START, 1 at REV_BLEND_END
      let revBlend = 0;
      if (nRPM > REV_BLEND_START) {
        revBlend = Math.min(1, (nRPM - REV_BLEND_START) / (REV_BLEND_END - REV_BLEND_START));
      }
      // Equal-power crossfade between pitched layers and REV
      const pitchedMix = Math.cos(revBlend * Math.PI / 2);
      const revMix = Math.sin(revBlend * Math.PI / 2);

      this.debugBandGains = { ...gains, rev: revMix };

      for (const entry of ENGINE_ON) {
        const src = this._onSources[entry.band];
        if (src) src.playbackRate.setTargetAtTime(pitchRate, now, 0.03);
        const g = this._onGains[entry.band];
        if (g) g.gain.setTargetAtTime((gains[entry.band] || 0) * pitchedMix, now, 0.05);
      }

      // REV layer: start if needed, set gain — never touch playbackRate
      this._ensureRevSource(now);
      if (this._revGain) {
        this._revGain.gain.setTargetAtTime(revMix, now, 0.05);
      }
    } else {
      // When off-throttle, fade REV out
      if (this._revGain) {
        this._revGain.gain.setTargetAtTime(0, now, 0.03);
      }
      // Off-throttle: 4-band
      const gains = computeOffGains(nRPM);
      this.debugBandGains = gains;
      for (const entry of ENGINE_OFF) {
        const src = this._offSources[entry.band];
        if (src) src.playbackRate.setTargetAtTime(pitchRate, now, 0.03);
        const g = this._offGains[entry.band];
        if (g) g.gain.setTargetAtTime(gains[entry.band] || 0, now, 0.05);
      }
    }

    // --- 2. Rev limiter layer ---
    this._updateLimiter(revLimiterActive, now);

    // --- 3. Transmission whine layer ---
    this._updateTransmission(speed, gear, now);

    // --- 4. Shift thud ---
    if (this._lastGear === -1) this._lastGear = gear;
    if (gear !== this._lastGear && !shifting) {
      this._playShiftThud();
      this._lastGear = gear;
    }
    if (shifting) this._lastGear = -1; // reset so we detect completion
  }

  // Backwards-compat: keep setRPM working
  setRPM(rpm, throttle = true) {
    this.setEngineState({ rpm, throttle, gear: 0, speed: 0, shifting: false, revLimiterActive: false });
  }

  stop() {
    this._fadeOutEngineSources();
    this._stopRevSource();
    this._stopLimiter();
    this._stopTransmission();
    if (this.ctx) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => { if (this.ctx) this.ctx.suspend(); }, 300);
    }
  }

  // === Engine tone sources ===

  /** @private */
  _rebuildEngineSources() {
    this._fadeOutEngineSources();

    const set = this._throttle ? ENGINE_ON : ENGINE_OFF;
    const sources = this._throttle ? this._onSources : this._offSources;
    const gains = this._throttle ? this._onGains : this._offGains;

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

      sources[entry.band] = source;
      gains[entry.band] = gain;
    }
  }

  /** @private */
  _fadeOutEngineSources() {
    const now = this.ctx ? this.ctx.currentTime : 0;

    for (const set of [this._onGains, this._offGains]) {
      for (const band of Object.keys(set)) {
        if (set[band]) set[band].gain.setTargetAtTime(0, now, 0.033);
      }
    }
    for (const set of [this._onSources, this._offSources]) {
      for (const band of Object.keys(set)) {
        const src = set[band];
        if (src) setTimeout(() => { try { src.stop(); } catch {} }, 300);
      }
    }
    this._onSources = {};
    this._onGains = {};
    this._offSources = {};
    this._offGains = {};
  }

  // === REV layer (near-redline, native pitch) ===

  /** @private Start REV loop if not already running. */
  _ensureRevSource(now) {
    if (this._revSource) return;
    const buf = this.buffers.get(REV_FILE);
    if (!buf) return;

    this._revGain = this.ctx.createGain();
    this._revGain.gain.value = 0;
    this._revGain.connect(this.masterGain);

    this._revSource = this.ctx.createBufferSource();
    this._revSource.buffer = buf;
    this._revSource.loop = true;
    // No playbackRate modification — plays at recorded pitch always
    this._revSource.connect(this._revGain);
    this._revSource.start(now);
  }

  /** @private */
  _stopRevSource() {
    if (this._revGain) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      this._revGain.gain.setTargetAtTime(0, now, 0.02);
    }
    const src = this._revSource;
    if (src) setTimeout(() => { try { src.stop(); } catch {} }, 200);
    this._revSource = null;
    this._revGain = null;
  }

  // === Rev limiter layer ===

  /** @private */
  _updateLimiter(active, now) {
    if (active && !this._limiterActive) {
      // Start limiter loop
      const buf = this.buffers.get(LIMITER_FILE);
      if (!buf) return;
      this._limiterGain = this.ctx.createGain();
      this._limiterGain.gain.value = 0;
      this._limiterGain.connect(this.masterGain);

      this._limiterSource = this.ctx.createBufferSource();
      this._limiterSource.buffer = buf;
      this._limiterSource.loop = true;
      this._limiterSource.connect(this._limiterGain);
      this._limiterSource.start(now);

      this._limiterGain.gain.setTargetAtTime(0.6, now, 0.02);
      this._limiterActive = true;
    } else if (!active && this._limiterActive) {
      // Fade out limiter
      if (this._limiterGain) {
        this._limiterGain.gain.setTargetAtTime(0, now, 0.02);
      }
      const src = this._limiterSource;
      if (src) setTimeout(() => { try { src.stop(); } catch {} }, 200);
      this._limiterSource = null;
      this._limiterGain = null;
      this._limiterActive = false;
    }
  }

  /** @private */
  _stopLimiter() {
    if (this._limiterSource) {
      try { this._limiterSource.stop(); } catch {}
    }
    this._limiterSource = null;
    this._limiterGain = null;
    this._limiterActive = false;
  }

  // === Transmission whine layer ===

  /** @private */
  _updateTransmission(speed, gear, now) {
    // Start on first call
    if (!this._tranySource && gear > 0) {
      const buf = this.buffers.get(TRANY_FILE);
      if (!buf) return;
      this._tranyGain = this.ctx.createGain();
      this._tranyGain.gain.value = 0;
      this._tranyGain.connect(this.masterGain);

      this._tranySource = this.ctx.createBufferSource();
      this._tranySource.buffer = buf;
      this._tranySource.loop = true;
      this._tranySource.connect(this._tranyGain);
      this._tranySource.start(now);
    }

    if (!this._tranySource || !this._tranyGain) return;

    // Pitch by speed: 1.0 at ~60 km/h, range 0.3–3.0
    const pitchRate = Math.max(0.3, Math.min(3.0, speed / 60));
    this._tranySource.playbackRate.setTargetAtTime(pitchRate, now, 0.05);

    // Volume: scales with speed and gear (louder in higher gears)
    const gearFactor = gear > 0 ? (gear / 5) : 0;
    const speedFactor = Math.min(1, speed / 120);
    const vol = gearFactor * speedFactor * 0.15; // subtle
    this._tranyGain.gain.setTargetAtTime(vol, now, 0.08);
  }

  /** @private */
  _stopTransmission() {
    if (this._tranySource) {
      try { this._tranySource.stop(); } catch {}
    }
    this._tranySource = null;
    this._tranyGain = null;
  }

  // === Shift thud (synthesized) ===

  /** @private */
  _playShiftThud() {
    if (!this.ctx) return;

    // Short burst of low-frequency oscillation simulating drivetrain clunk
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 60;
    osc.frequency.setTargetAtTime(30, this.ctx.currentTime, 0.03);

    const gain = this.ctx.createGain();
    gain.gain.value = 0.25;
    gain.gain.setTargetAtTime(0, this.ctx.currentTime + 0.01, 0.025);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.15);
  }
}
