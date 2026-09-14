// The scalar arc relationships. Identical in 2D and 3D — see docs/requirements.md §3.

import { DEG } from './angles.js';

/** Chord shorter than this is treated as degenerate. */
export const EPS = 1e-9;

/** r = d / (2 sin(theta/2)). A 0 sweep is a straight run of infinite radius. */
export function radiusFor(chord, theta) {
  return theta === 0 ? Infinity : chord / (2 * Math.sin((theta * DEG) / 2));
}

/**
 * Shortest chord that keeps an arc of sweep `theta` at or above `minRadius`.
 * Inverting the radius formula gives d = 2 * minRadius * sin(theta/2).
 */
export function minChordFor(theta, minRadius) {
  if (theta === 0 || minRadius <= 0) return 0;
  return 2 * minRadius * Math.sin((theta * DEG) / 2);
}

/** Relative epsilon so a point snapped exactly onto the minimum reads as valid. */
export function isTooTight(radius, minRadius) {
  return Number.isFinite(radius) && radius < minRadius * (1 - 1e-9);
}
