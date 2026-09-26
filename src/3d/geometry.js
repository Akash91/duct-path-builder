// 3D specialisation: the incoming tangent is a unit vector, so each permitted half-angle
// sweeps out a *cone* around it rather than a pair of rays (docs/requirements.md §3.5).
//
// Two things make 3D harder than 2D rather than simpler. A shop elbow is planar — it yaws in
// plan or pitches in elevation, never both at once — so a legal cone angle is not enough. And a
// horizontal duct has to drain, so a straight is judged on its pitch as well as its direction.

import { DEG, nearestSweep, sweepCandidates } from '../core/angles.js';
import { EPS, radiusFor, minChordFor, isTooTight } from '../core/arcMath.js';
import { walkPath } from '../core/solve.js';
import { drains } from '../core/slope.js';
import { angledStraightPlan, cardinalPlan } from '../core/routing.js';
import { elbowLayout } from '../core/pieces.js';
import * as V from './vec3.js';

export { V };

const WORLD_UP = V.vec(0, 0, 1);

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
 * Right-handed frame carried by the tangent: `side` is horizontal, `up` is the vertical
 * in-plane direction. Plan and elevation are measured here rather than against the world axes,
 * so a duct already running down a drain ramp can still take a pure plan elbow.
 */
export function tangentFrame(tangent) {
  const tau = V.normalize(tangent);
  let side = V.cross(tau, WORLD_UP);
  // Straight up or down has no horizontal side; any perpendicular will do.
  if (V.length(side) < 1e-6) side = V.vec(0, 1, 0);
  side = V.normalize(side);
  return { tau, side, up: V.normalize(V.cross(side, tau)) };
}

/** The four cardinal generators of each cone, plus the straight-ahead ray — not a full ring. */
export function coneGuides(tangent) {
  const { tau, side, up } = tangentFrame(tangent);
  const out = [];

  for (const { theta, half } of legalCones()) {
    if (theta === 0) {
      out.push({ theta, half, label: 'straight', dir: tau });
      continue;
    }
    const c = Math.cos(half * DEG);
    const s = Math.sin(half * DEG);
    const spoke = (axis, k, label) => ({ theta, half, label, dir: V.add(V.scale(tau, c), V.scale(axis, k * s)) });
    out.push(spoke(side, 1, 'left'), spoke(side, -1, 'right'), spoke(up, 1, 'up'), spoke(up, -1, 'down'));
  }
  return out;
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

/** Samples along a circular arc of radius `radius` leaving `from` on heading `tStart`. */
export function arcSamples(from, tStart, normal, radius, theta, divisions = 24) {
  const inward = V.normalize(V.cross(normal, tStart));
  const center = V.add(from, V.scale(inward, radius));
  const spoke = V.scale(inward, -radius);

  const out = [];
  for (let i = 0; i <= divisions; i++) {
    out.push(V.add(center, V.rotateAbout(spoke, normal, (theta * DEG * i) / divisions)));
  }
  return out;
}

/** Points along a segment's own table arc. A straight run needs only its endpoints. */
export function samplePoints(seg, divisions = 24) {
  const { arc, from, to } = seg;
  if (!arc || arc.straight) return [from, to];
  return arcSamples(from, arc.tStart, arc.normal, arc.radius, arc.theta, divisions);
}

const fail = (reason, extra, tOut) => ({
  ok: false, tooTight: false, reason, arc: null, shop: null, route: null, ...extra, tOut,
});

/**
 * Classify one table span, in the order the spec lays down: degenerate, off the cones, rolling
 * elbow, Y+Z routing, drain, bend limit, shop layout.
 *
 * `ok` covers the centerline. `tooTight` is separate: the arc is angularly legal but its radius
 * is below `minRadius`, so a band of that width cannot follow it — the run is not broken.
 * `tOut` is the tangent handed on; on a violation it falls back to the straight chord so one bad
 * point does not invalidate everything after it.
 */
export function classifySegment(p0, p1, tangent, opts = {}) {
  const {
    toleranceDeg = 2,
    minRadius = 0,
    flangeOffset = 60,
    maxPieceLength = 1050,
    minLead = 100,
    slopeDeg = 3,
    slopeToleranceDeg = 1,
    drain = true,
  } = opts;

  const chordVec = V.sub(p1, p0);
  const chord = V.length(chordVec);

  if (chord < EPS) {
    return fail('degenerate', { chord: 0, cone: 0, error: 0, nearest: null, minRadius }, tangent);
  }

  const dir = V.normalize(chordVec);
  const frame = tangentFrame(tangent);
  const along = V.dot(chordVec, frame.tau);
  const lateral = V.dot(chordVec, frame.side);
  const vertical = V.dot(chordVec, frame.up);

  // Deviation split into the only two planes a shop elbow is allowed to live in.
  const devPlan = Math.atan2(lateral, along) / DEG;
  const devElev = Math.atan2(vertical, along) / DEG;

  const cone = coneAngleDeg(tangent, dir);
  const nearest = nearestSweep(cone);
  const base = {
    chord, cone, error: nearest.error, nearest, minRadius,
    minChord: minChordFor(nearest.theta, minRadius), devPlan, devElev,
  };
  const onCone = Math.abs(nearest.error) <= toleranceDeg;

  if (onCone && nearest.theta === 0) {
    const arc = arcFrom(p0, p1, 0, tangent);
    const rise = (p1.z ?? 0) - (p0.z ?? 0);
    if (drain && !drains(rise, chord, slopeDeg, slopeToleranceDeg)) {
      return fail('off-slope', { ...base, rise }, dir);
    }
    return {
      ok: true, tooTight: false, reason: null, ...base, arc, route: 'straight', rise,
      shop: { kind: 'straight', length: chord }, tOut: arc.tEnd,
    };
  }

  if (onCone) {
    // Built from the actual chord, so the swept angle stays exactly one of the permitted set.
    const plane = Math.abs(devElev) <= toleranceDeg ? 'plan'
      : Math.abs(devPlan) <= toleranceDeg ? 'elev'
        : null;

    if (plane) {
      const arc = arcFrom(p0, p1, nearest.theta, tangent);
      const tooTight = isTooTight(arc.radius, minRadius);
      const layout = elbowLayout({
        tableRadius: arc.radius, theta: nearest.theta, minRadius, flangeOffset, maxPieceLength,
      });
      return {
        ok: true,
        tooTight,
        reason: layout.reason ?? (tooTight ? 'too-tight' : null),
        ...base,
        arc,
        route: plane,
        shop: { kind: 'elbow', ...layout },
        tOut: arc.tEnd,
      };
    }
  }

  // Either off every cone, or a legal cone angle that would need a rolling elbow. Both are only
  // routable when the span has to change elevation relative to the tangent; a purely lateral
  // miss has no shop trick and is simply off the fan.
  if (Math.abs(devElev) <= toleranceDeg) {
    return fail('no-legal-arc', base, dir);
  }

  const kickFrom = V.add(p0, V.scale(frame.tau, minLead));
  const outVec = V.sub(p1, kickFrom);
  const outLength = V.length(outVec);
  const outDir = outLength > EPS ? V.normalize(outVec) : frame.tau;
  const kickDeg = coneAngleDeg(frame.tau, outDir);

  const angled = angledStraightPlan({ alongTrack: along, lead: minLead, kickDeg, outLength });
  if (angled.ok) {
    // The incoming stub may stay level; drain is judged on the run after the kick.
    const rise = (p1.z ?? 0) - (kickFrom.z ?? 0);
    if (drain && !drains(rise, outLength, slopeDeg, slopeToleranceDeg)) {
      return fail('off-slope', { ...base, route: 'angled', rise }, outDir);
    }
    return {
      ok: true, tooTight: false, reason: null, ...base, arc: null, route: 'angled', rise,
      shop: { kind: 'angled', lead: minLead, kickDeg, outLength },
      kick: { at: kickFrom, dir: outDir, deg: kickDeg },
      tOut: outDir,
    };
  }

  const cardinal = cardinalPlan({ along, lateral, vertical, minRadius, flangeOffset });
  if (cardinal.ok) {
    return {
      ok: true, tooTight: false, reason: null, ...base, arc: null, route: 'cardinal',
      shop: { kind: 'cardinal', radius: cardinal.radius, legs: cardinal.legs },
      cardinal: { ...cardinal, frame },
      tOut: V.scale(frame.up, cardinal.verticalSign),
    };
  }

  return fail('compound-bend', base, dir);
}

/**
 * Expand a span into the stretches a shop would actually build, as sampled polylines.
 * `kind` drives the overlay colour: amber elbow arcs, teal kicks, plain everywhere else.
 */
export function expandSegment(seg, divisions = 24) {
  const { from, to, shop, arc } = seg;
  if (!seg.ok || !shop) return [];

  if (shop.kind === 'straight') return [{ kind: 'straight', points: [from, to] }];

  if (shop.kind === 'elbow') {
    const { leftover, radius, theta } = shop;
    const f1 = V.add(from, V.scale(arc.tStart, leftover));
    const f2 = V.sub(to, V.scale(arc.tEnd, leftover));
    const out = [];
    if (leftover > EPS) out.push({ kind: 'straight', points: [from, f1] });
    out.push({ kind: 'elbow', arcDeg: theta, points: arcSamples(f1, arc.tStart, arc.normal, radius, theta, divisions) });
    if (leftover > EPS) out.push({ kind: 'straight', points: [f2, to] });
    return out;
  }

  if (shop.kind === 'angled') {
    // The kick is a vertex, so it gets a short flag either side of it to be visible at all.
    const at = seg.kick.at;
    const flag = 250;
    const back = V.add(at, V.scale(V.normalize(V.sub(from, at)), Math.min(flag, shop.lead / 2)));
    const fwd = V.add(at, V.scale(seg.kick.dir, Math.min(flag, shop.outLength / 2)));
    return [
      { kind: 'straight', points: [from, at] },
      { kind: 'kick', arcDeg: shop.kickDeg, points: [back, at, fwd] },
      { kind: 'straight', points: [at, to] },
    ];
  }

  if (shop.kind === 'cardinal') {
    const { frame, lateralSign, verticalSign, radius } = seg.cardinal;
    const dirs = [frame.tau, V.scale(frame.side, lateralSign), V.scale(frame.up, verticalSign)];
    const out = [];
    let cursor = from;

    for (let i = 0; i < dirs.length; i++) {
      const isLast = i === dirs.length - 1;
      const leg = shop.legs[i] - (i > 0 ? radius : 0) - (isLast ? 0 : radius);
      const end = V.add(cursor, V.scale(dirs[i], Math.max(leg, 0)));
      out.push({ kind: 'straight', points: [cursor, end] });
      if (isLast) break;

      const normal = V.normalize(V.cross(dirs[i], dirs[i + 1]));
      const samples = arcSamples(end, dirs[i], normal, radius, 90, divisions);
      out.push({ kind: 'elbow', arcDeg: 90, points: samples });
      cursor = samples[samples.length - 1];
    }
    return out;
  }

  return [];
}

/** The shop centerline of a whole run, as one polyline plus the kind-tagged stretches on it. */
export function expandRun(run, divisions = 24) {
  const stretches = [];
  for (const seg of run) {
    for (const st of expandSegment(seg, divisions)) stretches.push({ ...st, segIndex: seg.index });
  }

  const points = [];
  for (const st of stretches) {
    if (st.kind === 'kick') continue; // an overlay on the run, not a stretch of it
    for (const p of st.points) {
      const last = points[points.length - 1];
      if (last && V.distance(last, p) < 1e-6) continue;
      points.push(p);
    }
  }
  return { points, stretches };
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

  let inward = V.sub(dir, V.scale(tangent, V.dot(tangent, dir)));
  inward = V.length(inward) < EPS ? V.vec(0, 0, 0) : V.normalize(inward);

  const rad = half * DEG;
  const snappedDir = V.add(V.scale(tangent, Math.cos(rad)), V.scale(inward, Math.sin(rad)));
  const d = Math.max(chord, minChordFor(theta, minRadius));
  const target = V.add(p0, V.scale(snappedDir, d));

  return { ...p1, x: target.x, y: target.y, z: target.z };
}

export function solvePath(points, initialTangent, opts = {}) {
  return walkPath(points, initialTangent, (a, b, t) => classifySegment(a, b, t, opts));
}
