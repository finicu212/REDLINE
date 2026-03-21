/**
 * Shared engine constants — single source of truth for all RPM limits.
 * Imported by audio.js, drivetrain.js, and UI components.
 */

export const IDLE_RPM = 850;
export const REDLINE_RPM = 7200;       // rev limiter kicks in here
export const REV_CUT_RPM = 6900;       // fuel resumes here (bounce hysteresis)
export const MAX_RPM = 7200;           // hard ceiling = redline for this engine

// Tachometer display range (dial goes higher than redline for visual headroom)
export const TACHO_MAX_RPM = 8000;
export const TACHO_REDLINE_RPM = 7200;

// Normalized RPM: 0 at idle, 1 at redline
export function normalizeRPM(rpm) {
  return (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM);
}
