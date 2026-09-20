// 3D geometry. The headline property (docs/requirements.md §3.5) is that each permitted sweep
// becomes a cone around the incoming tangent, and the 2D rays are that cone cut by the plane.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arcFrom, classifySegment, coneAngleDeg, legalCones, planeErrorDeg, snapToLegal, solvePath,
  samplePoints, turnKind, expandRun, poseAlong, splitCompound,
} from '../src/3d/geometry.js';
import * as V from '../src/3d/vec3.js';
import { classifySegment as classify2d } from '../src/2d/geometry.js';
import { DEG } from '../src/core/angles.js';
import { layoutRun, compactBendParams, segmentLength, isBend } from '../src/core/flange.js';
import { validRuns } from '../src/core/solve.js';

const close = (a, b, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const closeVec = (a, b, eps = 1e-8) => {
  close(a.x, b.x, eps); close(a.y, b.y, eps); close(a.z, b.z, eps);
};

const X = V.vec(1, 0, 0);
const origin = V.vec(0, 0, 0);

/** A direction at `half` degrees off `tangent`, rotated `azimuth` degrees around it. */
function onCone(tangent, half, azimuthDeg) {
  const seed = Math.abs(tangent.z) > 0.9 ? V.vec(1, 0, 0) : V.vec(0, 0, 1);
  const perp = V.normalize(V.cross(tangent, seed));
  const spun = V.rotateAbout(perp, tangent, azimuthDeg * DEG);
  return V.add(V.scale(tangent, Math.cos(half * DEG)), V.scale(spun, Math.sin(half * DEG)));
}

const at = (p, dir, dist) => V.add(p, V.scale(dir, dist));

test('cone half-angles are the sweeps halved, with no handedness', () => {
  assert.deepEqual(legalCones(), [
    { theta: 0, half: 0 },
    { theta: 30, half: 15 },
    { theta: 45, half: 22.5 },
    { theta: 60, half: 30 },
    { theta: 90, half: 45 },
  ]);
});

test('only plan and elevation azimuths on a cone are legal', () => {
  for (const { theta, half } of legalCones()) {
    for (const azimuth of [0, 90, 180, 270]) {
      const dir = onCone(X, half, azimuth);
      const seg = classifySegment(origin, at(origin, dir, 300), X, 1e-6);

      assert.ok(seg.ok, `theta ${theta} at azimuth ${azimuth} should be legal`);
      assert.equal(seg.arc.theta, theta);
      close(seg.error, 0, 1e-9);
      close(seg.planeError, 0, 1e-6);
    }
  }
});

test('a cone hit that turns in y and z is auto-routed into planar 90° shop legs (R-90c)', () => {
  const dir = onCone(X, 30, 45); // on the 60° cone, halfway between plan and elevation
  const p1 = at(origin, dir, 300);
  const split = splitCompound(origin, p1, X, 2);
  assert.ok(split, 'Y+Z should route into planar shop legs');
  assert.ok(split.legs.length >= 2);
  for (const leg of split.legs) {
    assert.equal(leg.ok, true);
    close(leg.planeError, 0, 1e-4);
    assert.ok(leg.arc.theta === 0 || leg.arc.theta === 90, `shop sweep ${leg.arc.theta}`);
  }
  const elbows = split.legs.filter((l) => l.arc.theta === 90);
  assert.equal(elbows.length, 2);
  const kinds = new Set(elbows.map((l) => turnKind(l)));
  assert.ok(kinds.has('plan') && kinds.has('elev'));

  const seg = classifySegment(origin, p1, X, 2);
  assert.equal(seg.ok, true);
  assert.ok(seg.legs?.length >= 2);
  closeVec(seg.legs[seg.legs.length - 1].to, p1, 1e-6);
});

test('the 2D rays are this cone cut by the working plane', () => {
  // In the XY plane, a cone of half-angle h meets the plane at exactly the two 2D bearings.
  for (const { theta, half } of legalCones()) {
    for (const sign of [1, -1]) {
      const bearing = sign * half;
      const flat = { x: Math.cos(bearing * DEG), y: Math.sin(bearing * DEG), z: 0 };

      const seg3 = classifySegment(origin, at(origin, flat, 400), X, 1e-6);
      const seg2 = classify2d({ x: 0, y: 0 }, { x: 400 * flat.x, y: 400 * flat.y }, 0, 1e-6);

      assert.equal(seg3.arc.theta, theta);
      assert.equal(seg2.arc.theta, theta);
      // Same scalar maths, shared from core. A straight run is Infinity in both.
      if (theta === 0) assert.equal(seg3.arc.radius, seg2.arc.radius);
      else close(seg3.arc.radius, seg2.arc.radius, 1e-7);
    }
  }
});

test('an arc leaves along the tangent and its endpoints sit on the circle', () => {
  for (const { theta, half } of legalCones().filter((c) => c.theta > 0)) {
    const dir = onCone(X, half, 90);
    const p1 = at(origin, dir, 275);
    const arc = arcFrom(origin, p1, theta, X);

    close(V.distance(arc.center, origin), arc.radius);
    close(V.distance(arc.center, p1), arc.radius);
    close(coneAngleDeg(arc.tStart, arc.tEnd), theta, 1e-8); // total turn is the sweep
    close(coneAngleDeg(arc.tEnd, dir), half, 1e-8); // exit deviates from the chord by theta/2
    close(V.length(arc.tEnd), 1, 1e-9);
  }
});

test('sampled points all lie on the arc and hit both endpoints', () => {
  const dir = onCone(X, 30, 0);
  const p1 = at(origin, dir, 500);
  const seg = { from: origin, to: p1, arc: arcFrom(origin, p1, 60, X) };

  const pts = samplePoints(seg, 16);
  closeVec(pts[0], origin, 1e-7);
  closeVec(pts[pts.length - 1], p1, 1e-7);
  for (const p of pts) close(V.distance(seg.arc.center, p), seg.arc.radius, 1e-7);
});

test('a straight run carries the tangent through unchanged', () => {
  const seg = classifySegment(origin, at(origin, X, 120), X, 1e-6);
  assert.equal(seg.arc.theta, 0);
  assert.equal(seg.arc.straight, true);
  closeVec(seg.tOut, X);
});

test('turning harder than 45 degrees is unreachable in one plane', () => {
  for (const azimuth of [0, 90]) {
    const seg = classifySegment(origin, at(origin, onCone(X, 60, azimuth), 300), X, 2);
    assert.equal(seg.ok, false);
    assert.equal(seg.reason, 'no-legal-arc');
    close(Math.abs(seg.error), 15, 1e-8); // 60 off the tangent, nearest cone is 45
  }
  // Off-cardinal and too hard for one elbow: still connectable as planar 90° shop legs.
  const compound = classifySegment(origin, at(origin, onCone(X, 60, 210), 300), X, 2);
  assert.equal(compound.ok, true);
  assert.ok(compound.legs?.length >= 2);
});

test('the bend limit applies exactly as in 2D', () => {
  const minRadius = 200;
  const dir = onCone(X, 30, 90); // the 60deg cone, elevation

  assert.equal(classifySegment(origin, at(origin, dir, 60), X, 1e-6, minRadius).tooTight, true);
  assert.equal(classifySegment(origin, at(origin, dir, 900), X, 1e-6, minRadius).tooTight, false);

  // d_min = 2 r sin(theta/2) = r at 60 degrees.
  const boundary = classifySegment(origin, at(origin, dir, 200), X, 1e-6, minRadius);
  assert.equal(boundary.tooTight, false);
  close(boundary.minChord, 200, 1e-7);
});

test('snapToLegal lands on the nearest plan or elevation cardinal', () => {
  const minRadius = 150;
  const off = onCone(X, 26, 10); // nearer the 22.5 cone; 10° off plan, so snap stays in plan
  const p1 = at(origin, off, 40); // also inside the dead zone

  const snapped = snapToLegal(origin, p1, X, minRadius);
  const seg = classifySegment(origin, snapped, X, 1e-6, minRadius);

  assert.equal(seg.ok, true);
  assert.equal(seg.arc.theta, 45);
  assert.equal(seg.tooTight, false);
  assert.equal(turnKind(seg), 'plan');
  close(coneAngleDeg(X, V.normalize(V.sub(snapped, origin))), 22.5, 1e-7);
  close(V.distance(origin, snapped), 2 * minRadius * Math.sin(22.5 * DEG), 1e-7);
  close(planeErrorDeg(X, V.normalize(V.sub(snapped, origin))), 0, 1e-6);
});

test('a tolerated near-miss still lands exactly on the point', () => {
  // 3 degrees off the 60deg cone, accepted by a 4 degree tolerance.
  const off = onCone(X, 33, 2);
  const p1 = at(origin, off, 420);
  const seg = classifySegment(origin, p1, X, 4);

  assert.equal(seg.ok, true);
  assert.equal(seg.arc.theta, 60);

  const pts = samplePoints(seg.arc ? { from: origin, to: p1, arc: seg.arc } : null, 32);
  closeVec(pts[pts.length - 1], p1, 1e-7); // no gap at the far end

  // The slack shows up as a kink against the incoming tangent, exactly as in 2D (R-17).
  close(coneAngleDeg(X, seg.arc.tStart), Math.abs(seg.error), 1e-7);
  close(coneAngleDeg(seg.arc.tStart, seg.arc.tEnd), 60, 1e-7);
});

test('errors do not cascade in 3D either', () => {
  const p0 = origin;
  const p1 = at(p0, onCone(X, 15, 0), 300);
  const t1 = classifySegment(p0, p1, X, 1e-6).tOut;
  const p2 = at(p1, onCone(t1, 60, 0), 300); // too hard in plan — not a Y+Z split
  const t2 = V.normalize(V.sub(p2, p1));
  const p3 = at(p2, onCone(t2, 22.5, 0), 300); // legal from the recovered chord direction

  const { segments, errorCount } = solvePath([p0, p1, p2, p3], X, 2);
  assert.equal(errorCount, 1);
  assert.deepEqual(segments.map((s) => s.ok), [true, false, true]);
  assert.equal(segments[0].arc.theta, 30);
  assert.equal(segments[2].arc.theta, 45);
  closeVec(segments[1].tOut, t2, 1e-9);
});

test('a long 3D arc expands to straights plus a compact elbow (R-149)', () => {
  const p0 = { x: 0, y: 0, z: 0 };
  const p1 = { x: 200, y: 0, z: 0 };
  const dir = V.vec(Math.cos(15 * DEG), Math.sin(15 * DEG), 0);
  const p2 = at(p1, dir, 5000);
  const tOut = V.vec(Math.cos(30 * DEG), Math.sin(30 * DEG), 0);
  const p3 = at(p2, tOut, 200);
  const sol = solvePath([p0, p1, p2, p3], X, 0.5, 0);
  assert.equal(sol.errorCount, 0);

  const bend = sol.segments[1];
  const params = compactBendParams(bend, 60, 1050, 0);
  assert.equal(params.compact, true);
  assert.equal(params.ok, true);

  const run = validRuns(sol)[0];
  const shop = expandRun(run, { offsetMm: 60, maxPieceMm: 1050, minRadius: 0 });
  close(shop.reduce((n, s) => n + segmentLength(s), 0), layoutRun(run, 60, 1050).total, 1e-3);
  assert.equal(shop.filter(isBend).length, 1);
  close(shop.find(isBend).arc.radius, params.radius, 1e-3);

  const mid = poseAlong(shop.find(isBend), shop.find(isBend).arc.radius * 15 * DEG);
  assert.ok(Number.isFinite(mid.z));
  close(mid.z, 0, 1e-6);
});

test('expandRun flattens a Y+Z table span into planar shop pieces', () => {
  const dir = onCone(X, 30, 45);
  const p1 = at(origin, dir, 800);
  const sol = solvePath([origin, p1], X, 2, 0);
  assert.equal(sol.errorCount, 0);
  assert.ok(sol.segments[0].legs?.length >= 2);
  const shop = expandRun(sol.segments, { offsetMm: 60, maxPieceMm: 1050, minRadius: 0 });
  assert.ok(shop.length >= sol.segments[0].legs.length);
  assert.ok(shop.every((s) => s.ok && s.arc));
  assert.equal(shop.filter(isBend).length, 2);
});

test('a large Y+Z span uses compact 90° elbows so leftover is long straight (R-90c, R-149)', () => {
  const p1 = { x: 3000, y: 2000, z: 1500 };
  const minRadius = 600;
  const split = splitCompound(origin, p1, X, 2, minRadius);
  assert.ok(split);
  const elbows = split.legs.filter((l) => l.arc?.theta === 90);
  assert.equal(elbows.length, 2);
  for (const e of elbows) {
    assert.ok(e.arc.radius <= minRadius + 1e-6, `elbow radius ${e.arc.radius} should be compact`);
  }
  const rMax = Math.min(3000, 2000 / 2, 1500);
  assert.ok(elbows[0].arc.radius < rMax - 1, 'must not keep the largest radius that fits the offsets');

  const sol = solvePath([origin, p1], X, 2, minRadius);
  const shop = expandRun(sol.segments, { offsetMm: 60, maxPieceMm: 1050, minRadius });
  const straightLen = shop.filter((s) => s.arc.straight).reduce((n, s) => n + segmentLength(s), 0);
  const bendLen = shop.filter(isBend).reduce((n, s) => n + segmentLength(s), 0);
  assert.ok(straightLen > bendLen);
});
