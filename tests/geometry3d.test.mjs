// 3D geometry. The headline property (docs/requirements.md §3.5) is that each permitted sweep
// becomes a cone around the incoming tangent, and the 2D rays are that cone cut by the plane.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  arcFrom, classifySegment, coneAngleDeg, legalCones,
  samplePoints, snapToLegal, solvePath,
} from '../src/3d/geometry.js';
import * as V from '../src/3d/vec3.js';
import { classifySegment as classify2d } from '../src/2d/geometry.js';
import { DEG } from '../src/core/angles.js';

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

test('every azimuth around a cone is equally legal', () => {
  for (const { theta, half } of legalCones()) {
    for (const azimuth of [0, 37, 90, 180, 275, 359]) {
      const dir = onCone(X, half, azimuth);
      const seg = classifySegment(origin, at(origin, dir, 300), X, 1e-6);

      assert.ok(seg.ok, `theta ${theta} at azimuth ${azimuth} should be legal`);
      assert.equal(seg.arc.theta, theta);
      close(seg.error, 0, 1e-9);
    }
  }
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
    const dir = onCone(X, half, 63);
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
  const dir = onCone(X, 30, 20);
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

test('turning harder than 45 degrees is unreachable in any direction', () => {
  for (const azimuth of [0, 90, 210]) {
    const seg = classifySegment(origin, at(origin, onCone(X, 60, azimuth), 300), X, 2);
    assert.equal(seg.ok, false);
    assert.equal(seg.reason, 'no-legal-arc');
    close(Math.abs(seg.error), 15, 1e-8); // 60 off the tangent, nearest cone is 45
  }
});

test('the bend limit applies exactly as in 2D', () => {
  const minRadius = 200;
  const dir = onCone(X, 30, 100); // the 60deg cone

  assert.equal(classifySegment(origin, at(origin, dir, 60), X, 1e-6, minRadius).tooTight, true);
  assert.equal(classifySegment(origin, at(origin, dir, 900), X, 1e-6, minRadius).tooTight, false);

  // d_min = 2 r sin(theta/2) = r at 60 degrees.
  const boundary = classifySegment(origin, at(origin, dir, 200), X, 1e-6, minRadius);
  assert.equal(boundary.tooTight, false);
  close(boundary.minChord, 200, 1e-7);
});

test('snapToLegal keeps the azimuth and only corrects the cone angle', () => {
  const minRadius = 150;
  const off = onCone(X, 26, 140); // nearer the 22.5 cone (3.5 away) than the 30 one (4 away)
  const p1 = at(origin, off, 40); // also inside the dead zone

  const snapped = snapToLegal(origin, p1, X, minRadius);
  const seg = classifySegment(origin, snapped, X, 1e-6, minRadius);

  assert.equal(seg.ok, true);
  assert.equal(seg.arc.theta, 45);
  assert.equal(seg.tooTight, false);
  close(coneAngleDeg(X, V.normalize(V.sub(snapped, origin))), 22.5, 1e-7);
  close(V.distance(origin, snapped), 2 * minRadius * Math.sin(22.5 * DEG), 1e-7);

  // Azimuth preserved: the snapped direction stays in the plane of the tangent and the original.
  const plane = V.normalize(V.cross(X, off));
  close(V.dot(plane, V.normalize(V.sub(snapped, origin))), 0, 1e-8);
});

test('a tolerated near-miss still lands exactly on the point', () => {
  // 3 degrees off the 60deg cone, accepted by a 4 degree tolerance.
  const off = onCone(X, 33, 55);
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
  const p2 = at(p1, onCone(t1, 60, 45), 300); // unreachable
  const t2 = V.normalize(V.sub(p2, p1));
  const p3 = at(p2, onCone(t2, 22.5, 10), 300); // legal from the recovered chord direction

  const { segments, errorCount } = solvePath([p0, p1, p2, p3], X, 2);
  assert.equal(errorCount, 1);
  assert.deepEqual(segments.map((s) => s.ok), [true, false, true]);
  assert.equal(segments[0].arc.theta, 30);
  assert.equal(segments[2].arc.theta, 45);
  closeVec(segments[1].tOut, t2, 1e-9);
});
