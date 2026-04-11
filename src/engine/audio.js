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
 *   - Turbo whine: sample-based or synth fallback, pitched by spool
 *   - BOV: blow-off valve sample or synth noise burst
 *
 * Accepts an optional profile (from profiles.js) for per-engine audio paths,
 * RPM limits, exhaust params, and cylinder count.
 */

import { IDLE_RPM, REDLINE_RPM, normalizeRPM, normalizeRPMFor } from './constants.js';

// Samples recorded at 1000 RPM
const SAMPLE_RPM = 1000;
// Pitch factor: cents per RPM deviation from SAMPLE_RPM
const RPM_PITCH_FACTOR = 0.2;

// --- Default sample definitions (BAC engine, used when no profile) ---

const DEFAULT_ENGINE_SAMPLES = {
  on_low:  '/audio/BAC_Mono_onlow.wav',
  on_high: '/audio/BAC_Mono_onhigh.wav',
  off_low: '/audio/BAC_Mono_offlow.wav',
  off_high: '/audio/BAC_Mono_offhigh.wav',
};

const DEFAULT_ENGINE_EXTRA_OFF = {
  off_mid:      '/audio/BAC_Mono_offmid.wav',
  off_veryhigh: '/audio/BAC_Mono_offveryhigh.wav',
};

const DEFAULT_TRANY_DECEL = [
  { band: 'verylow', file: '/audio/tw_offverylow_4.wav' },
  { band: 'low',     file: '/audio/tw_offlow_4.wav' },
  { band: 'lowmid',  file: '/audio/tw_offlowmid_4.wav' },
  { band: 'high',    file: '/audio/tw_offhigh_4.wav' },
];

const DEFAULT_REV_FILE = '/audio/REV.wav';
const DEFAULT_LIMITER_FILE = '/audio/limiter.wav';
const DEFAULT_TRANY_FILE = '/audio/trany_power_high.wav';

// Turbo sample defaults — replace with real recordings
const DEFAULT_TURBO_WHINE_FILE = '/audio/turbo_whine.wav';
const DEFAULT_TURBO_BOV_FILE = '/audio/turbo_bov.wav';

// RPM crossfade zone (matching markeasting)
const RPM_XFADE_LOW = 3000;
const RPM_XFADE_HIGH = 6500;

// Soft limiter hold: gain/pitch hunting while the taper holds RPM at redline
const LIMITER_HUNT_HZ = 7;
const LIMITER_HUNT_DEPTH = 0.22;
const LIMITER_HUNT_CENTS = 18;

// Recorded limiter loop stays on this long after the last cut
const LIMITER_LOOP_HOLD_S = 0.15;

// Hard limiter pop: short bandpassed noise burst per fuel cut
const LIMITER_POP_MS = 45;
const LIMITER_POP_LEVEL = 0.35;

// Helical gear hum: pinion teeth for mesh frequency, peak gain (very quiet)
const GEAR_HUM_TEETH = 11;
const GEAR_HUM_LEVEL = 0.018;

// Bank mode off-throttle path: quieter, lowpassed, opening up with RPM
const BANK_OFF_LEVEL = 0.55;
const BANK_OFF_CUTOFF_BASE = 400;     // Hz
const BANK_OFF_CUTOFF_PER_RPM = 0.35; // Hz per RPM → ~2.5 kHz at 6000

// REV.wav blend zone (normalized RPM)
const REV_BLEND_START = 0.995;
const REV_BLEND_END = 0.999;

// --- Build file lists from profile or defaults ---

function buildFileConfig(profile) {
  if (!profile || !profile.audio) {
    return {
      engineSamples: DEFAULT_ENGINE_SAMPLES,
      engineExtraOff: DEFAULT_ENGINE_EXTRA_OFF,
      tranyDecel: DEFAULT_TRANY_DECEL,
      revFile: DEFAULT_REV_FILE,
      limiterFile: DEFAULT_LIMITER_FILE,
      tranyFile: DEFAULT_TRANY_FILE,
      turboWhineFile: DEFAULT_TURBO_WHINE_FILE,
      turboBovFile: DEFAULT_TURBO_BOV_FILE,
    };
  }
  const a = profile.audio;
  if (a.bank) {
    return {
      bank: a.bank,
      engineSamples: {},
      engineExtraOff: {},
      // null disables a layer (road cars: no straight-cut whine, no harsh limiter loop)
      tranyDecel: a.tranyDecel === undefined ? DEFAULT_TRANY_DECEL : (a.tranyDecel || []),
      revFile: a.rev === undefined ? DEFAULT_REV_FILE : a.rev,
      limiterFile: a.limiter === undefined ? DEFAULT_LIMITER_FILE : a.limiter,
      tranyFile: a.trany === undefined ? DEFAULT_TRANY_FILE : a.trany,
      turboWhineFile: a.turboWhine === undefined ? DEFAULT_TURBO_WHINE_FILE : a.turboWhine,
      turboBovFile: a.turboBov === undefined ? DEFAULT_TURBO_BOV_FILE : a.turboBov,
    };
  }
  return {
    engineSamples: {
      on_low:  a.on_low,
      on_high: a.on_high,
      off_low: a.off_low,
      off_high: a.off_high,
    },
    engineExtraOff: {
      off_mid:      a.off_mid,
      off_veryhigh: a.off_veryhigh,
    },
    tranyDecel: a.tranyDecel || DEFAULT_TRANY_DECEL,
    revFile: a.rev || DEFAULT_REV_FILE,
    limiterFile: a.limiter || DEFAULT_LIMITER_FILE,
    tranyFile: a.trany || DEFAULT_TRANY_FILE,
    turboWhineFile: a.turboWhine || DEFAULT_TURBO_WHINE_FILE,
    turboBovFile: a.turboBov || DEFAULT_TURBO_BOV_FILE,
  };
}

function buildAllFiles(fc, hasTurbo = true) {
  const files = [
    ...(fc.bank || []).map(({ file }) => ({ file })),
    ...Object.values(fc.engineSamples).map(file => ({ file })),
    ...Object.values(fc.engineExtraOff).map(file => ({ file })),
    ...fc.tranyDecel,
    { file: fc.revFile },
    { file: fc.limiterFile },
    { file: fc.tranyFile },
  ];
  if (hasTurbo) {
    files.push({ file: fc.turboWhineFile }, { file: fc.turboBovFile });
  }
  return files.filter(entry => entry.file);
}

// --- Exhaust IR generator ---

/**
 * Procedurally generate a short impulse response simulating exhaust pipe resonance.
 */
function generateExhaustIR(ctx, { pipeLength = 1.5, diameter = 0.08, reflections = 12 } = {}) {
  const c = 343;
  const roundTrip = (2 * pipeLength) / c;
  const sampleRate = ctx.sampleRate;
  const delaySamples = Math.round(roundTrip * sampleRate);

  const irLength = delaySamples * reflections + 128;
  const buffer = ctx.createBuffer(1, irLength, sampleRate);
  const data = buffer.getChannelData(0);

  const diameterFactor = Math.min(1, diameter / 0.1);
  const decayPerBounce = 0.35 + 0.25 * diameterFactor;

  data[0] = 1.0;

  let amplitude = 1.0;
  for (let i = 1; i <= reflections; i++) {
    amplitude *= decayPerBounce;
    const sign = (i % 2 === 0) ? 1 : -1;
    const pos = i * delaySamples;
    if (pos < irLength) {
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
    gain1: Math.cos((1.0 - x) * 0.5 * Math.PI),
    gain2: Math.cos(x * 0.5 * Math.PI),
  };
}

/**
 * Bank crossfade weights: equal-power blend of the two samples whose recorded
 * RPMs bracket `rpm`; edge samples hold outside the bank's range.
 */
export function bankWeights(bankRPMs, rpm) {
  const w = new Array(bankRPMs.length).fill(0);
  if (!(rpm > bankRPMs[0])) { w[0] = 1; return w; }
  const last = bankRPMs.length - 1;
  if (rpm >= bankRPMs[last]) { w[last] = 1; return w; }
  let i = 0;
  while (rpm > bankRPMs[i + 1]) i++;
  const x = (rpm - bankRPMs[i]) / (bankRPMs[i + 1] - bankRPMs[i]);
  w[i] = Math.cos(x * Math.PI / 2);
  w[i + 1] = Math.sin(x * Math.PI / 2);
  return w;
}

// Bank samples are recorded at their true RPM, so pitch is physical (ratio in cents).
// Clamped at ±4 octaves: single-sample banks stretch that far, anything beyond is inaudible anyway.
function bankDetune(rpm, sampleRPM) {
  return Math.max(-4800, Math.min(4800, 1200 * Math.log2(rpm / sampleRPM)));
}

/** Convert RPM to detune cents: (rpm - 1000) * 0.2 */
function rpmToDetune(rpm) {
  return (rpm - SAMPLE_RPM) * RPM_PITCH_FACTOR;
}

// --- Main class ---

export class EngineAudio {
  /**
   * @param {object} [profile] - Engine profile from profiles.js. Omit for BAC/S2000 defaults.
   */
  constructor(profile) {
    this.ctx = null;
    this.buffers = new Map();
    this.masterGain = null;

    // Profile-derived config
    const p = profile || null;
    this._idleRPM = p ? p.idleRPM : IDLE_RPM;
    this._redlineRPM = p ? p.redlineRPM : REDLINE_RPM;
    this._cylCount = p ? p.cylinders : 4;

    // Audio file config
    this._fileConfig = buildFileConfig(p);
    this._allFiles = buildAllFiles(this._fileConfig, this._hasTurbo);

    // Exhaust params from profile
    this._pipeLength = p?.exhaust?.pipeLength ?? 1.5;
    this._pipeDiameter = p?.exhaust?.diameter ?? 0.08;
    this._exhaustWet = p?.exhaust?.wet ?? 0.3;

    // Helical gear hum (road cars) — synthesized, pitched by output-shaft speed
    this._gearHum = !!p?.audio?.gearHum;
    this._finalDrive = p?.finalDrive ?? 4.1;
    this._tireCircumference = p?.tireCircumference ?? 1.88;
    this._humOsc = null;
    this._humGain = null;

    // Limiter character (soft hunt phase, hard-cut edge detection)
    this._huntPhase = 0;
    this._wasLimiting = false;
    this._popBuffer = null;
    this.debugLimiterHunt = 0;

    // Bank mode (profile.audio.bank): N samples recorded at known RPMs
    this._bank = this._fileConfig.bank || null;
    this._bankSources = [];
    this._bankOnGains = [];
    this._bankOffGains = [];
    this._bankOffFilter = null;

    // Core engine: 4 simultaneous sources
    this._engineSources = {};
    this._engineGains = {};
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

    // Shift thud
    this._lastGear = -1;

    // Turbo audio — sample-based whine + BOV (with synth fallback)
    this._hasTurbo = profile ? !!profile.turbo : true;
    this._turboBov = profile?.turbo?.bov !== false;
    this._turboWhineLevel = profile?.turbo?.whineLevel ?? 1;
    this._turboWhineSource = null;
    this._turboWhineGain = null;
    this._turboOsc = null;           // synth fallback if sample missing
    this._turboFilterNode = null;
    this._turboGain = null;
    this._bovActive = false;

    this._started = false;

    // Per-cylinder micro-variation
    this._fireCount = 0;
    this._cylDetuneOffsets = [1.2, -2.1, 0.8, -1.5, 2.4, -0.6];
    this._cylGainOffsets = [0.02, -0.015, 0.025, -0.01, 0.018, -0.02];

    // Debug
    this.debugBandGains = {};
    this.debugDetune = 0;
  }

  /** Normalize RPM using this engine's idle/redline range */
  _normalizeRPM(rpm) {
    return normalizeRPMFor(rpm, this._idleRPM, this._redlineRPM);
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

    // Turbo whine: sample-based if available, synth fallback otherwise.
    // Initialized after sample loading (see _startTurboWhine)
    if (this._hasTurbo) {
      this._turboGain = this.ctx.createGain();
      this._turboGain.gain.value = 0;
      this._turboGain.connect(this._engineBus);
    }

    let loaded = 0;
    const total = this._allFiles.length;
    for (const entry of this._allFiles) {
      try {
        const res = await fetch(entry.file);
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
        this.buffers.set(entry.file, audioBuf);
      } catch (e) {
        console.warn(`Failed to load ${entry.file}:`, e);
      }
      loaded++;
      if (onProgress) onProgress(loaded / total);
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

    const { throttle, gear, speed, shifting, revLimiterActive,
            shiftOscillation = 0, shiftOscAmplitude = 0, shiftOscRPMDelta = 0 } = state;
    // Non-finite values throw inside AudioParam.setTargetAtTime and would kill the render loop
    const rpm = Number.isFinite(state.rpm) ? state.rpm : this._idleRPM;
    const pitchRPM = Math.max(this._idleRPM, rpm);  // pitch follows actual RPM past redline
    const nRPM = this._normalizeRPM(Math.min(rpm, this._redlineRPM)); // gain crossfade stays in normal range
    const now = this.ctx.currentTime;

    // --- 1. Pitch via detune + shift oscillation wobble + per-cylinder jitter ---
    const baseDetune = rpmToDetune(pitchRPM);
    const detuneWobble = shiftOscillation * 45;

    // Per-cylinder micro-variation: advance fire counter based on RPM
    const firesPerSec = (pitchRPM / 60) * (this._cylCount / 2); // 4-stroke: fires = RPM/60 * cyl/2
    this._fireCount += firesPerSec * (1 / 60); // assume ~60fps
    const cylIdx = Math.floor(this._fireCount) % this._cylDetuneOffsets.length;
    const microDetune = this._cylDetuneOffsets[cylIdx];
    const microGain = this._cylGainOffsets[cylIdx];

    const detune = baseDetune + detuneWobble;
    const detuneWithMicro = detune + microDetune;
    this.debugDetune = detune;
    this.debugShiftOsc = shiftOscAmplitude;

    for (const key of Object.keys(this._engineSources)) {
      const src = this._engineSources[key];
      if (src) src.detune.setTargetAtTime(detuneWithMicro, now, 0.015);
    }
    for (const key of Object.keys(this._extraOffSources)) {
      const src = this._extraOffSources[key];
      if (src) src.detune.setTargetAtTime(detuneWithMicro, now, 0.015);
    }

    const gainMod = 1.0 - shiftOscillation * 0.30;

    // --- 2. Crossfade gains ---
    // Partial throttle blending: on-samples scale with throttle, off-samples
    // fill the gap. At 30% throttle you hear quiet on-samples + louder off-samples.
    // Equal-power curves keep total energy constant across the blend.
    // Rev limiter = fuel cut = off-throttle sound (engine is coasting even if pedal is down)
    const { limiterStyle, limiterLoad = 0 } = state;
    const pedal = Math.max(0, Math.min(1, throttle));
    // Soft limiter: partial, smoothed dip instead of a full on/off chop
    const throttleVal = revLimiterActive ? (limiterStyle === 'soft' ? pedal * 0.5 : 0) : pedal;
    const onGain  = Math.sin(throttleVal * Math.PI / 2);   // 0→0, 0.5→0.71, 1→1
    const offGain = Math.cos(throttleVal * Math.PI / 2);   // 0→1, 0.5→0.71, 1→0
    // Additional volume scaling: on-samples get quieter at low throttle
    // so partial throttle sounds genuinely subdued, not just a blend
    const onVolume = 0.3 + 0.7 * throttleVal;              // 0→0.3, 0.5→0.65, 1→1

    // RPM crossfade: low ↔ high (3000–6500 RPM)
    const { gain1: highGain, gain2: lowGain } = crossFade(pitchRPM, RPM_XFADE_LOW, RPM_XFADE_HIGH);

    // REV crossfade for on-throttle near redline — only when actually combusting
    // (not during rev limiter fuel cut, not off-throttle)
    const actualThrottle = Math.max(0, Math.min(1, throttle));
    let revBlend = 0;
    const hasRev = this.buffers.has(this._fileConfig.revFile);
    if (hasRev && !revLimiterActive && actualThrottle > 0.3 && nRPM > REV_BLEND_START) {
      revBlend = Math.min(1, (nRPM - REV_BLEND_START) / (REV_BLEND_END - REV_BLEND_START)) * actualThrottle;
    }
    const pitchedMix = Math.cos(revBlend * Math.PI / 2);
    const revMix = Math.sin(revBlend * Math.PI / 2);

    if (this._bank) {
      // Hard cuts must be audible per bounce; soft ones are smeared
      const tau = limiterStyle === 'hard' ? 0.006 : limiterStyle === 'soft' ? 0.035 : 0.05;
      // Soft hold: engine keeps singing at the limit, with a gentle ignition-retard "hunt"
      this._huntPhase = (this._huntPhase + LIMITER_HUNT_HZ / 60) % 1;
      const hunt = 0.5 + 0.5 * Math.sin(2 * Math.PI * this._huntPhase);
      const huntGain = 1 - LIMITER_HUNT_DEPTH * limiterLoad * hunt;
      const huntDetune = LIMITER_HUNT_CENTS * limiterLoad * (hunt - 0.5);
      this.debugLimiterHunt = limiterLoad * hunt;
      this._updateBank(pitchRPM, detuneWobble + microDetune + huntDetune,
        onGain * onVolume * pitchedMix * gainMod * huntGain, offGain * gainMod, 1.0 + microGain, now, tau);
    }

    // Hard limiter: exhaust pop on every fuel-cut bounce
    // Skipped when the car ships a recorded limiter loop — that already carries the stutter
    const hasLimiterSample = this.buffers.has(this._fileConfig.limiterFile);
    if (limiterStyle === 'hard' && revLimiterActive && !this._wasLimiting && pedal > 0.1 && !hasLimiterSample) {
      this._playLimiterPop(now);
    }
    this._wasLimiting = revLimiterActive;

    const engineGainValues = {
      on_low:   onGain * onVolume * lowGain * pitchedMix * gainMod,
      on_high:  onGain * onVolume * highGain * pitchedMix * gainMod,
      off_low:  offGain * lowGain * gainMod,
      off_high: offGain * highGain * gainMod,
    };

    this.debugBandGains = this._bank
      ? { ...this._bankDebugGains, rev: revMix }
      : { ...engineGainValues, rev: revMix };

    for (const key of Object.keys(engineGainValues)) {
      const g = this._engineGains[key];
      if (g) g.gain.setTargetAtTime(engineGainValues[key] * (1.0 + microGain), now, 0.05);
    }

    // Extra off-throttle layers (mid, veryhigh) — blend in off-throttle mid range
    const midBlend = Math.max(0, 1 - Math.abs(pitchRPM - 4500) / 2000); // peaks at 4500
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
      // Fast decay (0.01s) when cutting, slower attack (0.05s) when blending in
      const revTau = revMix > this._revGain.gain.value ? 0.05 : 0.01;
      this._revGain.gain.setTargetAtTime(revMix, now, revTau);
    }

    // --- 4. Transmission decel layers ---
    this._updateDecelLayers(offGain, pitchRPM, detune, now);

    // --- 5. Rev limiter (only audible when driver is on throttle — no fuel cut sound when coasting) ---
    // Hold the loop between rapid cuts so a 20 Hz stutter doesn't restart it every cut
    if (revLimiterActive) this._lastCutTime = now;
    const onLimiter = revLimiterActive || now - (this._lastCutTime ?? -1) < LIMITER_LOOP_HOLD_S;
    this._updateLimiter(onLimiter && actualThrottle > 0.1, now);

    // --- 6. Transmission whine (with oscillation modulation) ---
    this._updateTransmission(speed, gear, gainMod, now);
    if (this._gearHum) this._updateGearHum(speed, gear, pedal, now);

    // --- 7. Shift thud (context-aware) ---
    if (this._lastGear === -1) this._lastGear = gear;
    if (gear !== this._lastGear && !shifting) {
      this._playShiftThud(shiftOscRPMDelta, throttle);
      this._lastGear = gear;
    }
    if (shifting) this._lastGear = -1;

    // --- 8. Turbo whine + BOV ---
    if (this._hasTurbo) this._updateTurboAudio(state, now);
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
    const fc = this._fileConfig;

    if (this._bank) this._startBankSources(now);

    // Core 4 engine samples
    for (const [key, file] of Object.entries(fc.engineSamples)) {
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
    for (const [key, file] of Object.entries(fc.engineExtraOff)) {
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
    for (const entry of fc.tranyDecel) {
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
    for (const g of [...this._bankOnGains, ...this._bankOffGains]) {
      if (g) g.gain.setTargetAtTime(0, now, 0.033);
    }
    for (const src of this._bankSources) {
      if (src) setTimeout(() => { try { src.stop(); } catch {} }, 300);
    }
    this._bankSources = [];
    this._bankOnGains = [];
    this._bankOffGains = [];
    this._engineSources = {};
    this._engineGains = {};
    this._extraOffSources = {};
    this._extraOffGains = {};
    this._decelSources = {};
    this._decelGains = {};
    this._started = false;
  }

  // === Multi-sample bank ===

  /**
   * One looping source per bank sample, feeding two gains: dry on-throttle and a
   * lowpassed off-throttle path (overrun is duller and quieter than combustion).
   */
  _startBankSources(now) {
    this._bankOffFilter = this.ctx.createBiquadFilter();
    this._bankOffFilter.type = 'lowpass';
    this._bankOffFilter.Q.value = 0.7;
    this._bankOffFilter.connect(this._engineBus);

    for (const { file } of this._bank) {
      const buf = this.buffers.get(file);
      const source = buf ? this.ctx.createBufferSource() : null;
      const onGain = this.ctx.createGain();
      const offGain = this.ctx.createGain();
      onGain.gain.value = 0;
      offGain.gain.value = 0;
      onGain.connect(this._engineBus);
      offGain.connect(this._bankOffFilter);
      if (source) {
        source.buffer = buf;
        source.loop = true;
        source.connect(onGain);
        source.connect(offGain);
        // Random start offset so neighbouring loops don't phase-lock
        source.start(now, Math.random() * (buf.duration || 0));
      }
      this._bankSources.push(source);
      this._bankOnGains.push(onGain);
      this._bankOffGains.push(offGain);
    }
  }

  _updateBank(rpm, extraDetune, onLevel, offLevel, micro, now, tau = 0.05) {
    const weights = bankWeights(this._bank.map(b => b.rpm), rpm);
    const debug = {};
    let loudest = 0;
    this._bank.forEach((entry, i) => {
      const src = this._bankSources[i];
      const detune = bankDetune(rpm, entry.rpm) + extraDetune;
      if (src) src.detune.setTargetAtTime(detune, now, 0.015);
      if (weights[i] > loudest) { loudest = weights[i]; this.debugDetune = detune; }
      const vol = entry.volume ?? 1;
      const on = weights[i] * onLevel * vol * micro;
      const off = weights[i] * offLevel * vol * BANK_OFF_LEVEL;
      this._bankOnGains[i].gain.setTargetAtTime(on, now, tau);
      this._bankOffGains[i].gain.setTargetAtTime(off, now, tau);
      debug[`${entry.rpm}`] = on + off;
    });
    if (this._bankOffFilter) {
      this._bankOffFilter.frequency.setTargetAtTime(BANK_OFF_CUTOFF_BASE + rpm * BANK_OFF_CUTOFF_PER_RPM, now, 0.05);
    }
    this._bankDebugGains = debug;
  }

  // === Transmission decel layers ===

  _updateDecelLayers(offGain, rpm, detune, now) {
    const n = this._normalizeRPM(rpm);
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

    const decelVol = offGain * 0.3;
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
    const buf = this.buffers.get(this._fileConfig.revFile);
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
      const buf = this.buffers.get(this._fileConfig.limiterFile);
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
      const buf = this.buffers.get(this._fileConfig.tranyFile);
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

    const gearFactor = gear > 0 ? (gear / 5) : 0;
    const speedFactor = Math.min(1, speed / 120);
    this._tranyGain.gain.setTargetAtTime(gearFactor * speedFactor * 0.15 * gainMod, now, 0.08);
  }

  /**
   * Helical gears mesh smoothly: a quiet, lowpassed hum at tooth-mesh frequency
   * (output shaft rev/s × teeth), slightly louder under load. No straight-cut scream.
   */
  _updateGearHum(speed, gear, pedal, now) {
    if (!this._humOsc) {
      this._humFilter = this.ctx.createBiquadFilter();
      this._humFilter.type = 'lowpass';
      this._humFilter.frequency.value = 900;
      this._humFilter.connect(this._engineBus);
      this._humGain = this.ctx.createGain();
      this._humGain.gain.value = 0;
      this._humGain.connect(this._humFilter);
      this._humOsc = this.ctx.createOscillator();
      this._humOsc.type = 'triangle';
      this._humOsc.connect(this._humGain);
      this._humOsc.start(now);
    }
    const wheelRPS = (speed / 3.6) / this._tireCircumference;
    const meshHz = Math.max(20, Math.min(1200, wheelRPS * this._finalDrive * GEAR_HUM_TEETH));
    this._humOsc.frequency.setTargetAtTime(meshHz, now, 0.05);
    const speedFactor = Math.min(1, speed / 150);
    const level = gear > 0 ? GEAR_HUM_LEVEL * speedFactor * (0.6 + 0.4 * pedal) : 0;
    this._humGain.gain.setTargetAtTime(level, now, 0.1);
  }

  _playLimiterPop(now) {
    if (!this._popBuffer) {
      const sr = this.ctx.sampleRate;
      const len = Math.round(sr * LIMITER_POP_MS / 1000);
      this._popBuffer = this.ctx.createBuffer(1, len, sr);
      const d = this._popBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.25));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this._popBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 280 + Math.random() * 320; // vary so bounces don't sound machine-gunned
    bp.Q.value = 1.2;
    const g = this.ctx.createGain();
    g.gain.value = LIMITER_POP_LEVEL * (0.8 + Math.random() * 0.4);
    src.connect(bp);
    bp.connect(g);
    g.connect(this._engineBus);
    src.start(now);
    this.debugPops = (this.debugPops || 0) + 1;
  }

  _stopTransmission() {
    if (this._tranySource) { try { this._tranySource.stop(); } catch {} }
    this._tranySource = null;
    this._tranyGain = null;
    if (this._humOsc) { try { this._humOsc.stop(); } catch {} }
    this._humOsc = null;
    this._humGain = null;
  }

  // === Shift thud ===

  _playShiftThud(rpmDelta, throttle) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const magnitude = Math.min(1, Math.abs(rpmDelta) / 3000);
    if (magnitude < 0.05) return;

    const throttleFactor = throttle ? 1.0 : 0.6;
    const isDownshift = rpmDelta > 0;
    const baseFreq = isDownshift ? 80 : 55;
    const endFreq = isDownshift ? 40 : 25;
    const amp = (0.1 + magnitude * 0.25) * throttleFactor;
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

  // === Turbo audio ===

  /** Start turbo whine source — sample-based or synth fallback. */
  _startTurboWhine() {
    if (this._turboWhineSource || this._turboOsc) return;

    const buf = this.buffers.get(this._fileConfig.turboWhineFile);
    if (buf) {
      // Sample-based: loop the recording, pitch via playbackRate
      this._turboWhineSource = this.ctx.createBufferSource();
      this._turboWhineSource.buffer = buf;
      this._turboWhineSource.loop = true;
      this._turboWhineSource.playbackRate.value = 0.2;
      this._turboWhineSource.connect(this._turboGain);
      this._turboWhineSource.start();
    } else {
      // Synth fallback: sawtooth → bandpass → gain
      this._turboOsc = this.ctx.createOscillator();
      this._turboOsc.type = 'sawtooth';
      this._turboOsc.frequency.value = 400;

      this._turboFilterNode = this.ctx.createBiquadFilter();
      this._turboFilterNode.type = 'bandpass';
      this._turboFilterNode.frequency.value = 2000;
      this._turboFilterNode.Q.value = 3;

      this._turboOsc.connect(this._turboFilterNode);
      this._turboFilterNode.connect(this._turboGain);
      this._turboOsc.start();
    }
  }

  _updateTurboAudio(state, now) {
    const { turboSpool = 0, boostPsi = 0, bovActive = false } = state;

    // Lazy-start whine source on first frame with spool
    if (turboSpool > 0.01 && !this._turboWhineSource && !this._turboOsc) {
      this._startTurboWhine();
    }

    // Turbo whine: pitch and volume scale with spool
    if (this._turboWhineSource) {
      // Sample mode: playbackRate 0.2 (idle) → 2.5 (full spool)
      const rate = 0.2 + turboSpool * 2.3;
      this._turboWhineSource.playbackRate.setTargetAtTime(rate, now, 0.06);
    } else if (this._turboOsc) {
      // Synth mode: 400 Hz → 5000 Hz
      const freq = 400 + turboSpool * 4600;
      this._turboOsc.frequency.setTargetAtTime(freq, now, 0.06);
      this._turboFilterNode.frequency.setTargetAtTime(freq * 1.2, now, 0.06);
    }

    if (this._turboGain) {
      // Volume: spool² curve, subtle mix
      const vol = turboSpool * turboSpool * 0.12 * this._turboWhineLevel;
      this._turboGain.gain.setTargetAtTime(vol, now, 0.04);
    }

    // BOV: play sample or synth burst
    if (bovActive && !this._bovActive && this._turboBov) {
      this._bovActive = true;
      this._playBOV(boostPsi, now);
    } else if (!bovActive) {
      this._bovActive = false;
    }
  }

  _playBOV(boostPsi, now) {
    if (!this.ctx) return;
    const intensity = Math.min(1, boostPsi / 14.7);

    const bovBuf = this.buffers.get(this._fileConfig.turboBovFile);
    if (bovBuf) {
      // Sample-based BOV
      const source = this.ctx.createBufferSource();
      source.buffer = bovBuf;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.25 * intensity;
      source.connect(gain);
      gain.connect(this.masterGain); // BOV is external, bypass engine bus
      source.start(now);
    } else {
      // Synth fallback: shaped noise burst
      const duration = 0.3;
      const sampleRate = this.ctx.sampleRate;
      const samples = Math.floor(duration * sampleRate);
      const buffer = this.ctx.createBuffer(1, samples, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < samples; i++) {
        // Decaying noise envelope
        const env = Math.exp(-i / (sampleRate * 0.06));
        data[i] = (Math.random() * 2 - 1) * env;
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 1.2;

      const gain = this.ctx.createGain();
      gain.gain.value = 0.2 * intensity;

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      source.start(now);
      source.stop(now + duration);
    }
  }

  // === Exhaust convolution reverb ===

  _setExhaustMix(wet) {
    this._exhaustWet = Math.max(0, Math.min(1, wet));
    if (this._dryGain) this._dryGain.gain.value = Math.cos(this._exhaustWet * Math.PI / 2);
    if (this._wetGain) this._wetGain.gain.value = Math.sin(this._exhaustWet * Math.PI / 2);
  }

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
