/** Lap-time formatting shared by the HUD and the car-select menu. */

/** 83.4567 → "1:23.457". Rounds before splitting so 59.9996 is "1:00.000", not "0:60.000". */
export function fmtLap(t, digits = 3) {
  if (t == null || !Number.isFinite(t)) return '–:––.' + '–'.repeat(digits);
  const f = 10 ** digits;
  t = Math.round(t * f) / f;
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(digits).padStart(digits + 3, '0');
  return `${m}:${s}`;
}

/** Signed gap: −0.42 ahead, +0.10 behind. */
export function fmtDelta(d) {
  if (d == null || !Number.isFinite(d)) return '';
  return `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
}
