// 2D specialisation: the incoming tangent is a bearing in degrees, and each permitted
// half-angle yields two rays (left and right of the tangent).

import { DEG, normalizeDeg, angleDelta, sweepCandidates, nearestSweep } from '../core/angles.js';
import { EPS, radiusFor, minChordFor, isTooTight } from '../core/arcMath.js';
import { walkPath } from '../core/solve.js';
import { elbowLayout } from '../core/pieces.js';

export { DEG, minChordFor };

const step = (p, deg, d) => ({ x: p.x + d * Math.cos(deg * DEG), y: p.y + d * Math.sin(deg * DEG) });

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
export function classifySegment(p0, p1, tauDeg, opts = {}) {
  const { toleranceDeg = 2, minRadius = 0, flangeOffset = 60, maxPieceLength = 1050 } = opts;
  const chord = distance(p0, p1);

  if (chord < EPS) {
    return { ok: false, tooTight: false, reason: 'degenerate', chord: 0, phi: tauDeg, error: 0, nearest: null, arc: null, shop: null, minRadius, tOut: tauDeg };
  }

  const phi = bearingDeg(p0, p1);
  const nearest = nearestLegal(phi, tauDeg);

  if (Math.abs(nearest.error) <= toleranceDeg) {
    // Built from the actual chord, so the swept angle stays exactly one of the permitted set (R-17).
    const arc = arcFromChord(p0, p1, nearest.theta, nearest.dir);
    const tooTight = isTooTight(arc.radius, minRadius);
    const shop = arc.straight
      ? { kind: 'straight', length: chord }
      : { kind: 'elbow', ...elbowLayout({ tableRadius: arc.radius, theta: arc.theta, minRadius, flangeOffset, maxPieceLength }) };

    return {
      ok: true, tooTight, reason: shop.reason ?? (tooTight ? 'too-tight' : null),
      chord, phi, error: nearest.error, nearest, arc, shop, minRadius,
      minChord: minChordFor(nearest.theta, minRadius),
      tOut: arc.tEnd,
    };
  }

  return { ok: false, tooTight: false, reason: 'no-legal-arc', chord, phi, error: nearest.error, nearest, arc: null, shop: null, minRadius, tOut: phi };
}

/** Samples along a circular arc of radius `radius` leaving `from` on bearing `tStart`. */
export function arcSamples(from, tStart, dir, radius, theta, divisions = 24) {
  const toCentre = tStart + dir * 90;
  const center = step(from, toCentre, radius);
  const spoke = bearingDeg(center, from);

  const out = [];
  for (let i = 0; i <= divisions; i++) {
    out.push(step(center, spoke + (dir * theta * i) / divisions, radius));
  }
  return out;
}

/**
 * Expand a span into the stretches a shop would build: a plain run, or the lead / amber arc /
 * trail of a compact elbow whose radius has been shrunk to the bend limit.
 */
export function expandSegment(seg, divisions = 24) {
  const { from, to, shop, arc } = seg;
  if (!seg.ok || !shop) return [];
  if (shop.kind === 'straight') return [{ kind: 'straight', points: [from, to] }];

  const { leftover, radius, theta } = shop;
  const f1 = step(from, arc.tStart, leftover);
  const f2 = step(to, arc.tEnd, -leftover);

  const out = [];
  if (leftover > EPS) out.push({ kind: 'straight', points: [from, f1] });
  out.push({ kind: 'elbow', arcDeg: theta, points: arcSamples(f1, arc.tStart, arc.dir, radius, theta, divisions) });
  if (leftover > EPS) out.push({ kind: 'straight', points: [f2, to] });
  return out;
}

/** The shop centerline of a whole run, as one polyline plus the kind-tagged stretches on it. */
export function expandRun(run, divisions = 24) {
  const stretches = [];
  for (const seg of run) {
    for (const st of expandSegment(seg, divisions)) stretches.push({ ...st, segIndex: seg.index });
  }

  const points = [];
  for (const st of stretches) {
    for (const p of st.points) {
      const last = points[points.length - 1];
      if (last && distance(last, p) < 1e-6) continue;
      points.push(p);
    }
  }
  return { points, stretches };
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
  return { ...p1, ...step(p0, bearing, d) };
}

export function solvePath(points, initialHeadingDeg, opts = {}) {
  return walkPath(points, initialHeadingDeg, (a, b, tau) => classifySegment(a, b, tau, opts));
}
