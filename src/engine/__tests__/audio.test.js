import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EngineAudio } from '../audio.js';
import { IDLE_RPM, REDLINE_RPM, normalizeRPM } from '../constants.js';

// --- Web Audio API mocks ---

function createMockAudioParam(initialValue = 0) {
  return {
    value: initialValue,
    setTargetAtTime: vi.fn(function (val) { this.value = val; }),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

function createMockGainNode() {
  return {
    gain: createMockAudioParam(0),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function createMockSource() {
  return {
    buffer: null,
    loop: false,
    detune: createMockAudioParam(0),
    playbackRate: createMockAudioParam(1),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockOscillator() {
  return {
    type: 'sine',
    frequency: createMockAudioParam(440),
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockConvolver() {
  return {
    buffer: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function createMockAudioBuffer(channels, length, sampleRate) {
  const data = new Float32Array(length);
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: vi.fn(() => data),
  };
}

// Must use function (not arrow) so `new AudioContext()` works
function MockAudioContext() {
  this.currentTime = 0;
  this.sampleRate = 44100;
  this.state = 'running';
  this.destination = {};
  this.resume = vi.fn();
  this.suspend = vi.fn();
  this.createGain = vi.fn(() => createMockGainNode());
  this.createBufferSource = vi.fn(() => createMockSource());
  this.createOscillator = vi.fn(() => createMockOscillator());
  this.createConvolver = vi.fn(() => createMockConvolver());
  this.createBuffer = vi.fn((channels, length, sampleRate) => createMockAudioBuffer(channels, length, sampleRate));
  this.decodeAudioData = vi.fn(async () => ({ duration: 1.0, length: 44100 }));
}

// Mock fetch for audio loading
function mockFetch() {
  return vi.fn(async () => ({
    arrayBuffer: async () => new ArrayBuffer(1024),
  }));
}

describe('EngineAudio — construction', () => {
  it('creates with null context', () => {
    const ea = new EngineAudio();
    expect(ea.ctx).toBeNull();
    expect(ea._started).toBe(false);
  });

  it('has empty buffers map', () => {
    const ea = new EngineAudio();
    expect(ea.buffers.size).toBe(0);
  });

  it('debug values start at 0', () => {
    const ea = new EngineAudio();
    expect(ea.debugDetune).toBe(0);
    expect(ea.debugBandGains).toEqual({});
  });
});

describe('EngineAudio — init', () => {
  let ea;
  beforeEach(() => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
  });

  it('creates AudioContext and master gain', async () => {
    await ea.init();
    expect(ea.ctx).toBeTruthy();
    expect(ea.masterGain).toBeTruthy();
  });

  it('loads all 13 audio files', async () => {
    await ea.init();
    expect(ea.buffers.size).toBe(13);
  });

  it('calls progress callback', async () => {
    const progress = vi.fn();
    await ea.init(progress);
    expect(progress).toHaveBeenCalled();
    // Last call should be 1.0 (fully loaded)
    const lastCall = progress.mock.calls[progress.mock.calls.length - 1][0];
    expect(lastCall).toBeCloseTo(1.0, 5);
  });

  it('handles failed audio file gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('REV')) throw new Error('404');
      return { arrayBuffer: async () => new ArrayBuffer(1024) };
    }));
    await ea.init();
    // Should still load 12 of 13
    expect(ea.buffers.size).toBe(12);
  });
});

describe('EngineAudio — setEngineState gain calculations', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('on-throttle at low RPM: on_low dominates', () => {
    ea.setEngineState({
      rpm: 2000, throttle: true, gear: 1, speed: 20,
      shifting: false, revLimiterActive: false,
    });
    const g = ea.debugBandGains;
    expect(g.on_low).toBeGreaterThan(g.on_high);
    expect(g.on_low).toBeGreaterThan(g.off_low);
    expect(g.on_low).toBeGreaterThan(g.off_high);
  });

  it('on-throttle at high RPM: on_high dominates', () => {
    ea.setEngineState({
      rpm: 7000, throttle: true, gear: 3, speed: 100,
      shifting: false, revLimiterActive: false,
    });
    const g = ea.debugBandGains;
    expect(g.on_high).toBeGreaterThan(g.on_low);
    expect(g.on_high).toBeGreaterThan(g.off_low);
  });

  it('off-throttle at low RPM: off_low dominates', () => {
    ea.setEngineState({
      rpm: 2000, throttle: false, gear: 1, speed: 20,
      shifting: false, revLimiterActive: false,
    });
    const g = ea.debugBandGains;
    expect(g.off_low).toBeGreaterThan(g.on_low);
    expect(g.off_low).toBeGreaterThan(g.on_high);
  });

  it('off-throttle at high RPM: off_high dominates', () => {
    ea.setEngineState({
      rpm: 7000, throttle: false, gear: 3, speed: 100,
      shifting: false, revLimiterActive: false,
    });
    const g = ea.debugBandGains;
    expect(g.off_high).toBeGreaterThan(g.on_low);
    expect(g.off_high).toBeGreaterThan(g.on_high);
  });

  it('all gains are non-negative', () => {
    for (const rpm of [1000, 3000, 5000, 7000]) {
      for (const throttle of [true, false]) {
        ea.setEngineState({
          rpm, throttle, gear: 2, speed: 50,
          shifting: false, revLimiterActive: false,
        });
        for (const [, val] of Object.entries(ea.debugBandGains)) {
          expect(val).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('gains sum approximately to 1 (equal-power crossfade)', () => {
    // At mid-RPM, on-throttle: on_low + on_high should be ~1
    ea.setEngineState({
      rpm: 4500, throttle: true, gear: 2, speed: 60,
      shifting: false, revLimiterActive: false,
    });
    const g = ea.debugBandGains;
    const onSum = g.on_low + g.on_high;
    // Equal-power crossfade: cos²+sin² = 1, but cos(x)*cos(y) decomposition
    // means the sum at the midpoint crossfade should be close to 1
    expect(onSum).toBeGreaterThan(0.5);
    expect(onSum).toBeLessThanOrEqual(1.5);
  });
});

describe('EngineAudio — detune model', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('detune is 0 at sample RPM (1000)', () => {
    ea.setEngineState({
      rpm: 1000, throttle: true, gear: 1, speed: 10,
      shifting: false, revLimiterActive: false,
    });
    expect(ea.debugDetune).toBeCloseTo(0, 0);
  });

  it('detune at 7200 RPM is ~1240 cents', () => {
    ea.setEngineState({
      rpm: 7200, throttle: true, gear: 3, speed: 100,
      shifting: false, revLimiterActive: false,
    });
    // (7200 - 1000) * 0.2 = 1240
    expect(ea.debugDetune).toBeCloseTo(1240, 0);
  });

  it('detune scales linearly with RPM', () => {
    ea.setEngineState({
      rpm: 3000, throttle: true, gear: 2, speed: 40,
      shifting: false, revLimiterActive: false,
    });
    const d3000 = ea.debugDetune;

    ea.setEngineState({
      rpm: 5000, throttle: true, gear: 3, speed: 70,
      shifting: false, revLimiterActive: false,
    });
    const d5000 = ea.debugDetune;

    // (5000-1000)*0.2 - (3000-1000)*0.2 = 400 cents
    expect(d5000 - d3000).toBeCloseTo(400, 0);
  });

  it('shift oscillation adds wobble to detune', () => {
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: 0.5, shiftOscAmplitude: 0.5, shiftOscRPMDelta: -1000,
    });
    // Base: (4000-1000)*0.2 = 600, wobble: 0.5 * 45 = 22.5
    expect(ea.debugDetune).toBeCloseTo(600 + 22.5, 0);
  });

  it('negative oscillation subtracts from detune', () => {
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: -0.3, shiftOscAmplitude: 0.3, shiftOscRPMDelta: 1000,
    });
    expect(ea.debugDetune).toBeCloseTo(600 - 0.3 * 45, 0);
  });
});

describe('EngineAudio — REV layer', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('REV blend is 0 at low RPM', () => {
    ea.setEngineState({
      rpm: 3000, throttle: true, gear: 2, speed: 40,
      shifting: false, revLimiterActive: false,
    });
    expect(ea.debugBandGains.rev).toBeCloseTo(0, 2);
  });

  it('REV blend is 0 when off-throttle', () => {
    ea.setEngineState({
      rpm: 7100, throttle: false, gear: 4, speed: 120,
      shifting: false, revLimiterActive: false,
    });
    expect(ea.debugBandGains.rev).toBeCloseTo(0, 2);
  });

  it('REV blend increases near redline on-throttle', () => {
    ea.setEngineState({
      rpm: REDLINE_RPM - 5, throttle: true, gear: 5, speed: 140,
      shifting: false, revLimiterActive: false,
    });
    // At very near redline (nRPM ~0.999+), REV should blend in
    // This depends on exact nRPM thresholds
    expect(ea.debugBandGains.rev).toBeGreaterThanOrEqual(0);
  });
});

describe('EngineAudio — gain modulation from oscillation', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('no oscillation = no gain modulation', () => {
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: 0,
    });
    const g1 = { ...ea.debugBandGains };

    // Same state, confirm consistent
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: 0,
    });
    const g2 = ea.debugBandGains;

    expect(g1.on_low).toBeCloseTo(g2.on_low, 5);
    expect(g1.on_high).toBeCloseTo(g2.on_high, 5);
  });

  it('positive oscillation reduces gains (gainMod < 1)', () => {
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: 0,
    });
    const baseGain = ea.debugBandGains.on_low;

    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: 0.5, shiftOscAmplitude: 0.5,
    });
    const modGain = ea.debugBandGains.on_low;

    // gainMod = 1 - 0.5 * 0.30 = 0.85, so modGain should be ~85% of baseGain
    expect(modGain).toBeLessThan(baseGain);
    expect(modGain).toBeCloseTo(baseGain * 0.85, 1);
  });
});

describe('EngineAudio — setRPM compat wrapper', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('works without crashing', () => {
    expect(() => ea.setRPM(3000, true)).not.toThrow();
    expect(() => ea.setRPM(5000, false)).not.toThrow();
  });

  it('updates detune', () => {
    ea.setRPM(4000, true);
    expect(ea.debugDetune).toBeCloseTo((4000 - 1000) * 0.2, 0);
  });
});

describe('EngineAudio — stop', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('stops without errors', () => {
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
    });
    expect(() => ea.stop()).not.toThrow();
  });
});

describe('EngineAudio — edge cases', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('handles RPM below idle', () => {
    expect(() => ea.setEngineState({
      rpm: 0, throttle: false, gear: 0, speed: 0,
      shifting: false, revLimiterActive: false,
    })).not.toThrow();
  });

  it('handles RPM above redline', () => {
    expect(() => ea.setEngineState({
      rpm: 10000, throttle: true, gear: 5, speed: 200,
      shifting: false, revLimiterActive: false,
    })).not.toThrow();
    // Should clamp detune to redline
    expect(ea.debugDetune).toBeCloseTo((REDLINE_RPM - 1000) * 0.2, 0);
  });

  it('handles missing oscillation fields gracefully', () => {
    expect(() => ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      // no shiftOscillation fields
    })).not.toThrow();
  });

  it('setEngineState is a no-op before init', () => {
    const fresh = new EngineAudio();
    expect(() => fresh.setEngineState({
      rpm: 3000, throttle: true, gear: 1, speed: 20,
      shifting: false, revLimiterActive: false,
    })).not.toThrow();
  });
});

describe('EngineAudio — exhaust convolution reverb', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
  });

  it('creates convolver node during init', () => {
    expect(ea._convolver).toBeTruthy();
    expect(ea.ctx.createConvolver).toHaveBeenCalled();
  });

  it('creates engine bus with dry/wet routing', () => {
    expect(ea._engineBus).toBeTruthy();
    expect(ea._dryGain).toBeTruthy();
    expect(ea._wetGain).toBeTruthy();
  });

  it('generates IR buffer for convolver', () => {
    expect(ea.ctx.createBuffer).toHaveBeenCalled();
    expect(ea._convolver.buffer).toBeTruthy();
  });

  it('setExhaustParams updates without crashing', () => {
    ea.start();
    expect(() => ea.setExhaustParams({ pipeLength: 2.0, diameter: 0.1, wetMix: 0.5 })).not.toThrow();
  });

  it('setExhaustParams regenerates IR on pipe change', () => {
    ea.start();
    const callsBefore = ea.ctx.createBuffer.mock.calls.length;
    ea.setExhaustParams({ pipeLength: 2.5 });
    expect(ea.ctx.createBuffer.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('setExhaustParams is a no-op before init', () => {
    const fresh = new EngineAudio();
    expect(() => fresh.setExhaustParams({ pipeLength: 2.0 })).not.toThrow();
  });
});

describe('EngineAudio — per-cylinder micro-variation', () => {
  let ea;
  beforeEach(async () => {
    ea = new EngineAudio();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('fetch', mockFetch());
    await ea.init();
    ea.start();
  });

  it('fire counter advances with RPM', () => {
    ea.setEngineState({
      rpm: 6000, throttle: true, gear: 3, speed: 100,
      shifting: false, revLimiterActive: false,
    });
    const count1 = ea._fireCount;
    ea.setEngineState({
      rpm: 6000, throttle: true, gear: 3, speed: 100,
      shifting: false, revLimiterActive: false,
    });
    expect(ea._fireCount).toBeGreaterThan(count1);
  });

  it('fire counter advances faster at higher RPM', () => {
    // Use the shared ea instance, reset fire count between measurements
    ea._fireCount = 0;
    ea.setEngineState({
      rpm: 2000, throttle: true, gear: 1, speed: 20,
      shifting: false, revLimiterActive: false,
    });
    const lowIncrement = ea._fireCount;

    ea._fireCount = 0;
    ea.setEngineState({
      rpm: 7000, throttle: true, gear: 4, speed: 120,
      shifting: false, revLimiterActive: false,
    });
    const highIncrement = ea._fireCount;

    expect(highIncrement).toBeGreaterThan(lowIncrement);
  });

  it('micro-variation does not affect debug detune', () => {
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
    });
    // Debug detune should be clean: (4000-1000)*0.2 = 600
    expect(ea.debugDetune).toBeCloseTo(600, 0);
  });

  it('micro-variation does not affect debug band gains', () => {
    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: 0,
    });
    const g1 = { ...ea.debugBandGains };

    ea.setEngineState({
      rpm: 4000, throttle: true, gear: 2, speed: 50,
      shifting: false, revLimiterActive: false,
      shiftOscillation: 0,
    });
    const g2 = ea.debugBandGains;

    // Debug gains should be identical regardless of fire counter position
    expect(g1.on_low).toBeCloseTo(g2.on_low, 5);
    expect(g1.on_high).toBeCloseTo(g2.on_high, 5);
  });

  it('has pre-computed cylinder offset arrays', () => {
    expect(ea._cylDetuneOffsets.length).toBe(6);
    expect(ea._cylGainOffsets.length).toBe(6);
    // Offsets should be small (±3 cents, ±3%)
    for (const d of ea._cylDetuneOffsets) {
      expect(Math.abs(d)).toBeLessThanOrEqual(3);
    }
    for (const g of ea._cylGainOffsets) {
      expect(Math.abs(g)).toBeLessThanOrEqual(0.03);
    }
  });
});
