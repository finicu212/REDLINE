/**
 * EngineAudio — Web Audio API engine sound matching markeasting/engine-audio pitch model.
 *
 * Architecture (matching the reference implementation):
 *   - 4 engine samples always playing simultaneously: on_low, on_high, off_low, off_high
 *   - Gains = throttle_factor × rpm_factor (no source rebuilding on throttle change)
 *   - Pitch via detune: cents = (rpm - 1000) * 0.2
 *     At 7200 RPM: 1240 cents ~= 2.05x playbackRate (NOT 7.2x!)
 *   - RPM crossfade: low↔high between 3000–6500 RPM (equal-power)
 *   - Throttle crossfade: on↔off between 0–1 (equal-power)
 *
 * Additional layers:
 *   - REV.wav: on-throttle near-redline loop at native pitch
 *   - limiter.wav: gated loop during fuel cut
 *   - trany_power_high.wav: transmission whine pitched by speed
 *   - tw_off* files: transmission decel layer
 *   - Shift thud: synthesized transient
 */

import { IDLE_RPM, REDLINE_RPM, normalizeRPM } from './constants.js';

// Samples recorded at 1000 RPM
const SAMPLE_RPM = 1000;
// Pitch factor: cents per RPM deviation from SAMPLE_RPM
const RPM_PITCH_FACTOR = 0.2;

// --- Sample definitions ---

// Core engine samples (all 4 play simultaneously, gains modulated by throttle × RPM)
const ENGINE_SAMPLES = {
  on_low:  '/audio/BAC_Mono_onlow.wav',
  on_high: '/audio/BAC_Mono_onhigh.wav',
  off_low: '/audio/BAC_Mono_offlow.wav',
  off_high: '/audio/BAC_Mono_offhigh.wav',
};

// Additional off-throttle samples (mid frequencies not in 2-layer model)
const ENGINE_EXTRA_OFF = {
  off_mid:      '/audio/BAC_Mono_offmid.wav',
  off_veryhigh: '/audio/BAC_Mono_offveryhigh.wav',
};

// Transmission decel layers
const TRANY_DECEL = [
  { band: 'verylow', file: '/audio/tw_offverylow_4.wav' },
  { band: 'low',     file: '/audio/tw_offlow_4.wav' },
  { band: 'lowmid',  file: '/audio/tw_offlowmid_4.wav' },
  { band: 'high',    file: '/audio/tw_offhigh_4.wav' },
];

const REV_FILE = '/audio/REV.wav';
const LIMITER_FILE = '/audio/limiter.wav';
const TRANY_FILE = '/audio/trany_power_high.wav';

const ALL_FILES = [
  ...Object.values(ENGINE_SAMPLES).map(file => ({ file })),
  ...Object.values(ENGINE_EXTRA_OFF).map(file => ({ file })),
  ...TRANY_DECEL,
  { file: REV_FILE },
  { file: LIMITER_FILE },
  { file: TRANY_FILE },
];

// RPM crossfade zone (matching markeasting)
const RPM_XFADE_LOW = 3000;
const RPM_XFADE_HIGH = 6500;

// REV.wav blend zone (normalized RPM)
const REV_BLEND_START = 0.995;
const REV_BLEND_END = 0.999;

// --- Exhaust IR generator ---

/**
 * Procedurally generate a short impulse response simulating exhaust pipe resonance.
 * Models a tube resonator: initial impulse followed by decaying reflections at the
 * round-trip delay interval, with phase inversion at open-end bounces.
 */
function generateExhaustIR(ctx, { pipeLength = 1.5, diameter = 0.08, reflections = 12 } = {}) {
  const c = 343; // speed of sound m/s
  const roundTrip = (2 * pipeLength) / c;
  const sampleRate = ctx.sampleRate;
  const delaySamples = Math.round(roundTrip * sampleRate);

  const irLength = delaySamples * reflections + 128;
  const buffer = ctx.createBuffer(1, irLength, sampleRate);
  const data = buffer.getChannelData(0);

  // Wider pipes lose less energy per bounce
  const diameterFactor = Math.min(1, diameter / 0.1);
  const decayPerBounce = 0.35 + 0.25 * diameterFactor;

  // Direct sound
  data[0] = 1.0;

  // Reflected impulses with progressive decay
  let amplitude = 1.0;
  for (let i = 1; i <= reflections; i++) {
    amplitude *= decayPerBounce;
    const sign = (i % 2 === 0) ? 1 : -1; // open-end reflection inverts phase
    const pos = i * delaySamples;
    if (pos < irLength) {
      // Spread impulse slightly to simulate HF wall absorption
      data[pos] = sign * amplitude * 0.7;
      if (pos + 1 < irLength) data[pos + 1] = sign * amplitude * 0.2;
      if (pos - 1 >= 0) data[pos - 1] += sign * amplitude * 0.1;
    }
  }

  return buffer;
}

// --- Crossfade helper (matching markeasting's equal-power) ---

function crossFade(value, start, end) {
  const x = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return {
    gain1: Math.cos((1.0 - x) * 0.5 * Math.PI), // fades IN as value increases
    gain2: Math.cos(x * 0.5 * Math.PI),          // fades OUT as value increases
  };
}

/** Convert RPM to detune cents: (rpm - 1000) * 0.2 */
function rpmToDetune(rpm) {
  return (rpm - SAMPLE_RPM) * RPM_PITCH_FACTOR;
}

// --- Main class ---

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.masterGain = null;

    // Core engine: 4 simultaneous sources
    this._engineSources = {};  // keyed by 'on_low', 'on_high', 'off_low', 'off_high'
    this._engineGains = {};
    // Extra off-throttle engine layers
    this._extraOffSources = {};
    this._extraOffGains = {};

    // REV layer
    this._revSource = null;
    this._revGain = null;

    // Limiter layer
    this._limiterSource = null;
    this._limiterGain = null;
    this._limiterActive = false;

    // Transmission whine (speed-based)
    this._tranySource = null;
    this._tranyGain = null;

    // Transmission decel layers
    this._decelSources = {};
    this._decelGains = {};

    // Exhaust convolution reverb
    this._engineBus = null;
    this._convolver = null;
    this._dryGain = null;
    this._wetGain = null;
    this._pipeLength = 1.5;
    this._pipeDiameter = 0.08;
    this._exhaustWet = 0.3;

    // Shift thud
    this._lastGear = -1;

    this._started = false;

    // Per-cylinder micro-variation: subtle per-fire jitter to break mechanical perfection
    // Cycles through per-cylinder offsets based on firing count
    this._fireCount = 0;
    this._cylCount = 4;  // updated from state
    // Pre-computed per-cylinder detune offsets (±3 cents) and gain offsets (±3%)
    this._cylDetuneOffsets = [1.2, -2.1, 0.8, -1.5, 2.4, -0.6];
    this._cylGainOffsets = [0.02, -0.015, 0.025, -0.01, 0.018, -0.02];

    // Debug
    this.debugBandGains = {};
    this.debugDetune = 0;
  }

  async init(onProgress) {
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.5;
    this.masterGain.connect(this.ctx.destination);

    // Engine bus → dry/wet split → masterGain
    this._engineBus = this.ctx.createGain();
    this._engineBus.gain.value = 1.0;

    this._dryGain = this.ctx.createGain();
    this._wetGain = this.ctx.createGain();
    this._convolver = this.ctx.createConvolver();
    this._convolver.buffer = generateExhaustIR(this.ctx, {
      pipeLength: this._pipeLength,
      diameter: this._pipeDiameter,
    });

    this._engineBus.connect(this._dryGain);
    this._engineBus.connect(this._convolver);
    this._convolver.connect(this._wetGain);
    this._dryGain.connect(this.masterGain);
    this._wetGain.connect(this.masterGain);
    this._setExhaustMix(this._exhaustWet);

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
    this._startAllEngineSources();
  }

  /**
   * Update all audio layers from drivetrain state.
   * @param {object} state - from drivetrain.getState()
   */
  setEngineState(state) {
    if (!this.ctx || this.buffers.size === 0) return;
    if (!this._started) {
      this._startAllEngineSources();
    }

    const { rpm, throttle, gear, speed, shifting, revLimiterActive,
            shiftOscillation = 0, shiftOscAmplitude = 0, shiftOscRPMDelta = 0 } = state;
    const clamped = Math.max(IDLE_RPM, Math.min(rpm, REDLINE_RPM));
    const nRPM = normalizeRPM(clamped);
    const now = this.ctx.currentTime;

    // --- 1. Pitch via detune + shift oscillation wobble + per-cylinder jitter ---
    const baseDetune = rpmToDetune(clamped);
    const detuneWobble = shiftOscillation * 45;

    // Per-cylinder micro-variation: advance fire counter based on RPM
    // At 6000 RPM with 4 cylinders: 200 fires/sec. We approximate by advancing
    // the counter each frame proportional to RPM, cycling through cylinder offsets.
    const firesPerSec = (clamped / 60) * (this._cylCount / 2); // 4-stroke: fires = RPM/60 * cyl/2
    this._fireCount += firesPerSec * (1 / 60); // assume ~60fps
    const cylIdx = Math.floor(this._fireCount) % this._cylDetuneOffsets.length;
    const microDetune = this._cylDetuneOffsets[cylIdx];
    const microGain = this._cylGainOffsets[cylIdx];

    const detune = baseDetune + detuneWobble;
    const detuneWithMicro = detune + microDetune;
    this.debugDetune = detune;  // debug shows clean value without micro-jitter
    this.debugShiftOsc = shiftOscAmplitude;

    for (const key of Object.keys(this._engineSources)) {
      const src = this._engineSources[key];
      if (src) src.detune.setTargetAtTime(detuneWithMicro, now, 0.015);
    }
    for (const key of Object.keys(this._extraOffSources)) {
      const src = this._extraOffSources[key];
      if (src) src.detune.setTargetAtTime(detuneWithMicro, now, 0.015);
    }

    // Gain modulation factor: oscillation modulates engine volume ±15%
    // Out of phase with detune (when pitch goes up, gain dips slightly — load transfer feel)
    // Gain breathing during shift oscillation
    const gainMod = 1.0 - shiftOscillation * 0.30;

    // --- 2. Crossfade gains ---
    // Partial throttle blending: on-samples scale with throttle, off-samples
    // fill the gap. At 30% throttle you hear quiet on-samples + louder off-samples.
    // Equal-power curves keep total energy constant across the blend.
    const throttleVal = Math.max(0, Math.min(1, throttle));
    const onGain  = Math.sin(throttleVal * Math.PI / 2);   // 0→0, 0.5→0.71, 1→1
    const offGain = Math.cos(throttleVal * Math.PI / 2);   // 0→1, 0.5→0.71, 1→0
    // Additional volume scaling: on-samples get quieter at low throttle
    // so partial throttle sounds genuinely subdued, not just a blend
    const onVolume = 0.3 + 0.7 * throttleVal;              // 0→0.3, 0.5→0.65, 1→1

    // RPM crossfade: low ↔ high (3000–6500 RPM)
    const { gain1: highGain, gain2: lowGain } = crossFade(clamped, RPM_XFADE_LOW, RPM_XFADE_HIGH);

    // REV crossfade for on-throttle near redline (scales with throttle)
    let revBlend = 0;
    if (throttleVal > 0.3 && nRPM > REV_BLEND_START) {
      revBlend = Math.min(1, (nRPM - REV_BLEND_START) / (REV_BLEND_END - REV_BLEND_START)) * throttleVal;
    }
    const pitchedMix = Math.cos(revBlend * Math.PI / 2);
    const revMix = Math.sin(revBlend * Math.PI / 2);

    // Apply gains: on-samples get onGain × onVolume, off-samples get offGain
    // Debug values use clean gainMod; audio nodes get per-cylinder micro-variation
    const engineGainValues = {
      on_low:   onGain * onVolume * lowGain * pitchedMix * gainMod,
      on_high:  onGain * onVolume * highGain * pitchedMix * gainMod,
      off_low:  offGain * lowGain * gainMod,
      off_high: offGain * highGain * gainMod,
    };

    this.debugBandGains = { ...engineGainValues, rev: revMix };

    for (const key of Object.keys(engineGainValues)) {
      const g = this._engineGains[key];
      if (g) g.gain.setTargetAtTime(engineGainValues[key] * (1.0 + microGain), now, 0.05);
    }

    // Extra off-throttle layers (mid, veryhigh) — blend in off-throttle mid range
    const midBlend = Math.max(0, 1 - Math.abs(clamped - 4500) / 2000); // peaks at 4500
    const vhBlend = highGain * 0.5; // subtle top-end addition
    if (this._extraOffGains.off_mid) {
      this._extraOffGains.off_mid.gain.setTargetAtTime(offGain * midBlend * 0.6, now, 0.05);
    }
    if (this._extraOffGains.off_veryhigh) {
      this._extraOffGains.off_veryhigh.gain.setTargetAtTime(offGain * vhBlend, now, 0.05);
    }

    // --- 3. REV layer ---
    this._ensureRevSource(now);
    if (this._revGain) {
      this._revGain.gain.setTargetAtTime(revMix, now, 0.05);
    }

    // --- 4. Transmission decel layers ---
    this._updateDecelLayers(offGain, clamped, detune, now);

    // --- 5. Rev limiter ---
    this._updateLimiter(revLimiterActive, now);

    // --- 6. Transmission whine (with oscillation modulation) ---
    this._updateTransmission(speed, gear, gainMod, now);

    // --- 7. Shift thud (context-aware) ---
    if (this._lastGear === -1) this._lastGear = gear;
    if (gear !== this._lastGear && !shifting) {
      this._playShiftThud(shiftOscRPMDelta, throttle);
      this._lastGear = gear;
    }
    if (shifting) this._lastGear = -1;
  }

  setRPM(rpm, throttle = true) {
    this.setEngineState({ rpm, throttle, gear: 0, speed: 0, shifting: false, revLimiterActive: false });
  }

  stop() {
    this._stopAllEngineSources();
    this._stopRevSource();
    this._stopLimiter();
    this._stopTransmission();
    this._stopDecelLayers();
    if (this.ctx) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      setTimeout(() => { if (this.ctx) this.ctx.suspend(); }, 300);
    }
  }

  // === Engine sources (all 4 always running) ===

  _startAllEngineSources() {
    if (this._started) return;
    const now = this.ctx.currentTime;

    // Core 4 engine samples
    for (const [key, file] of Object.entries(ENGINE_SAMPLES)) {
      const buf = this.buffers.get(file);
      if (!buf) continue;

      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this._engineBus);

      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.connect(gain);
      source.start(now);

      this._engineSources[key] = source;
      this._engineGains[key] = gain;
    }

    // Extra off-throttle layers
    for (const [key, file] of Object.entries(ENGINE_EXTRA_OFF)) {
      const buf = this.buffers.get(file);
      if (!buf) continue;

      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this._engineBus);

      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.connect(gain);
      source.start(now);

      this._extraOffSources[key] = source;
      this._extraOffGains[key] = gain;
    }

    // Decel transmission layers
    for (const entry of TRANY_DECEL) {
      const buf = this.buffers.get(entry.file);
      if (!buf) continue;

      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this._engineBus);

      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.loop = true;
      source.connect(gain);
      source.start(now);

      this._decelSources[entry.band] = source;
      this._decelGains[entry.band] = gain;
    }

    this._started = true;
  }

  _stopAllEngineSources() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const gains of [this._engineGains, this._extraOffGains, this._decelGains]) {
      for (const key of Object.keys(gains)) {
        if (gains[key]) gains[key].gain.setTargetAtTime(0, now, 0.033);
      }
    }
    for (const sources of [this._engineSources, this._extraOffSources, this._decelSources]) {
      for (const key of Object.keys(sources)) {
        const src = sources[key];
        if (src) setTimeout(() => { try { src.stop(); } catch {} }, 300);
      }
    }
    this._engineSources = {};
    this._engineGains = {};
    this._extraOffSources = {};
    this._extraOffGains = {};
    this._decelSources = {};
    this._decelGains = {};
    this._started = false;
  }

  // === Transmission decel layers ===

  _updateDecelLayers(offGain, rpm, detune, now) {
    // 4-band crossfade for decel transmission noise
    const n = normalizeRPM(rpm);
    let verylow = 0, low = 0, lowmid = 0, high = 0;

    if (n < 0.25) { verylow = 1; }
    else if (n < 0.4) {
      const t = (n - 0.25) / 0.15;
      verylow = Math.cos(t * Math.PI / 2);
      low = Math.sin(t * Math.PI / 2);
    } else if (n < 0.55) { low = 1; }
    else if (n < 0.7) {
      const t = (n - 0.55) / 0.15;
      low = Math.cos(t * Math.PI / 2);
      lowmid = Math.sin(t * Math.PI / 2);
    } else if (n < 0.85) { lowmid = 1; }
    else if (n < 0.95) {
      const t = (n - 0.85) / 0.1;
      lowmid = Math.cos(t * Math.PI / 2);
      high = Math.sin(t * Math.PI / 2);
    } else { high = 1; }

    const decelVol = offGain * 0.3; // subtle layer alongside engine off sounds
    const vals = { verylow, low, lowmid, high };

    for (const band of Object.keys(vals)) {
      const src = this._decelSources[band];
      if (src) src.detune.setTargetAtTime(detune, now, 0.03);
      const g = this._decelGains[band];
      if (g) g.gain.setTargetAtTime(vals[band] * decelVol, now, 0.05);
    }
  }

  _stopDecelLayers() {
    // handled by _stopAllEngineSources
  }

  // === REV layer ===

  _ensureRevSource(now) {
    if (this._revSource) return;
    const buf = this.buffers.get(REV_FILE);
    if (!buf) return;

    this._revGain = this.ctx.createGain();
    this._revGain.gain.value = 0;
    this._revGain.connect(this._engineBus);

    this._revSource = this.ctx.createBufferSource();
    this._revSource.buffer = buf;
    this._revSource.loop = true;
    this._revSource.connect(this._revGain);
    this._revSource.start(now);
  }

  _stopRevSource() {
    if (this._revGain) {
      this._revGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    }
    const src = this._revSource;
    if (src) setTimeout(() => { try { src.stop(); } catch {} }, 200);
    this._revSource = null;
    this._revGain = null;
  }

  // === Rev limiter ===

  _updateLimiter(active, now) {
    if (active && !this._limiterActive) {
      const buf = this.buffers.get(LIMITER_FILE);
      if (!buf) return;
      this._limiterGain = this.ctx.createGain();
      this._limiterGain.gain.value = 0;
      this._limiterGain.connect(this._engineBus);

      this._limiterSource = this.ctx.createBufferSource();
      this._limiterSource.buffer = buf;
      this._limiterSource.loop = true;
      this._limiterSource.connect(this._limiterGain);
      this._limiterSource.start(now);

      this._limiterGain.gain.setTargetAtTime(0.6, now, 0.02);
      this._limiterActive = true;
    } else if (!active && this._limiterActive) {
      if (this._limiterGain) this._limiterGain.gain.setTargetAtTime(0, now, 0.02);
      const src = this._limiterSource;
      if (src) setTimeout(() => { try { src.stop(); } catch {} }, 200);
      this._limiterSource = null;
      this._limiterGain = null;
      this._limiterActive = false;
    }
  }

  _stopLimiter() {
    if (this._limiterSource) { try { this._limiterSource.stop(); } catch {} }
    this._limiterSource = null;
    this._limiterGain = null;
    this._limiterActive = false;
  }

  // === Transmission whine ===

  _updateTransmission(speed, gear, gainMod, now) {
    if (!this._tranySource && gear > 0) {
      const buf = this.buffers.get(TRANY_FILE);
      if (!buf) return;
      this._tranyGain = this.ctx.createGain();
      this._tranyGain.gain.value = 0;
      this._tranyGain.connect(this._engineBus);

      this._tranySource = this.ctx.createBufferSource();
      this._tranySource.buffer = buf;
      this._tranySource.loop = true;
      this._tranySource.connect(this._tranyGain);
      this._tranySource.start(now);
    }

    if (!this._tranySource || !this._tranyGain) return;

    const pitchRate = Math.max(0.3, Math.min(3.0, speed / 60));
    this._tranySource.playbackRate.setTargetAtTime(pitchRate, now, 0.05);

    // Transmission whine also modulated by shift oscillation
    const gearFactor = gear > 0 ? (gear / 5) : 0;
    const speedFactor = Math.min(1, speed / 120);
    this._tranyGain.gain.setTargetAtTime(gearFactor * speedFactor * 0.15 * gainMod, now, 0.08);
  }

  _stopTransmission() {
    if (this._tranySource) { try { this._tranySource.stop(); } catch {} }
    this._tranySource = null;
    this._tranyGain = null;
  }

  // === Shift thud ===

  /**
   * Context-aware shift thud.
   * @param {number} rpmDelta - signed RPM change (negative = upshift, positive = downshift)
   * @param {boolean} throttle - whether throttle was applied during shift
   */
  _playShiftThud(rpmDelta, throttle) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Scale by RPM delta magnitude: bigger jump = louder thud
    const magnitude = Math.min(1, Math.abs(rpmDelta) / 3000);
    if (magnitude < 0.05) return; // skip tiny shifts (e.g. near-idle)

    // Throttle adds intensity: WOT shift is harsher than off-throttle
    const throttleFactor = throttle ? 1.0 : 0.6;

    // Base frequency: downshifts are higher pitched (sharper engagement)
    const isDownshift = rpmDelta > 0;
    const baseFreq = isDownshift ? 80 : 55;
    const endFreq = isDownshift ? 40 : 25;

    // Amplitude: 0.1 (gentle) to 0.35 (violent)
    const amp = (0.1 + magnitude * 0.25) * throttleFactor;

    // Decay time: bigger shifts ring longer
    const decayTau = 0.02 + magnitude * 0.02;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = baseFreq;
    osc.frequency.setTargetAtTime(endFreq, now, 0.03);

    const gain = this.ctx.createGain();
    gain.gain.value = amp;
    gain.gain.setTargetAtTime(0, now + 0.01, decayTau);

    osc.connect(gain);
    gain.connect(this._engineBus);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  // === Exhaust convolution reverb ===

  _setExhaustMix(wet) {
    this._exhaustWet = Math.max(0, Math.min(1, wet));
    if (this._dryGain) this._dryGain.gain.value = Math.cos(this._exhaustWet * Math.PI / 2);
    if (this._wetGain) this._wetGain.gain.value = Math.sin(this._exhaustWet * Math.PI / 2);
  }

  /**
   * Update exhaust pipe parameters at runtime.
   * @param {object} opts
   * @param {number} [opts.pipeLength] - pipe length in meters (0.5–3.0)
   * @param {number} [opts.diameter] - pipe diameter in meters (0.04–0.15)
   * @param {number} [opts.wetMix] - dry/wet mix 0–1
   */
  setExhaustParams({ pipeLength, diameter, wetMix } = {}) {
    if (!this.ctx || !this._convolver) return;
    let regenerate = false;
    if (pipeLength !== undefined) { this._pipeLength = pipeLength; regenerate = true; }
    if (diameter !== undefined) { this._pipeDiameter = diameter; regenerate = true; }
    if (regenerate) {
      this._convolver.buffer = generateExhaustIR(this.ctx, {
        pipeLength: this._pipeLength,
        diameter: this._pipeDiameter,
      });
    }
    if (wetMix !== undefined) this._setExhaustMix(wetMix);
  }
}
