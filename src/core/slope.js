// Drainage pitch (docs/requirements.md §3.7). Horizontal shop pieces must not sit dead-level:
// wash-down can run either way, so a rise or a fall of at least `slopeDeg` is valid.

import { DEG } from './angles.js';
import { EPS } from './arcMath.js';

export const DEFAULT_SLOPE_DEG = 3;
export const DEFAULT_SLOPE_TOL_DEG = 1;

export function slopeOptionsFor(state) {
  if (!state?.features?.drainSlope) return null;
  return {
    slopeDeg: Number.isFinite(state.slopeDeg) ? state.slopeDeg : DEFAULT_SLOPE_DEG,
    slopeTol: Number.isFinite(state.slopeToleranceDeg) ? state.slopeToleranceDeg : DEFAULT_SLOPE_TOL_DEG,
  };
}

/** Elevation of the chord above the XY plane, degrees. +Z is up. */
export function pitchDeg(p0, p1) {
  const dz = (p1?.z ?? 0) - (p0?.z ?? 0);
  const chord = Math.hypot((p1?.x ?? 0) - (p0?.x ?? 0), (p1?.y ?? 0) - (p0?.y ?? 0), dz);
  if (!(chord > EPS)) return 0;
  return Math.asin(Math.min(1, Math.max(-1, dz / chord))) / DEG;
}

export function slopeFloorDeg(slopeDeg = DEFAULT_SLOPE_DEG, slopeTol = DEFAULT_SLOPE_TOL_DEG) {
  return Math.max(0, slopeDeg - slopeTol);
}

/** True when a run is too level to drain either way. */
export function isTooFlat(p0, p1, slopeDeg = DEFAULT_SLOPE_DEG, slopeTol = DEFAULT_SLOPE_TOL_DEG) {
  return Math.abs(pitchDeg(p0, p1)) + 1e-9 < slopeFloorDeg(slopeDeg, slopeTol);
}
