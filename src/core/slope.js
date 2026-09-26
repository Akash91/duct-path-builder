// Drain pitch. A wash-down duct is never laid dead level, but it may fall either way, so the
// test is on |pitch| rather than on a signed direction. Dimension-free: callers supply the
// rise and the chord they were measured over.

import { DEG } from './angles.js';

/** Pitch of a run, in degrees, +Z up. */
export function pitchDeg(rise, chord) {
  if (!(chord > 0)) return 0;
  return Math.asin(Math.max(-1, Math.min(1, rise / chord))) / DEG;
}

/** Shallowest pitch still accepted as draining. */
export function drainFloorDeg(slopeDeg, slopeToleranceDeg) {
  return Math.max(0, slopeDeg - slopeToleranceDeg);
}

/** A rise or a fall at or above the floor both drain; only near-level is off-slope. */
export function drains(rise, chord, slopeDeg, slopeToleranceDeg) {
  const floor = drainFloorDeg(slopeDeg, slopeToleranceDeg);
  if (floor <= 0) return true;
  return Math.abs(pitchDeg(rise, chord)) >= floor - 1e-9;
}

/**
 * Rise that puts a run of horizontal length `run` exactly on `slopeDeg`.
 * The sign follows the fall the user already drew; a level run is pitched up.
 */
export function pitchedRise(run, slopeDeg, existingRise = 0) {
  const sign = existingRise < 0 ? -1 : 1;
  return sign * Math.abs(run) * Math.tan(slopeDeg * DEG);
}
