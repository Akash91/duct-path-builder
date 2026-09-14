// Angle helpers and the permitted sweep set. Dimension-free.

export const DEG = Math.PI / 180;

/** Permitted swept angles, in degrees. 0 is a straight run (infinite radius). */
export const DEFAULT_SWEEPS = [0, 30, 45, 60, 90];

let sweeps = [...DEFAULT_SWEEPS];

/** Sweeps must be in [0, 180) so an arc never takes the long way round. */
export function setSweeps(list) {
  const clean = [...new Set(list.map(Number))]
    .filter((v) => Number.isFinite(v) && v >= 0 && v < 180)
    .sort((a, b) => a - b);

  if (clean.length === 0) throw new Error('At least one valid sweep angle is required');
  sweeps = clean;
}

export function getSweeps() {
  return [...sweeps];
}

/** Wrap an angle into (-180, 180]. */
export function normalizeDeg(a) {
  const x = (((a + 180) % 360) + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

/** Signed shortest rotation from `b` to `a`, in (-180, 180]. */
export function angleDelta(a, b) {
  return normalizeDeg(a - b);
}

/**
 * How far the chord may deviate from the incoming tangent, per permitted sweep.
 *
 * The tangent leaves the chord by exactly theta/2, so this half-angle set *is* the whole
 * feasibility test, in any number of dimensions. In 2D each non-zero sweep gives two signed
 * options (left/right); in 3D the same half-angle sweeps out a cone and the sign is redundant.
 */
export function sweepCandidates() {
  const out = [];
  for (const theta of sweeps) {
    // A 0 sweep has no handedness, so it contributes one option rather than two.
    for (const dir of theta === 0 ? [0] : [-1, 1]) {
      out.push({ theta, dir, half: (dir * theta) / 2 });
    }
  }
  return out;
}

/**
 * Nearest permitted deviation to `deviationDeg`, with its signed error.
 * Pass a signed deviation in 2D, or a non-negative cone angle in 3D.
 */
export function nearestSweep(deviationDeg) {
  let best = null;
  for (const candidate of sweepCandidates()) {
    const error = deviationDeg - candidate.half;
    if (best === null || Math.abs(error) < Math.abs(best.error)) {
      best = { ...candidate, error };
    }
  }
  return best;
}
