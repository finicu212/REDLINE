/**
 * Personal records per car, in localStorage. Storage can be missing or throw
 * (private mode, blocked site data) — the game must still run, just without memory.
 */

const PREFIX = 'redline.monza.';

export function loadRecord(carId) {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + carId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveRecord(carId, record) {
  try {
    globalThis.localStorage?.setItem(PREFIX + carId, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
