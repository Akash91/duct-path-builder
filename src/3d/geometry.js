// 3D specialisation: the incoming tangent is a unit vector, so each permitted half-angle
// sweeps out a *cone* around it rather than a pair of rays (docs/requirements.md §3.5).
//
// The consequence is that validation is simpler here than in 2D: one angle between the tangent
// and the chord, compared against the half-angle set. There is no handedness to choose, because
// the arc's plane is fixed by the tangent and the chord together.

import { DEG, nearestSweep, sweepCandidates } from '../core/angles.js';
import { EPS, radiusFor, minChordFor, isTooTight } from '../core/arcMath.js';
import { walkPath } from '../core/solve.js';
import * as V from './vec3.js';

export { V };

/** The distinct cone half-angles; a 3D cone needs no left/right split. */
export function legalCones() {
  const seen = new Map();
  for (const c of sweepCandidates()) {
    if (c.half >= 0) seen.set(c.theta, c.half);
  }
  return [...seen].map(([theta, half]) => ({ theta, half }));
}

/** Angle between the incoming tangent and the chord direction, in degrees, always >= 0. */
export function coneAngleDeg(tangent, chordDir) {
  return Math.acos(Math.min(1, Math.max(-1, V.dot(tangent, chordDir)))) / DEG;
}

/**
 * The arc of swept angle `theta` from p0 to p1, bending in the plane of `tangent` and the chord.
 *
 * The entry tangent is reconstructed from the chord rather than taken from `tangent`, so the arc
 * lands exactly on p1 (R-17). Any slack against the incoming tangent stays a kink at the joint,
 * exactly as in 2D — otherwise a tolerated near-miss would leave a visible gap.
 */
export function arcFrom(p0, p1, theta, tangent) {
  const chordVec = V.sub(p1, p0);
  const chord = V.length(chordVec);
  if (chord < EPS) return null;

  const dir = V.normalize(chordVec);

  if (theta === 0) {
    return { theta: 0, chord, radius: Infinity, straight: true, center: null, normal: null, tStart: dir, tEnd: dir };
  }

  let axis = V.cross(tangent, dir);
  if (V.length(axis) < EPS) axis = anyPerpendicular(dir); // tangent parallel to the chord
  const normal = V.normalize(axis);

  const tStart = V.rotateAbout(dir, normal, (-theta / 2) * DEG);
  const inward = V.normalize(V.cross(normal, tStart));
  const radius = radiusFor(chord, theta);

  return {
    theta,
    chord,
    radius,
    straight: false,
    center: V.add(p0, V.scale(inward, radius)),
    normal,
    inward,
    tStart,
    tEnd: V.rotateAbout(tStart, normal, theta * DEG),
  };
}

function anyPerpendicular(v) {
  const seed = Math.abs(v.z) > 0.9 ? V.vec(1, 0, 0) : V.vec(0, 0, 1);
  return V.cross(v, seed);
}

/** Points along a segment, for drawing. A straight run needs only its endpoints. */
export function samplePoints(seg, divisions = 24) {
  const { arc, from, to } = seg;
  if (!arc || arc.straight) return [from, to];

  const out = [];
  const start = V.scale(arc.inward, -arc.radius);
  for (let i = 0; i <= divisions; i++) {
    const angle = (arc.theta * DEG * i) / divisions;
    out.push(V.add(arc.center, V.rotateAbout(start, arc.normal, angle)));
  }
  return out;
}

/**
 * Decide whether p0 -> p1 is a legal connection given incoming unit tangent `tangent`.
 * Mirrors the 2D contract: `ok` is the centerline, `tooTight` is the band's bend limit,
 * and `tOut` falls back to the chord direction on a violation so errors do not cascade.
 */
export function classifySegment(p0, p1, tangent, toleranceDeg, minRadius = 0) {
  const chordVec = V.sub(p1, p0);
  const chord = V.length(chordVec);

  if (chord < EPS) {
    return { ok: false, tooTight: false, reason: 'degenerate', chord: 0, cone: 0, error: 0, nearest: null, arc: null, minRadius, tOut: tangent };
  }

  const dir = V.normalize(chordVec);
  const cone = coneAngleDeg(tangent, dir);
  const nearest = nearestSweep(cone);

  if (Math.abs(nearest.error) <= toleranceDeg) {
    const arc = arcFrom(p0, p1, nearest.theta, tangent);
    const tooTight = isTooTight(arc.radius, minRadius);
    return {
      ok: true, tooTight, reason: tooTight ? 'too-tight' : null,
      chord, cone, error: nearest.error, nearest, arc, minRadius,
      minChord: minChordFor(nearest.theta, minRadius),
      tOut: arc.tEnd,
    };
  }

  return { ok: false, tooTight: false, reason: 'no-legal-arc', chord, cone, error: nearest.error, nearest, arc: null, minRadius, tOut: dir };
}

/**
 * Pull `p1` onto the nearest legal cone, keeping its azimuth around the tangent and only
 * correcting the polar angle. A cone is a continuum, so this is the minimal correction.
 */
export function snapToLegal(p0, p1, tangent, minRadius = 0) {
  const chordVec = V.sub(p1, p0);
  const chord = V.length(chordVec);
  if (chord < EPS) return { ...p1 };

  const dir = V.normalize(chordVec);
  const { theta, half } = nearestSweep(coneAngleDeg(tangent, dir));

  // Component of the chord perpendicular to the tangent fixes the plane to rotate within.
  let inward = V.sub(dir, V.scale(tangent, V.dot(tangent, dir)));
  if (V.length(inward) < EPS) inward = V.vec(0, 0, 0);
  else inward = V.normalize(inward);

  const rad = half * DEG;
  const snappedDir = V.add(V.scale(tangent, Math.cos(rad)), V.scale(inward, Math.sin(rad)));
  const d = Math.max(chord, minChordFor(theta, minRadius));
  const target = V.add(p0, V.scale(snappedDir, d));

  return { ...p1, x: target.x, y: target.y, z: target.z };
}

export function solvePath(points, initialTangent, toleranceDeg, minRadius = 0) {
  return walkPath(points, initialTangent, (a, b, t) =>
    classifySegment(a, b, t, toleranceDeg, minRadius));
}
