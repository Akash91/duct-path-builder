// 2D specialisation: the incoming tangent is a bearing in degrees, and each permitted
// half-angle yields two rays (left and right of the tangent).

import { DEG, normalizeDeg, angleDelta, sweepCandidates, nearestSweep } from '../core/angles.js';
import { EPS, radiusFor, minChordFor, isTooTight } from '../core/arcMath.js';
import { walkPath } from '../core/solve.js';

export { DEG, minChordFor };

export function bearingDeg(p0, p1) {
  return Math.atan2(p1.y - p0.y, p1.x - p0.x) / DEG;
}

export function distance(p0, p1) {
  return Math.hypot(p1.x - p0.x, p1.y - p0.y);
}

/** The rays reachable from an incoming tangent — the sweep half-angles laid off from `tauDeg`. */
export function legalBearings(tauDeg) {
  return sweepCandidates().map((c) => ({ ...c, bearing: normalizeDeg(tauDeg + c.half) }));
}

/** Nearest legal ray to an actual chord bearing, with its signed angular error. */
export function nearestLegal(phiDeg, tauDeg) {
  const best = nearestSweep(angleDelta(phiDeg, tauDeg));
  return { ...best, bearing: normalizeDeg(tauDeg + best.half) };
}

/**
 * Build the unique arc of swept angle `theta` turning in direction `dir`
 * (+1 = increasing angle, clockwise on screen) that joins p0 to p1.
 */
export function arcFromChord(p0, p1, theta, dir) {
  const chord = distance(p0, p1);
  if (chord < EPS) return null;

  const phi = bearingDeg(p0, p1);

  if (theta === 0) {
    return {
      theta: 0, dir: 0, chord, phi,
      radius: Infinity, tStart: phi, tEnd: phi, center: null,
      straight: true, largeArcFlag: 0, sweepFlag: 0,
    };
  }

  const radius = radiusFor(chord, theta);
  const tStart = normalizeDeg(phi - (dir * theta) / 2);
  const tEnd = normalizeDeg(phi + (dir * theta) / 2);

  // Centre sits perpendicular to the entry tangent, on the inside of the turn.
  const toCentre = (tStart + dir * 90) * DEG;

  return {
    theta,
    dir,
    chord,
    phi,
    radius,
    tStart,
    tEnd,
    center: {
      x: p0.x + radius * Math.cos(toCentre),
      y: p0.y + radius * Math.sin(toCentre),
    },
    // theta is always < 180, so the arc is never the long way round.
    largeArcFlag: 0,
    sweepFlag: dir > 0 ? 1 : 0,
  };
}

/**
 * Decide whether p0 -> p1 is a legal connection given incoming tangent `tauDeg`.
 *
 * `ok` covers the centerline only. `tooTight` is separate: the arc is angularly legal but its
 * radius is below `minRadius`, so a band of that width cannot physically follow it (R-60).
 *
 * `tOut` is the tangent handed to the next segment. On a violation it falls back to the
 * straight chord bearing so a single bad point does not invalidate everything after it (R-19).
 */
export function classifySegment(p0, p1, tauDeg, toleranceDeg, minRadius = 0) {
  const chord = distance(p0, p1);

  if (chord < EPS) {
    return { ok: false, tooTight: false, reason: 'degenerate', chord: 0, phi: tauDeg, error: 0, nearest: null, arc: null, minRadius, tOut: tauDeg };
  }

  const phi = bearingDeg(p0, p1);
  const nearest = nearestLegal(phi, tauDeg);

  if (Math.abs(nearest.error) <= toleranceDeg) {
    // Built from the actual chord, so the swept angle stays exactly one of the permitted set (R-17).
    const arc = arcFromChord(p0, p1, nearest.theta, nearest.dir);
    const tooTight = isTooTight(arc.radius, minRadius);
    return {
      ok: true, tooTight, reason: tooTight ? 'too-tight' : null,
      chord, phi, error: nearest.error, nearest, arc, minRadius,
      minChord: minChordFor(nearest.theta, minRadius),
      tOut: arc.tEnd,
    };
  }

  return { ok: false, tooTight: false, reason: 'no-legal-arc', chord, phi, error: nearest.error, nearest, arc: null, minRadius, tOut: phi };
}

/**
 * Move `p1` onto the nearest legal ray from `p0` (R-21, R-22), pushing it out to the minimum
 * chord if it sits closer than a band of the given radius can bend.
 */
export function snapToLegal(p0, p1, tauDeg, minRadius = 0) {
  const chord = distance(p0, p1);
  if (chord < EPS) return { ...p1 };

  const { bearing, theta } = nearestLegal(bearingDeg(p0, p1), tauDeg);
  const d = Math.max(chord, minChordFor(theta, minRadius));
  const rad = bearing * DEG;
  return { ...p1, x: p0.x + d * Math.cos(rad), y: p0.y + d * Math.sin(rad) };
}

export function solvePath(points, initialHeadingDeg, toleranceDeg, minRadius = 0) {
  return walkPath(points, initialHeadingDeg, (a, b, tau) =>
    classifySegment(a, b, tau, toleranceDeg, minRadius));
}
