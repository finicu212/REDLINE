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


/**
 * Multi-sample bank: one loop per recorded RPM, pitched physically and
 * crossfaded by audio.js. Files live in /audio/<folder>/<rpm>.wav.
 * Road-car audio: no straight-cut whine, no limiter loop, helical gear hum instead.
 */
function bankAudio(folder, rpms) {
  return {
    bank: rpms.map(rpm => ({ rpm, file: `/audio/${folder}/${rpm}.wav` })),
    rev: null,
    limiter: null,
    trany: null,
    tranyDecel: null,
    gearHum: true,
  };
}

/** Drivetrain-side vehicle inertia from curb mass and tire size (same 0.8 factor as the S2000 tune). */
function vehicleInertia(mass, tireCircumference) {
  const r = tireCircumference / (2 * Math.PI);
  return Math.round(0.8 * mass * r * r);
}

/** Tire rolling circumference in meters from a size like 245/45R18. */
function tire(width, aspect, rimInches) {
  return Math.PI * (rimInches * 0.0254 + 2 * width * aspect / 100 / 1000);
}

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

  turbo: false,

  exhaust: { pipeLength: 1.5, diameter: 0.08, wet: 0.30 },

  audio: bacAudio(),
};

// --- Real-car profiles (multi-sample banks) ---
// Specs from manufacturer data; torque curves shaped to hit published peak torque
// and peak power at their RPMs. Engine-sim sets: preset matched by rev limit.

const ENGINE_SIM = 'engine-sim recording (Stunt Rally 3, CC-BY-4.0)';

/**
 * Toyota AE86 Sprinter Trueno GT-APEX — 4A-GE 1.6L I4 (JDM, 130 PS)
 * 130 PS @ 6600, 149 Nm @ 5200, redline 7600. T50 5-speed, 4.30 final.
 */
const I4_2 = {
  id: 'i4_2',
  name: 'I4 #2',
  description: '1.6L 4A-GE Inline-4',
  vehicle: 'Toyota AE86 Trueno',
  sound: 'Toyota 4A-GE, real (Freesound, CC0/CC-BY)',

  cylinders: 4,
  layout: 'inline',

  idleRPM: 850,
  redlineRPM: 7600,
  revCutRPM: 7500,
  maxRPM: 7800,
  tachoMaxRPM: 9000,
  limiter: { style: 'hard', cutMs: 70 },

  torqueCurve: [
    [850,  105],
    [2000, 120],
    [3000, 130],
    [4000, 140],
    [5200, 149],
    [6000, 147],
    [6600, 138],
    [7200, 122],
    [7600, 110],
  ],

  gearRatios: [0, 3.587, 2.022, 1.384, 1.000, 0.861],
  finalDrive: 4.30,
  tireCircumference: tire(185, 70, 13),
  mass: 940,

  engineInertia: 0.11,
  vehicleInertia: vehicleInertia(940, tire(185, 70, 13)),

  frictionTorque: 7,
  engineBrakingFactor: 11,
  brakeDecel: 8.5,

  shiftDuration: 150,
  turbo: false,

  exhaust: { pipeLength: 1.4, diameter: 0.055, wet: 0.25 },
  audio: bankAudio('i4_4age', [2170, 4050]),
};

/**
 * Opel Astra G 1.6 16V — Z16XE I4
 * 101 hp @ 6000, 150 Nm @ 3600, redline 6500. F17 5-speed, 3.94 final.
 */
const I4_3 = {
  id: 'i4_3',
  name: 'I4 #3',
  description: '1.6L Ecotec Inline-4',
  vehicle: 'Opel Astra G',
  sound: 'Opel Astra 1.6 16V, real (Freesound, CC-BY)',

  cylinders: 4,
  layout: 'inline',

  idleRPM: 780,
  redlineRPM: 6500,
  revCutRPM: 6400,
  maxRPM: 6700,
  tachoMaxRPM: 7000,
  limiter: { style: 'soft', cutMs: 0, softRangeRPM: 300 },

  torqueCurve: [
    [780,  110],
    [1500, 125],
    [2500, 140],
    [3600, 150],
    [4500, 140],
    [5500, 127],
    [6000, 120],
    [6500, 105],
  ],

  gearRatios: [0, 3.73, 2.14, 1.41, 1.12, 0.89],
  finalDrive: 3.94,
  tireCircumference: tire(195, 60, 15),
  mass: 1150,

  engineInertia: 0.13,
  vehicleInertia: vehicleInertia(1150, tire(195, 60, 15)),

  frictionTorque: 7,
  engineBrakingFactor: 11,
  brakeDecel: 8.5,

  shiftDuration: 180,
  turbo: false,

  exhaust: { pipeLength: 1.6, diameter: 0.05, wet: 0.25 },
  audio: bankAudio('i4_astra', [780, 1300, 2260]),
};

/**
 * Nissan 370Z — VQ37VHR 3.7L 60° V6
 * 332 hp @ 7000, 366 Nm @ 5200, redline 7500. 6-speed manual, 3.692 final.
 * Sound source is an unidentified engine-sim even-fire 6; physics are the VQ37.
 */
const V6_1 = {
  id: 'v6_1',
  name: 'V6 #1',
  description: '3.7L VQ37VHR V6',
  vehicle: 'Nissan 370Z',
  sound: `even-fire 6-cyl, ${ENGINE_SIM}`,

  cylinders: 6,
  layout: 'v',

  idleRPM: 700,
  redlineRPM: 7500,
  revCutRPM: 7400,
  maxRPM: 7700,
  tachoMaxRPM: 9000,
  limiter: { style: 'hard', cutMs: 80 },

  torqueCurve: [
    [700,  230],
    [2000, 300],
    [3000, 330],
    [4000, 350],
    [5200, 366],
    [6000, 360],
    [7000, 338],
    [7500, 305],
    [8000, 260],
  ],

  gearRatios: [0, 3.794, 2.324, 1.624, 1.271, 1.000, 0.794],
  finalDrive: 3.692,
  tireCircumference: tire(245, 45, 18),
  mass: 1500,

  engineInertia: 0.17,
  vehicleInertia: vehicleInertia(1500, tire(245, 45, 18)),

  frictionTorque: 10,
  engineBrakingFactor: 13,
  brakeDecel: 9.5,

  shiftDuration: 160,
  turbo: false,

  exhaust: { pipeLength: 1.6, diameter: 0.065, wet: 0.35 },
  audio: bankAudio('v6_tsp', [1100, 2000, 3000, 4000, 5000, 6000, 7000, 8000]),
};

/**
 * DeLorean DMC-12 — PRV ZMJ-159 2.85L 90° odd-fire V6 (K-Jetronic)
 * 130 hp @ 5500, 220 Nm @ 2750. No electronic cut — soft hold at redline, engine keeps singing.
 * Renault UN1 5-speed, 3.44 final.
 */
const V6_2 = {
  id: 'v6_2',
  name: 'V6 #2',
  description: '2.85L PRV V6',
  vehicle: 'DeLorean DMC-12',
  sound: 'DeLorean PRV V6, real (Freesound, CC-BY / CC-BY-NC)',

  cylinders: 6,
  layout: 'v',

  idleRPM: 900,
  redlineRPM: 6000,
  revCutRPM: 5900,
  maxRPM: 6500,
  tachoMaxRPM: 7000,
  limiter: { style: 'soft', cutMs: 0, softRangeRPM: 350 },

  torqueCurve: [
    [900,  160],
    [1500, 190],
    [2000, 208],
    [2750, 220],
    [3500, 215],
    [4500, 196],
    [5500, 168],
    [6000, 150],
  ],

  gearRatios: [0, 3.36, 2.06, 1.38, 1.06, 0.82],
  finalDrive: 3.44,
  tireCircumference: tire(235, 60, 15),
  mass: 1230,

  engineInertia: 0.20,
  vehicleInertia: vehicleInertia(1230, tire(235, 60, 15)),

  frictionTorque: 9,
  engineBrakingFactor: 12,
  brakeDecel: 8.0,

  shiftDuration: 200,
  turbo: false,

  exhaust: { pipeLength: 1.4, diameter: 0.06, wet: 0.35 },
  audio: bankAudio('v6_delorean', [960, 1600, 2870, 3670]),
};

/**
 * Chevrolet Corvette C6 — LS3 6.2L cross-plane V8 (engine-sim "GM LS")
 * 430 hp @ 5900, 575 Nm @ 4600, redline 6600. Tremec TR6060 6-speed, 3.42 final.
 */
const V8_1 = {
  id: 'v8_1',
  name: 'V8 #1',
  description: '6.2L LS3 V8',
  vehicle: 'Chevrolet Corvette C6',
  sound: `GM LS, ${ENGINE_SIM}`,

  cylinders: 8,
  layout: 'v',

  idleRPM: 700,
  redlineRPM: 6600,
  revCutRPM: 6500,
  maxRPM: 6800,
  tachoMaxRPM: 7000,
  limiter: { style: 'hard', cutMs: 100 },

  torqueCurve: [
    [700,  380],
    [1500, 470],
    [2500, 520],
    [3500, 555],
    [4600, 575],
    [5200, 565],
    [5900, 519],
    [6300, 470],
    [6600, 430],
  ],

  gearRatios: [0, 2.66, 1.78, 1.30, 1.00, 0.74, 0.50],
  finalDrive: 3.42,
  tireCircumference: tire(285, 35, 19),
  mass: 1490,

  engineInertia: 0.22,
  vehicleInertia: vehicleInertia(1490, tire(285, 35, 19)),

  frictionTorque: 14,
  engineBrakingFactor: 15,
  brakeDecel: 10.0,

  shiftDuration: 170,
  turbo: false,

  exhaust: { pipeLength: 1.8, diameter: 0.076, wet: 0.40 },
  audio: bankAudio('v8_gv8', [1000, 2000, 3000, 4000, 5000, 6000, 6500]),
};

/**
 * Chevrolet Chevelle SS 454 (1970) — LS6 7.4L big-block V8 (engine-sim "Chev. 454")
 * 450 hp (gross) @ 5600, 678 Nm @ 3600. Points ignition, no cut — soft hold at redline.
 * Muncie M22 4-speed, 3.73 final.
 */
const V8_2 = {
  id: 'v8_2',
  name: 'V8 #2',
  description: '7.4L 454 LS6 V8',
  vehicle: 'Chevrolet Chevelle SS 454',
  sound: `Chevy 454, ${ENGINE_SIM}`,

  cylinders: 8,
  layout: 'v',

  idleRPM: 750,
  redlineRPM: 6000,
  revCutRPM: 5900,
  maxRPM: 6800,
  tachoMaxRPM: 8000,
  limiter: { style: 'soft', cutMs: 0, softRangeRPM: 400 },

  torqueCurve: [
    [750,  430],
    [1500, 560],
    [2500, 640],
    [3600, 678],
    [4400, 650],
    [5000, 610],
    [5600, 572],
    [6000, 510],
    [6500, 430],
  ],

  gearRatios: [0, 2.20, 1.64, 1.28, 1.00],
  finalDrive: 3.73,
  tireCircumference: 2.12, // F70-14 bias ply
  mass: 1750,

  engineInertia: 0.32,
  vehicleInertia: vehicleInertia(1750, 2.12),

  frictionTorque: 16,
  engineBrakingFactor: 17,
  brakeDecel: 7.5,

  shiftDuration: 220,
  turbo: false,

  exhaust: { pipeLength: 2.0, diameter: 0.064, wet: 0.40 },
  audio: bankAudio('v8_ctv8', [1000, 2000, 3000, 4000, 5000, 6000, 7000]),
};

/**
 * Ferrari 458 Italia — F136 FB 4.5L flat-plane V8 (engine-sim "Ferrari F136")
 * 570 PS @ 9000, 540 Nm @ 6000, redline 9000. 7-speed DCT, 4.44 final.
 */
const V8_3 = {
  id: 'v8_3',
  name: 'V8 #3',
  description: '4.5L F136 V8',
  vehicle: 'Ferrari 458 Italia',
  sound: `Ferrari F136, ${ENGINE_SIM}`,

  cylinders: 8,
  layout: 'v',

  idleRPM: 1000,
  redlineRPM: 9000,
  revCutRPM: 8900,
  maxRPM: 9200,
  tachoMaxRPM: 10000,
  limiter: { style: 'hard', cutMs: 50 },

  torqueCurve: [
    [1000, 300],
    [2000, 380],
    [3000, 430],
    [4000, 470],
    [5000, 505],
    [6000, 540],
    [7000, 530],
    [8000, 500],
    [9000, 445],
    [9400, 400],
  ],

  gearRatios: [0, 3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69],
  finalDrive: 4.44,
  tireCircumference: tire(295, 35, 20),
  mass: 1485,

  engineInertia: 0.20,
  vehicleInertia: vehicleInertia(1485, tire(295, 35, 20)),

  frictionTorque: 11,
  engineBrakingFactor: 13,
  brakeDecel: 10.5,

  shiftDuration: 60,
  turbo: false,

  exhaust: { pipeLength: 1.5, diameter: 0.07, wet: 0.35 },
  audio: bankAudio('v8_v8f', [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]),
};

// --- Exports ---

/** Profile list for UI iteration (stable order) */
export const PROFILE_LIST = [
  I4_NA, I4_2, I4_3,
  V6_1, V6_2,
  V8_1, V8_2, V8_3,
];

/** All user-selectable profiles, keyed by id */
export const PROFILES = Object.fromEntries(PROFILE_LIST.map(p => [p.id, p]));

/** Default profile used when no profile is passed (backward compat) */
export const DEFAULT_PROFILE = I4_NA;

/** Lookup a profile by id */
export function getProfile(id) {
  return PROFILES[id];
}
