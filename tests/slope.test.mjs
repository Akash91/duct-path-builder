import test from 'node:test';
import assert from 'node:assert/strict';

import { DEG } from '../src/core/angles.js';
import { pitchDeg, isTooFlat, slopeOptionsFor, slopeFloorDeg } from '../src/core/slope.js';
import { classifySegment, snapToLegal, solvePath, splitCompound } from '../src/3d/geometry.js';
import * as V from '../src/3d/vec3.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const X = V.vec(1, 0, 0);
const origin = V.vec(0, 0, 0);
const SLOPE = { slopeDeg: 3, slopeTol: 1 };

test('pitch is asin(dz/chord); 10 mm rise over 100 mm is about 5.7°', () => {
  close(pitchDeg({ x: 0, y: 0, z: 10 }, { x: 100, y: 0, z: 20 }), Math.asin(10 / Math.hypot(100, 10)) / DEG, 1e-6);
  assert.equal(isTooFlat({ x: 0, y: 0, z: 10 }, { x: 100, y: 0, z: 20 }, 3, 1), false);
  assert.equal(isTooFlat(origin, { x: 100, y: 0, z: 0 }, 3, 1), true);
  close(slopeFloorDeg(3, 1), 2);
});

test('slopeOptionsFor follows the feature flag', () => {
  assert.equal(slopeOptionsFor({ features: {} }), null);
  const on = slopeOptionsFor({ features: { drainSlope: true } });
  assert.equal(on.slopeDeg, 3);
  assert.equal(on.slopeTol, 1);
});

test('a level straight is off-slope when drain is on (R-111)', () => {
  const seg = classifySegment(origin, { x: 1000, y: 0, z: 0 }, X, 2, 0, SLOPE);
  assert.equal(seg.ok, false);
  assert.equal(seg.reason, 'off-slope');
});

test('the same level straight is valid when drain is off', () => {
  const seg = classifySegment(origin, { x: 1000, y: 0, z: 0 }, X, 2);
  assert.equal(seg.ok, true);
  assert.equal(seg.arc.straight, true);
});

test('a 5.7° rise is a valid sloped straight (R-112, R-113)', () => {
  const p0 = { x: 0, y: 0, z: 10 };
  const p1 = { x: 100, y: 0, z: 20 };
  const seg = classifySegment(p0, p1, X, 2, 0, SLOPE);
  assert.equal(seg.ok, true);
  assert.equal(seg.arc.straight, true);
  assert.equal(seg.slopedStraight, true);
  assert.ok(Math.abs(seg.pitch) > 3);
});

test('an 11° slant is a sloped straight, not a near-miss 30° elbow (R-111)', () => {
  const p1 = { x: 100, y: 0, z: 20 };
  const seg = classifySegment(origin, p1, X, 2, 0, SLOPE);
  assert.equal(seg.ok, true);
  assert.equal(seg.arc.straight, true);
  assert.equal(seg.slopedStraight, true);
  assert.ok(Math.abs(seg.pitch) > 3);
});

test('a 3° pitched chord along x is a sloped straight, not a 30° elbow', () => {
  const dz = 1600 * Math.tan(3 * DEG);
  const p1 = { x: 1600, y: 0, z: dz };
  const seg = classifySegment(origin, p1, X, 2, 0, SLOPE);
  assert.equal(seg.ok, true);
  assert.equal(seg.arc.theta, 0);
  close(Math.abs(seg.pitch), 3, 1e-4);
});

test('a 30° plan elbow is unchanged by drain slope', () => {
  const dir = { x: Math.cos(15 * DEG), y: Math.sin(15 * DEG), z: 0 };
  const p1 = V.add(origin, V.scale(dir, 400));
  const seg = classifySegment(origin, p1, X, 2, 0, SLOPE);
  assert.equal(seg.ok, true);
  assert.equal(seg.arc.theta, 30);
  assert.equal(seg.reason, null);
});

test('Fix on a too-flat straight pitches z to 3° (R-114)', () => {
  const snapped = snapToLegal(origin, { x: 1000, y: 0, z: 0 }, X, 0, SLOPE);
  const seg = classifySegment(origin, snapped, X, 2, 0, SLOPE);
  assert.equal(seg.ok, true);
  close(Math.abs(pitchDeg(origin, snapped)), 3, 1e-4);
});

test('solvePath carries a sloped-straight tangent into the next span', () => {
  const p0 = { x: 0, y: 0, z: 10 };
  const p1 = { x: 100, y: 0, z: 20 };
  const p2 = { x: 200, y: 0, z: 30 };
  const sol = solvePath([p0, p1, p2], X, 2, 0, SLOPE);
  assert.equal(sol.errorCount, 0);
  assert.ok(sol.segments.every((s) => s.ok && s.arc.straight));
});

test('a Y+Z span is auto-routed into planar shop legs even with drain on (R-90c)', () => {
  const half = 30;
  const az = 45;
  const perp = V.normalize(V.cross(X, V.vec(0, 0, 1)));
  const spun = V.rotateAbout(perp, X, az * DEG);
  const dir = V.add(V.scale(X, Math.cos(half * DEG)), V.scale(spun, Math.sin(half * DEG)));
  const p1 = V.add(origin, V.scale(dir, 800));
  const split = splitCompound(origin, p1, X, 2, 0, SLOPE);
  assert.ok(split);
  assert.ok(split.legs.every((l) => l.ok));
  const seg = classifySegment(origin, p1, X, 2, 0, SLOPE);
  assert.equal(seg.ok, true);
  assert.ok(seg.legs?.length >= 2);
  assert.notEqual(seg.reason, 'compound-bend');
});

test('every shop straight on a Y+Z split drains at least 3° or is a riser (R-111)', () => {
  const p1 = { x: 800, y: 200, z: 200 };
  const split = splitCompound(origin, p1, X, 2, 0, SLOPE);
  assert.ok(split);
  const straights = split.legs.filter((l) => l.arc.straight);
  assert.ok(straights.length >= 1);
  for (const leg of straights) {
    assert.equal(isTooFlat(leg.from, leg.to, 3, 1), false, `pitch ${pitchDeg(leg.from, leg.to)}`);
    assert.ok(Math.abs(pitchDeg(leg.from, leg.to)) + 1e-9 >= 2);
  }
});

test('a target behind the tangent is not auto-routed (R-90c)', () => {
  const p1 = { x: -200, y: 100, z: 80 };
  const split = splitCompound(origin, p1, X, 2);
  assert.equal(split, null);
  const seg = classifySegment(origin, p1, X, 2);
  assert.equal(seg.ok, false);
});

test('the 3D demo pitched at 3° along x stays valid with drain on', () => {
  const k = Math.tan(3 * DEG);
  const points = [
    origin,
    { x: 1600, y: 0, z: 1600 * k },
    { x: 2083.0, y: 129.4, z: 2083.0 * k },
    { x: 3295.4, y: 829.4, z: 3295.4 * k },
  ];
  const sol = solvePath(points, X, 2, 0, SLOPE);
  assert.equal(sol.errorCount, 0, sol.segments.map((s) => s.reason).join(','));
  assert.ok(sol.segments[0].ok && sol.segments[0].arc.straight);
  close(Math.abs(pitchDeg(points[0], points[1])), 3, 1e-4);
});
