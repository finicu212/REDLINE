/**
 * Shared engine constants — single source of truth for all RPM limits.
 * Imported by audio.js, drivetrain.js, and UI components.
 */

export const IDLE_RPM = 850;
export const REDLINE_RPM = 7200;       // rev limiter kicks in here
export const REV_CUT_RPM = 7150;       // fuel resumes here (~0.7% hysteresis — very tight bounce)
export const MAX_RPM = 9000;           // hard ceiling — allows over-rev (no engine damage modeled)

// Tachometer display range (dial goes higher than redline for visual headroom)
export const TACHO_MAX_RPM = 8000;
export const TACHO_REDLINE_RPM = 7200;

// Normalized RPM: 0 at idle, 1 at redline
export function normalizeRPM(rpm) {
  return (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM);
}
