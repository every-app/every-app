// The floating recorder's meter: one level from the louder of the mic and the call, smoothed so
// the bars rise fast and fall slowly, and flat when nothing is heard. The helper's levels are
// 0–1 on a −60…0 dBFS scale (10 Hz).

/** Below this (about −51 dBFS: room noise, a fan) counts as silence. */
export const SILENCE = 0.15;

/** The louder side, with silence at 0 and the rest stretched over 0–1. */
export function meterLevel(mic: number, system: number): number {
  const loud = Math.max(
    Number.isFinite(mic) ? mic : 0,
    Number.isFinite(system) ? system : 0,
  );
  return Math.min(1, Math.max(0, (loud - SILENCE) / (0.85 - SILENCE)));
}

/** One step (≈50 ms) toward `target`: quick to rise, slower to fall, snapping to 0 near it. */
export function smoothLevel(
  previous: number,
  target: number,
  attack = 0.55,
  release = 0.2,
): number {
  const rate = target > previous ? attack : release;
  const next = previous + (target - previous) * rate;
  return Math.abs(next - target) < 0.01 ? target : next;
}

const WEIGHTS = [0.7, 1, 0.8];

/** Heights (px) of the three bars: all `min` when silent, the middle one reaching `max`. */
export function barHeights(level: number, min = 5, max = 18): number[] {
  const l = Math.min(1, Math.max(0, level));
  return WEIGHTS.map((w) => Math.round((min + (max - min) * l * w) * 10) / 10);
}
