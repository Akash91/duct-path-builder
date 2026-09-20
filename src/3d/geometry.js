// 3D specialisation: the incoming tangent is a unit vector, so each permitted half-angle
// sweeps out a *cone* around it rather than a pair of rays (docs/requirements.md §3.5).
//
// The consequence is that validation is simpler here than in 2D: one angle between the tangent
// and the chord, compared against the half-angle set. There is no handedness to choose, because
// the arc's plane is fixed by the tangent and the chord together.

import { DEG, nearestSweep, sweepCandidates } from '../core/angles.js';
import { EPS, radiusFor, minChordFor, isTooTight } from '../core/arcMath.js';
import { walkPath } from '../core/solve.js';
import { compactBendParams, fabricationSpans, shopElbowRadius } from '../core/flange.js';
import { isTooFlat, pitchDeg, slopeFloorDeg } from '../core/slope.js';
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
 * Orthonormal frame around the incoming tangent: `h` is world-horizontal left/right (plan),
 * `v` is up/down in the vertical plane that contains the tangent (elevation).
 */
export function bendFrame(tangent) {
  const t = V.normalize(tangent);
  let h = V.cross(V.vec(0, 0, 1), t);
  if (V.length(h) < EPS) h = V.vec(1, 0, 0);
  h = V.normalize(h);
  const v = V.normalize(V.cross(t, h));
  return { t, h, v };
}

/**
 * How far the chord's turn is from a pure plan or elevation bend, in degrees.
 * A straight run (chord along the tangent) is 0 — there is no turn to judge (R-90).
 */
export function planeErrorDeg(tangent, chordDir) {
  const t = V.normalize(tangent);
  const d = V.normalize(chordDir);
  const sideways = V.sub(d, V.scale(t, V.dot(t, d)));
  if (V.length(sideways) < EPS) return 0;

  const { h, v } = bendFrame(t);
  const n = V.normalize(sideways);
  const az = Math.atan2(V.dot(n, v), V.dot(n, h)) / DEG;
  const folded = Math.abs(((az % 90) + 90) % 90);
  return Math.min(folded, 90 - folded);
}

/** Nearest plan or elevation unit, in the plane perpendicular to the tangent. */
export function cardinalInward(tangent, chordDir) {
  const { h, v } = bendFrame(tangent);
  const t = V.normalize(tangent);
  const d = V.normalize(chordDir);
  let sideways = V.sub(d, V.scale(t, V.dot(t, d)));
  if (V.length(sideways) < EPS) return h;
  sideways = V.normalize(sideways);
  const ah = V.dot(sideways, h);
  const av = V.dot(sideways, v);
  if (Math.abs(ah) >= Math.abs(av)) return V.scale(h, Math.sign(ah) || 1);
  return V.scale(v, Math.sign(av) || 1);
}

/** 'straight' | 'plan' | 'elev' — which cardinal the chord's sideways sits on. */
export function turnAxis(tangent, chordDir) {
  const t = V.normalize(tangent);
  const d = V.normalize(chordDir);
  const sideways = V.sub(d, V.scale(t, V.dot(t, d)));
  if (V.length(sideways) < EPS) return 'straight';
  const { h, v } = bendFrame(t);
  const n = V.normalize(sideways);
  return Math.abs(V.dot(n, v)) >= Math.abs(V.dot(n, h)) ? 'elev' : 'plan';
}

/** 'straight' | 'plan' | 'elev' — which cardinal the (valid) bend sits on. */
export function turnKind(seg) {
  if (!seg?.arc || seg.arc.straight) return 'straight';
  if (seg.from && seg.to && seg.tauIn) return turnAxis(seg.tauIn, V.sub(seg.to, seg.from));
  if (!seg.tauIn || !seg.arc.normal) return 'elbow';
  const { h, v } = bendFrame(seg.tauIn);
  return Math.abs(V.dot(seg.arc.normal, v)) >= Math.abs(V.dot(seg.arc.normal, h)) ? 'plan' : 'elev';
}

/** Straight ahead, or the four cardinal generators of a cone of half-angle `half`. */
export function legalDirections(tangent, half) {
  const { t, h, v } = bendFrame(tangent);
  if (!(half > 0)) return [t];
  const c = Math.cos(half * DEG);
  const s = Math.sin(half * DEG);
  return [
    V.add(V.scale(t, c), V.scale(h, s)),
    V.add(V.scale(t, c), V.scale(h, -s)),
    V.add(V.scale(t, c), V.scale(v, s)),
    V.add(V.scale(t, c), V.scale(v, -s)),
  ];
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
 *
 * `opts.slopeDeg` / `opts.slopeTol` enable drainage (R-110). `opts.splitCompound === false`
 * stops a compound span from inserting planar shop legs (used when classifying those legs).
 */

export function classifySegment(p0, p1, tangent, toleranceDeg, minRadius = 0, opts = null) {
  const chordVec = V.sub(p1, p0);
  const chord = V.length(chordVec);

  if (chord < EPS) {
    return { ok: false, tooTight: false, reason: 'degenerate', chord: 0, cone: 0, planeError: 0, error: 0, nearest: null, arc: null, minRadius, tauIn: tangent, tOut: tangent, pitch: 0 };
  }

  const dir = V.normalize(chordVec);
  const cone = coneAngleDeg(tangent, dir);
  const nearest = nearestSweep(cone);
  const planeError = planeErrorDeg(tangent, dir);
  const pitch = pitchDeg(p0, p1);
  const compound = planeError > toleranceDeg + 1e-9;
  const sweepOk = Math.abs(nearest.error) <= toleranceDeg;
  const slopeOn = Number.isFinite(opts?.slopeDeg);
  const floor = slopeOn ? slopeFloorDeg(opts.slopeDeg, opts.slopeTol ?? 1) : 0;

  const finish = (arc, extra = {}) => {
    const tooTight = isTooTight(arc.radius, minRadius);
    return {
      ok: true,
      tooTight,
      reason: tooTight ? 'too-tight' : null,
      chord, cone, planeError, pitch, error: nearest.error, nearest, arc, minRadius,
      minChord: minChordFor(arc.theta, minRadius),
      tauIn: tangent,
      tOut: arc.tEnd,
      ...extra,
    };
  };

  if (sweepOk && !compound) {
    const arc = arcFrom(p0, p1, nearest.theta, tangent);
    if (slopeOn && arc.straight && isTooFlat(p0, p1, opts.slopeDeg, opts.slopeTol)) {
      return {
        ok: false, tooTight: false, reason: 'off-slope',
        chord, cone, planeError, pitch, error: Math.abs(pitch), nearest, arc, minRadius,
        minChord: 0, tauIn: tangent, tOut: dir,
      };
    }
    return finish(arc);
  }

  if (compound && opts?.splitCompound !== false) {
    const split = splitCompound(p0, p1, tangent, toleranceDeg, minRadius, opts);
    if (split) {
      return {
        ok: true,
        tooTight: split.legs.some((l) => l.tooTight),
        reason: null,
        chord, cone, planeError, pitch, error: 0, nearest,
        arc: split.legs[split.legs.length - 1].arc,
        minRadius,
        minChord: Math.max(0, ...split.legs.map((l) => l.minChord || 0)),
        tauIn: tangent,
        tOut: split.legs[split.legs.length - 1].tOut,
        legs: split.legs,
        via: split.via,
        split: split.order,
      };
    }
  }

  // A straight that rises or falls enough to drain is valid even when the cone is
  // closer to a 30° fitting than to 0° (R-111, R-113). Plan turns stay discrete.
  if (slopeOn && !compound && Math.abs(pitch) + 1e-9 >= floor) {
    const axis = turnAxis(tangent, dir);
    if (axis === 'elev' || axis === 'straight') {
      const arc = arcFrom(p0, p1, 0, dir);
      return finish(arc, { error: 0, reason: null, slopedStraight: true });
    }
  }

  if (slopeOn && !compound && (nearest.theta === 0 || turnAxis(tangent, dir) === 'straight') && isTooFlat(p0, p1, opts.slopeDeg, opts.slopeTol)) {
    return {
      ok: false, tooTight: false, reason: 'off-slope',
      chord, cone, planeError, pitch, error: Math.abs(pitch), nearest, arc: null, minRadius,
      tauIn: tangent, tOut: dir,
    };
  }

  if (sweepOk && compound) {
    return {
      ok: false, tooTight: false, reason: 'compound-bend',
      chord, cone, planeError, pitch, error: planeError, nearest, arc: null, minRadius,
      tauIn: tangent, tOut: dir,
    };
  }

  return { ok: false, tooTight: false, reason: 'no-legal-arc', chord, cone, planeError, pitch, error: nearest.error, nearest, arc: null, minRadius, tauIn: tangent, tOut: dir };
}

function asLeg(result, from, to) {
  return { ...result, from, to, legs: undefined, via: undefined, split: undefined };
}

function tryShopLegs(points, tau0, order, toleranceDeg, minRadius, childOpts) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const legs = [];
  let tau = tau0;
  for (let i = 0; i + 1 < points.length; i++) {
    if (V.distance(points[i], points[i + 1]) < EPS) return null;
    const leg = asLeg(
      classifySegment(points[i], points[i + 1], tau, toleranceDeg, minRadius, childOpts),
      points[i],
      points[i + 1],
    );
    if (!leg.ok) return null;
    legs.push(leg);
    tau = leg.tOut;
  }
  return { order, via: points[1], legs, to: last };
}

/**
 * Waypoints for two 90° cardinal elbows plus leftover straights.
 * `aHat` is the first turn (plan or elev); `bHat` is the second.
 * End = p0 + (La+R) t + (2R+Lm) aHat + (R+Lb) bHat.
 */
function cardinalWaypoints(p0, t, aHat, bHat, La, R, Lm, Lb) {
  const pts = [p0];
  let pos = p0;
  const push = (next) => {
    if (V.distance(pos, next) > EPS) pts.push(next);
    pos = next;
  };
  if (La > EPS) push(V.add(pos, V.scale(t, La)));
  push(V.add(pos, V.add(V.scale(t, R), V.scale(aHat, R))));
  if (Lm > EPS) push(V.add(pos, V.scale(aHat, Lm)));
  push(V.add(pos, V.add(V.scale(aHat, R), V.scale(bHat, R))));
  if (Lb > EPS) push(V.add(pos, V.scale(bHat, Lb)));
  return pts;
}

function dirPitchDeg(dir) {
  const L = V.length(dir);
  if (!(L > EPS)) return 0;
  return Math.asin(Math.min(1, Math.max(-1, dir.z / L))) / DEG;
}

/** Horizontal run pitched by `alpha` toward `vHat`, so a straight can drain (R-111). A riser is left alone. */
function pitchedHorizontal(dir, vHat, alpha) {
  const horiz = V.vec(dir.x, dir.y, 0);
  if (V.length(horiz) < EPS) return dir;
  const h = V.normalize(horiz);
  return V.normalize(V.add(V.scale(h, Math.cos(alpha)), V.scale(vHat, Math.sin(alpha))));
}

function perpToward(tau, toward) {
  const u = V.sub(toward, V.scale(tau, V.dot(tau, toward)));
  if (V.length(u) < EPS) return null;
  return V.normalize(u);
}

/**
 * Same cardinal 90°/straight skeleton as `cardinalWaypoints`, but every too-flat leftover is
 * pitched to `alpha` toward `vHat`. The last point is the table endpoint so leftover rise
 * is a riser/slant (R-111, R-112).
 */
function cardinalWaypointsDrained(p0, p1, t, aHat, bHat, vHat, La, R, Lm, alpha) {
  const pts = [p0];
  let pos = p0;
  const push = (next) => {
    if (V.distance(pos, next) > EPS) pts.push(next);
    pos = next;
  };
  let tau = t;
  const floor = slopeFloorDeg(alpha / DEG, 1);

  if (La > EPS) {
    const flat = Math.abs(dirPitchDeg(tau)) + 1e-9 < floor;
    const dir = flat ? pitchedHorizontal(tau, vHat, alpha) : tau;
    const L = Math.abs(dir.z) > 0.9 ? La : La / Math.max(Math.cos(alpha), 0.2);
    push(V.add(pos, V.scale(dir, L)));
    tau = dir;
  }

  const turn0 = perpToward(tau, aHat) ?? aHat;
  push(V.add(pos, V.add(V.scale(tau, R), V.scale(turn0, R))));
  tau = turn0;

  if (Lm > EPS) {
    const flat = Math.abs(dirPitchDeg(tau)) + 1e-9 < floor;
    const dir = flat ? pitchedHorizontal(tau, vHat, alpha) : tau;
    const L = flat ? Lm / Math.max(Math.cos(alpha), 0.2) : Lm;
    push(V.add(pos, V.scale(dir, L)));
    tau = dir;
  }

  const turn1 = perpToward(tau, bHat) ?? bHat;
  push(V.add(pos, V.add(V.scale(tau, R), V.scale(turn1, R))));
  push(p1);
  return pts;
}

function straightsDrain(legs, opts) {
  if (!Number.isFinite(opts?.slopeDeg)) return true;
  return legs.every((l) => !l.arc?.straight || !isTooFlat(l.from, l.to, opts.slopeDeg, opts.slopeTol));
}

/**
 * Route a compound table span as planar shop legs: 90° plan and 90° elevation, with
 * leftover as straights (R-90c). Discrete 30/45/60 cones cannot generally hit an
 * arbitrary Y+Z chord with C1, so the shop path uses sharp cardinal elbows instead.
 * Waypoints are derived; they are not table points.
 *
 * Straight leftovers are pitched to `slopeDeg` when drain is on (R-111); elbows are
 * not judged for pitch. Waypoints are derived; they are not table points.
 */
export function splitCompound(p0, p1, tangent, toleranceDeg, minRadius = 0, opts = null) {
  const slopeOn = Number.isFinite(opts?.slopeDeg);
  const childOpts = { ...(opts ?? {}), splitCompound: false };
  const { t, h, v } = bendFrame(tangent);
  const delta = V.sub(p1, p0);
  const along = V.dot(delta, t);
  const plan = V.dot(delta, h);
  const elev = V.dot(delta, v);
  if (!(along > EPS) || Math.abs(plan) < EPS || Math.abs(elev) < EPS) return null;

  const hHat = V.scale(h, Math.sign(plan));
  const vHat = V.scale(v, Math.sign(elev) || 1);
  const absPlan = Math.abs(plan);
  const absElev = Math.abs(elev);

  const candidates = [
    { order: 'plan-elev', aHat: hHat, bHat: vHat, mid: absPlan, last: absElev },
    { order: 'elev-plan', aHat: vHat, bHat: hHat, mid: absElev, last: absPlan },
  ];

  const offsetMm = Number.isFinite(opts?.offsetMm) ? opts.offsetMm : 60;
  const maxPieceMm = Number.isFinite(opts?.maxPieceMm) ? opts.maxPieceMm : 1050;
  const alpha = slopeOn ? (opts.slopeDeg ?? 3) * DEG : 0;

  let best = null;
  for (const spec of candidates) {
    const rMax = Math.min(along, spec.mid / 2, spec.last);
    if (!(rMax > EPS)) continue;
    const R = Math.min(rMax, shopElbowRadius(rMax, 90, offsetMm, maxPieceMm, minRadius));
    if (!(R > EPS)) continue;
    const La = along - R;
    const Lm = spec.mid - 2 * R;
    const Lb = spec.last - R;
    const points = slopeOn
      ? cardinalWaypointsDrained(p0, p1, t, spec.aHat, spec.bHat, vHat, La, R, Lm, alpha)
      : cardinalWaypoints(p0, t, spec.aHat, spec.bHat, La, R, Lm, Lb);
    const hit = tryShopLegs(points, tangent, spec.order, toleranceDeg, minRadius, childOpts);
    if (!hit) continue;
    if (V.distance(hit.to, p1) > 1e-3) continue;
    if (slopeOn && !straightsDrain(hit.legs, opts)) continue;
    const straight = La + Lm + Lb;
    const longest = Math.max(La, Lm, Lb);
    if (
      !best
      || straight > best.straight + 1e-6
      || (Math.abs(straight - best.straight) <= 1e-6 && longest > best.longest + 1e-6)
    ) {
      best = { ...hit, R, straight, longest };
    }
  }
  return best;
}

/**
 * Pull `p1` onto the nearest legal cone *and* the nearest plan/elevation cardinal (R-93).
 * A too-flat straight is pitched to `slopeDeg` without turning in plan.
 */
export function snapToLegal(p0, p1, tangent, minRadius = 0, opts = null) {
  const chordVec = V.sub(p1, p0);
  const chord = V.length(chordVec);
  if (chord < EPS) return { ...p1 };

  const dir = V.normalize(chordVec);
  const { theta, half } = nearestSweep(coneAngleDeg(tangent, dir));
  const inward = half > 0 ? cardinalInward(tangent, dir) : V.vec(0, 0, 0);

  const rad = half * DEG;
  const snappedDir = V.add(V.scale(V.normalize(tangent), Math.cos(rad)), V.scale(inward, Math.sin(rad)));
  const d = Math.max(chord, minChordFor(theta, minRadius));
  const target = V.add(p0, V.scale(snappedDir, d));
  const out = { ...p1, x: target.x, y: target.y, z: target.z };

  if (opts && Number.isFinite(opts.slopeDeg) && theta === 0) {
    const horiz = Math.hypot(out.x - p0.x, out.y - p0.y);
    if (horiz > EPS && isTooFlat(p0, out, opts.slopeDeg, opts.slopeTol)) {
      const sign = Math.sign((p1.z ?? 0) - (p0.z ?? 0)) || 1;
      out.z = p0.z + sign * horiz * Math.tan(opts.slopeDeg * DEG);
    }
  }

  return out;
}

export function solvePath(points, initialTangent, toleranceDeg, minRadius = 0, opts = null) {
  return walkPath(points, initialTangent, (a, b, t) =>
    classifySegment(a, b, t, toleranceDeg, minRadius, opts));
}

/** Pose at `dist` along a solved segment, for flange stations (R-143). */
export function poseAlong(seg, dist) {
  const { from, to, arc } = seg;
  if (!arc || arc.straight) {
    const span = V.sub(to, from);
    const L = V.length(span) || 1;
    const t = Math.min(1, Math.max(0, dist / L));
    const p = V.add(from, V.scale(span, t));
    const tangent = arc?.tStart ?? V.normalize(span);
    return { x: p.x, y: p.y, z: p.z, tangent };
  }
  const ang = dist / arc.radius;
  const start = V.scale(arc.inward, -arc.radius);
  const p = V.add(arc.center, V.rotateAbout(start, arc.normal, ang));
  const tangent = V.rotateAbout(arc.tStart, arc.normal, ang);
  return { x: p.x, y: p.y, z: p.z, tangent };
}

/**
 * Shop centerline: flatten planar legs from a compound table span, then compact elbows
 * so leftover length is straight (R-149).
 */
function expandPart(seg, options) {
  if (!options) return [seg];
  const { offsetMm, maxPieceMm, minRadius = 0 } = options;
  const spans = fabricationSpans(seg, offsetMm, maxPieceMm, minRadius);
  const params = compactBendParams(seg, offsetMm, maxPieceMm, minRadius);
  const t0 = seg.arc?.tStart ?? V.normalize(V.sub(seg.to, seg.from));
  const t1 = seg.arc?.tEnd ?? t0;
  const S = V.add(seg.from, V.scale(t0, params.lead));
  const E = V.add(seg.to, V.scale(t1, -params.trail));
  const out = [];
  for (const span of spans) {
    if (span.role === 'full') {
      out.push(seg);
      continue;
    }
    if (span.role === 'lead') {
      out.push({
        ...seg,
        from: seg.from,
        to: S,
        chord: span.length,
        arc: { straight: true, theta: 0, tStart: t0, tEnd: t0, radius: Infinity },
      });
      continue;
    }
    if (span.role === 'trail') {
      out.push({
        ...seg,
        from: E,
        to: seg.to,
        chord: span.length,
        arc: { straight: true, theta: 0, tStart: t1, tEnd: t1, radius: Infinity },
      });
      continue;
    }
    const arc = arcFrom(S, E, span.theta, t0);
    out.push({ ...seg, from: S, to: E, chord: span.length, arc });
  }
  return out;
}

export function expandRun(run, options) {
  if (!run?.length) return run ?? [];
  const out = [];
  for (const seg of run) {
    const parts = seg.legs?.length ? seg.legs : [seg];
    for (const part of parts) out.push(...expandPart(part, options));
  }
  return out;
}
