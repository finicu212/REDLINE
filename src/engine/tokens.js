/**
 * Color token system — single source of truth for all colors.
 * Enables theming, consistency, and future palette swaps.
 */

// ── Core palette ────────────────────────────────────────────
export const accent       = '#ff4020';      // primary accent (red-orange)
export const accentGlow   = 'rgba(255, 64, 32, 0.4)';
export const accentDim    = 'rgba(255, 64, 32, 0.1)';
export const accentGlowStrong = 'rgba(255, 64, 32, 0.5)';
export const accentGlowMax    = 'rgba(255, 64, 32, 0.8)';

// ── Surfaces ────────────────────────────────────────────────
export const bgDeep       = '#0f0f1a';      // deepest background
export const bgPanel      = '#1a1a2e';      // card / panel background
export const bgInset      = '#111';         // recessed areas (odometer, sparkline)
export const bgOverlay    = 'rgba(10, 10, 20, 0.88)'; // translucent overlay

// ── Borders ─────────────────────────────────────────────────
export const borderSubtle = '#333';
export const borderMid    = '#444';
export const borderFocus  = '#555';

// ── Text ────────────────────────────────────────────────────
export const textPrimary  = '#eee';
export const textSecondary = '#ccc';
export const textMuted    = '#999';
export const textDim      = '#888';
export const textFaint    = '#777';
export const textSubtle   = '#666';
export const textGhost    = '#555';
export const textDisabled = '#444';

// ── Tachometer ──────────────────────────────────────────────
export const tachoBlack      = '#0a0a0a';
export const tachoDark       = '#1a1a1a';
export const tachoWhite      = '#e8e8e8';
export const tachoDim        = '#888';
export const tachoNeedle     = '#e8a020';
export const tachoNeedleGlow = 'rgba(232, 160, 32, 0.5)';
export const tachoRed        = '#cc2020';
export const tachoRedDim     = 'rgba(200, 30, 30, 0.25)';
export const tachoTickMid    = '#555';
export const tachoInnerRing  = '#222';
export const tachoGrid       = '#333';

// ── Cylinder bank ───────────────────────────────────────────
export const cylIdle        = '#2a2a3e';
export const cylPower       = '#ff4020';
export const cylPowerStroke = '#ff6040';
export const cylPowerGlow   = 'rgba(255, 64, 32, 0.8)';
export const cylBrake       = '#3a6fff';
export const cylBrakeStroke = '#5080ff';
export const cylBrakeGlow   = 'rgba(58, 111, 255, 0.6)';
export const cylFiringOn    = '#fff';
export const cylFiringOff   = '#666';

// ── Debug overlay bars ──────────────────────────────────────
export const barRpm     = '#ff4020';
export const barSpeed   = '#2196f3';
export const barTorque  = '#ff9800';
export const barInertia = '#9c27b0';
export const barPbr     = '#4caf50';

// ── Status pills ────────────────────────────────────────────
export const statusOnBg       = '#1b3a1b';
export const statusOnText     = '#4caf50';
export const statusBrakeBg    = '#3a1b1b';
export const statusBrakeText  = '#ff6060';
export const statusLimiterBg  = '#3a1b1b';
export const statusLimiterText = '#ff4020';
export const statusShiftBg    = '#3a3a1b';
export const statusShiftText  = '#ffc107';
export const statusOscBg      = '#1b2a3a';
export const statusOscText    = '#42a5f5';

// ── Debug sparkline / misc ──────────────────────────────────
export const sparklineGrid   = '#333';
export const sparklineLine   = '#4caf50';
export const oscBar          = '#42a5f5';

// ── Turbo ────────────────────────────────────────────────────
export const barBoost          = '#ce93d8';
export const statusTurboBg     = '#2a1b3a';
export const statusTurboText   = '#ce93d8';

// ── Braking blue (cylinder + debug) ─────────────────────────
export const blue            = '#3a6fff';
