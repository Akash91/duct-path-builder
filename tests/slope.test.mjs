// Drainage. A wash-down duct is never laid dead level, but it may run off either way, so the
// rule is on the magnitude of the pitch, not its sign.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pitchDeg, drainFloorDeg, drains, pitchedRise } from '../src/core/slope.js';
import { classifySegment } from '../src/3d/geometry.js';
import * as V from '../src/3d/vec3.js';

const X = V.vec(1, 0, 0);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const shop = (over = {}) => ({ toleranceDeg: 2, slopeDeg: 3, slopeToleranceDeg: 1, minRadius: 600, ...over });

test('pitch is asin(rise / chord), signed with +Z up', () => {
  close(pitchDeg(50, 100), 30, 1e-9);
  close(pitchDeg(-50, 100), -30, 1e-9);
  close(pitchDeg(0, 100), 0);
  close(pitchDeg(5, 0), 0); // a degenerate chord has no pitch to speak of
});

test('the floor is the drain pitch less its tolerance', () => {
  close(drainFloorDeg(3, 1), 2);
  close(drainFloorDeg(1, 4), 0); // never negative
});

test('a rise and a fall both drain; only near-level does not', () => {
  const run = 1000;
  const at = (deg) => run * Math.tan((deg * Math.PI) / 180);

  assert.equal(drains(at(3), run, 3, 1), true);
  assert.equal(drains(-at(3), run, 3, 1), true);
  assert.equal(drains(at(2), run, 3, 1), true); // exactly on the floor
  assert.equal(drains(at(1.5), run, 3, 1), false);
  assert.equal(drains(0, run, 3, 1), false);
  assert.equal(drains(at(25), run, 3, 1), true); // a steep slant is still fine
});

test('a level straight is off-slope, and a pitched one is not', () => {
  const flat = classifySegment({ x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 }, X, shop());
  assert.equal(flat.ok, false);
  assert.equal(flat.reason, 'off-slope');

  const tangent = V.normalize(V.vec(1, 0, Math.tan((3 * Math.PI) / 180)));
  const fall = classifySegment({ x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: -104.8 }, V.normalize(V.vec(1, 0, -Math.tan((3 * Math.PI) / 180))), shop());
  const rise = classifySegment({ x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 104.8 }, tangent, shop());

  assert.equal(rise.ok, true);
  assert.equal(rise.route, 'straight');
  assert.equal(fall.ok, true);
  assert.equal(fall.route, 'straight');
});

test('an elevation-only chord on pitch is a sloped straight, not a forced fitting', () => {
  const tangent = V.normalize(V.vec(1, 0, Math.tan((6 * Math.PI) / 180)));
  const seg = classifySegment({ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 105.1 }, tangent, shop());

  assert.equal(seg.route, 'straight');
  assert.equal(seg.arc.theta, 0);
});

test('drain is judged after the kick, so a level 100 mm stub is fine', () => {
  const seg = classifySegment({ x: 0, y: 0, z: 0 }, { x: 1600, y: 0, z: 83.9 }, X, shop());

  assert.equal(seg.ok, true);
  assert.equal(seg.route, 'angled');
  close(seg.shop.lead, 100, 1e-9);
  // The stub stays on the old level heading; the run after it is what has to fall.
  close(seg.kick.at.z, 0, 1e-9);
  assert.ok(Math.abs(pitchDeg(seg.rise, seg.shop.outLength)) >= 2);
});

test('turning drain off leaves a level straight valid', () => {
  const seg = classifySegment({ x: 0, y: 0, z: 0 }, { x: 2000, y: 0, z: 0 }, X, shop({ drain: false }));
  assert.equal(seg.ok, true);
  assert.equal(seg.reason, null);
});

test('a fix pitches to the drain angle, following the fall already drawn', () => {
  close(pitchedRise(1000, 3, 0), 1000 * Math.tan((3 * Math.PI) / 180), 1e-9);
  close(pitchedRise(1000, 3, -5), -1000 * Math.tan((3 * Math.PI) / 180), 1e-9);
  close(pitchedRise(1000, 3, 5), 1000 * Math.tan((3 * Math.PI) / 180), 1e-9);
});
