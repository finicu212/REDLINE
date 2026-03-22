/**
 * Engine profiles — each defines a complete vehicle powertrain:
 * torque curve, gearbox, RPM limits, inertia, exhaust, and audio paths.
 *
 * Audio: each profile points to a folder of 13 WAV files following
 * the same naming convention. The I4 NA profile uses the existing
 * BAC engine samples; others use placeholder paths.
 */

// --- Audio path helpers ---

function bacAudio() {
  return {
    on_low:       '/audio/BAC_Mono_onlow.wav',
    on_high:      '/audio/BAC_Mono_onhigh.wav',
    off_low:      '/audio/BAC_Mono_offlow.wav',
    off_high:     '/audio/BAC_Mono_offhigh.wav',
    off_mid:      '/audio/BAC_Mono_offmid.wav',
    off_veryhigh: '/audio/BAC_Mono_offveryhigh.wav',
    rev:          '/audio/REV.wav',
    limiter:      '/audio/limiter.wav',
    trany:        '/audio/trany_power_high.wav',
    tranyDecel: [
      { band: 'verylow', file: '/audio/tw_offverylow_4.wav' },
      { band: 'low',     file: '/audio/tw_offlow_4.wav' },
      { band: 'lowmid',  file: '/audio/tw_offlowmid_4.wav' },
      { band: 'high',    file: '/audio/tw_offhigh_4.wav' },
    ],
  };
}

function profileAudio(folder) {
  return {
    on_low:       `/audio/${folder}/on_low.wav`,
    on_high:      `/audio/${folder}/on_high.wav`,
    off_low:      `/audio/${folder}/off_low.wav`,
    off_high:     `/audio/${folder}/off_high.wav`,
    off_mid:      `/audio/${folder}/off_mid.wav`,
    off_veryhigh: `/audio/${folder}/off_veryhigh.wav`,
    rev:          `/audio/${folder}/rev.wav`,
    limiter:      `/audio/${folder}/limiter.wav`,
    trany:        `/audio/${folder}/trany_power.wav`,
    tranyDecel: [
      { band: 'verylow', file: `/audio/${folder}/tw_verylow.wav` },
      { band: 'low',     file: `/audio/${folder}/tw_low.wav` },
      { band: 'lowmid',  file: `/audio/${folder}/tw_lowmid.wav` },
      { band: 'high',    file: `/audio/${folder}/tw_high.wav` },
    ],
  };
}

// --- Profiles ---

/**
 * I4 NA — Honda S2000 AP1 (2.0L VTEC Inline-4)
 * The original REDLINE engine. High-revving NA with a peaky torque curve.
 * Uses existing BAC Mono audio samples.
 */
const I4_NA = {
  id: 'i4_na',
  name: 'I4 NA',
  description: '2.0L VTEC Inline-4',
  vehicle: 'Honda S2000 AP1',

  cylinders: 4,
  layout: 'inline',

  idleRPM: 850,
  redlineRPM: 7200,
  revCutRPM: 6900,
  maxRPM: 7200,
  tachoMaxRPM: 8000,

  torqueCurve: [
    [850,  120],
    [2000, 155],
    [3000, 180],
    [4000, 200],
    [5000, 220],
    [5800, 235],
    [6500, 240],
    [7000, 230],
    [7200, 220],
  ],

  gearRatios: [0, 3.133, 2.045, 1.481, 1.161, 0.943],
  finalDrive: 4.100,
  tireCircumference: 1.88,

  engineInertia: 0.15,
  vehicleInertia: 90,

  frictionTorque: 8,
  engineBrakingFactor: 12,
  brakeDecel: 9.0,

  shiftDuration: 150,

  exhaust: { pipeLength: 1.5, diameter: 0.08, wet: 0.30 },

  audio: bacAudio(),
};

/**
 * I4 Turbo — 2.0L Turbocharged Inline-4
 * BeamNG Hirochi Sunburst-style. Fat midrange plateau from turbo,
 * falls off at top. Quick-revving with short gearing.
 * NOTE: No turbo physics (boost/spool) — just the torque curve shape.
 */
const I4_TURBO = {
  id: 'i4_turbo',
  name: 'I4 Turbo',
  description: '2.0L Turbocharged Inline-4',
  vehicle: 'Sport Compact',

  cylinders: 4,
  layout: 'inline',

  idleRPM: 850,
  redlineRPM: 6800,
  revCutRPM: 6500,
  maxRPM: 6800,
  tachoMaxRPM: 7500,

  torqueCurve: [
    [850,  150],
    [2000, 200],
    [2500, 280],
    [3000, 330],
    [3500, 350],
    [4000, 340],
    [5000, 310],
    [6000, 270],
    [6500, 240],
    [6800, 220],
  ],

  gearRatios: [0, 3.587, 2.022, 1.384, 1.000, 0.861],
  finalDrive: 3.938,
  tireCircumference: 1.88,

  engineInertia: 0.18,
  vehicleInertia: 95,

  frictionTorque: 8,
  engineBrakingFactor: 14,
  brakeDecel: 9.0,

  shiftDuration: 150,

  exhaust: { pipeLength: 1.2, diameter: 0.07, wet: 0.25 },

  audio: profileAudio('i4_turbo'),
};

/**
 * V6 NA — 3.5L Naturally Aspirated V6
 * BeamNG ETK/Hirochi-style. Smooth linear power delivery, revvy,
 * 6-speed gearbox. A balanced GT cruiser.
 */
const V6_NA = {
  id: 'v6_na',
  name: 'V6 NA',
  description: '3.5L Naturally Aspirated V6',
  vehicle: 'GT Cruiser',

  cylinders: 6,
  layout: 'v',

  idleRPM: 750,
  redlineRPM: 7000,
  revCutRPM: 6700,
  maxRPM: 7000,
  tachoMaxRPM: 8000,

  torqueCurve: [
    [750,  180],
    [2000, 240],
    [3000, 280],
    [4000, 310],
    [4800, 330],
    [5500, 320],
    [6000, 300],
    [6500, 270],
    [7000, 250],
  ],

  gearRatios: [0, 3.296, 2.130, 1.517, 1.147, 0.921, 0.738],
  finalDrive: 3.692,
  tireCircumference: 1.96,

  engineInertia: 0.20,
  vehicleInertia: 100,

  frictionTorque: 9,
  engineBrakingFactor: 13,
  brakeDecel: 9.5,

  shiftDuration: 160,

  exhaust: { pipeLength: 1.5, diameter: 0.09, wet: 0.35 },

  audio: profileAudio('v6_na'),
};

/**
 * V8 NA — 5.0L Naturally Aspirated V8
 * BeamNG Gavril Barstow-style. Massive low-end torque, heavy flywheel,
 * lazy revving but powerful. Classic 4-speed muscle car.
 */
const V8_NA = {
  id: 'v8_na',
  name: 'V8 NA',
  description: '5.0L Naturally Aspirated V8',
  vehicle: 'Muscle Car',

  cylinders: 8,
  layout: 'v',

  idleRPM: 700,
  redlineRPM: 6200,
  revCutRPM: 5900,
  maxRPM: 6200,
  tachoMaxRPM: 7000,

  torqueCurve: [
    [700,  300],
    [1500, 400],
    [2500, 470],
    [3000, 500],
    [3800, 530],
    [4500, 510],
    [5000, 470],
    [5500, 420],
    [6000, 370],
    [6200, 340],
  ],

  gearRatios: [0, 2.66, 1.78, 1.30, 1.00],
  finalDrive: 3.73,
  tireCircumference: 2.04,

  engineInertia: 0.30,
  vehicleInertia: 120,

  frictionTorque: 10,
  engineBrakingFactor: 16,
  brakeDecel: 8.5,

  shiftDuration: 180,

  exhaust: { pipeLength: 1.8, diameter: 0.10, wet: 0.40 },

  audio: profileAudio('v8_na'),
};

// --- Exports ---

/** All user-selectable profiles, keyed by id */
export const PROFILES = {
  i4_na: I4_NA,
  i4_turbo: I4_TURBO,
  v6_na: V6_NA,
  v8_na: V8_NA,
};

/** Profile list for UI iteration (stable order) */
export const PROFILE_LIST = [I4_NA, I4_TURBO, V6_NA, V8_NA];

/** Default profile used when no profile is passed (backward compat) */
export const DEFAULT_PROFILE = I4_NA;

/** Lookup a profile by id */
export function getProfile(id) {
  return PROFILES[id];
}
