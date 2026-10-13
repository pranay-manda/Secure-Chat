/**
 * Voice-note waveform: the loudness of the recording in up to WAVEFORM_BARS bars, measured on
 * the sender's phone while recording (microphone metering), so the bubble shows the real shape
 * of the message, like WhatsApp. It travels inside the encrypted message content as a short
 * string: one base64url digit (0–63) per bar. Older messages have none and show flat bars.
 */
export const WAVEFORM_BARS = 48;
export const WAVEFORM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Quieter than this (dBFS) shows as silence; speech is roughly -40 to -5. */
const FLOOR_DB = -50;

/** Microphone level in dBFS (−160…0) → 0…1. */
export function levelFromDb(db) {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Compresses levels (0…1, one per sample) into the waveform string: each bar is the peak of
 * its share of the samples. Null when there is nothing to show.
 */
export function encodeWaveform(levels, bars = WAVEFORM_BARS) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const count = Math.min(bars, WAVEFORM_BARS);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * levels.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / count));
    let peak = 0;
    for (let j = start; j < end && j < levels.length; j += 1) peak = Math.max(peak, levels[j]);
    out += DIGITS[Math.round(Math.min(1, Math.max(0, peak)) * 63)];
  }
  return out;
}

/** Waveform string → levels 0…1, or null if absent or malformed. */
export function decodeWaveform(text) {
  if (typeof text !== 'string' || !WAVEFORM_PATTERN.test(text)) return null;
  return [...text].map((c) => DIGITS.indexOf(c) / 63);
}

/** `levels` resampled to exactly `bars` values (for drawing). */
export function resampleLevels(levels, bars) {
  if (!levels?.length) return Array(bars).fill(0);
  return Array.from({ length: bars }, (_, i) => levels[Math.floor((i * levels.length) / bars)]);
}
