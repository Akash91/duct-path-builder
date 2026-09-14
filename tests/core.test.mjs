// Dimension-free core. These relationships must hold identically for the 2D and 3D builders.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEG, DEFAULT_SWEEPS, getSweeps, setSweeps,
  normalizeDeg, nearestSweep, sweepCandidates,
} from '../src/core/angles.js';
import { radiusFor, minChordFor, isTooTight } from '../src/core/arcMath.js';
import { walkPath, validRuns } from '../src/core/solve.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('normalizeDeg wraps into (-180, 180]', () => {
  close(normalizeDeg(370), 10);
  close(normalizeDeg(-190), 170);
  close(normalizeDeg(180), 180);
  close(normalizeDeg(-180), 180);
});

test('radiusFor inverts to minChordFor', () => {
  for (const theta of [30, 45, 60, 90]) {
    for (const r of [50, 137.5, 900]) {
      close(radiusFor(minChordFor(theta, r), theta), r, 1e-8);
    }
  }
});

test('a 0 sweep has infinite radius and no minimum chord', () => {
  assert.equal(radiusFor(123, 0), Infinity);
  assert.equal(minChordFor(0, 5000), 0);
  assert.equal(isTooTight(Infinity, 5000), false);
});

test('60deg arc over a chord of 100 has radius 100', () => {
  close(radiusFor(100, 60), 100, 1e-9); // 2 sin(30) == 1
});

test('sweep candidates are the half-angles, with 0 contributing once', () => {
  const halves = sweepCandidates().map((c) => c.half).sort((a, b) => a - b);
  assert.deepEqual(halves, [-45, -30, -22.5, -15, 0, 15, 22.5, 30, 45]);
});

test('the sweep set is configurable', () => {
  try {
    setSweeps([0, 90]);
    assert.deepEqual(getSweeps(), [0, 90]);
    assert.deepEqual(sweepCandidates().map((c) => c.half).sort((a, b) => a - b), [-45, 0, 45]);

    setSweeps([60, 30, 30, 999, -5, 'x']); // deduped, sorted, invalid dropped
    assert.deepEqual(getSweeps(), [30, 60]);

    assert.throws(() => setSweeps([200, -1]), /at least one valid sweep/i);
  } finally {
    setSweeps(DEFAULT_SWEEPS);
  }
});

test('nearestSweep works for a signed 2D deviation and an unsigned 3D cone angle', () => {
  close(nearestSweep(-16).half, -15, 1e-9);
  close(nearestSweep(16).half, 15, 1e-9);

  // A 3D cone angle is never negative, so only the positive candidates are ever selected.
  for (const alpha of [0, 3, 14, 21, 28, 44, 60]) {
    assert.ok(nearestSweep(alpha).half >= 0, `cone angle ${alpha} picked a negative half-angle`);
  }
});

test('the widest gap between adjacent half-angles is 7.5 degrees', () => {
  const halves = sweepCandidates().map((c) => c.half).filter((h) => h >= 0).sort((a, b) => a - b);
  const worst = Math.max(...halves.slice(1).map((h, i) => (h - halves[i]) / 2));
  close(worst, 7.5, 1e-9);
});

test('isTooTight treats the exact minimum as acceptable', () => {
  assert.equal(isTooTight(200, 200), false); // snapping lands here, so it must pass
  assert.equal(isTooTight(199, 200), true);
});

// walkPath is tangent-agnostic: these fakes use a plain counter as the "tangent".
test('walkPath carries the tangent forward and counts both failure modes', () => {
  const points = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const classify = (from, to, tangent) => {
    if (to.id === 'c') return { ok: false, tooTight: false, tOut: tangent };
    if (to.id === 'd') return { ok: true, tooTight: true, tOut: tangent + 1 };
    return { ok: true, tooTight: false, tOut: tangent + 1 };
  };

  const solution = walkPath(points, 0, classify);
  assert.deepEqual(solution.segments.map((s) => s.tauIn), [0, 1, 1]);
  assert.equal(solution.tangentOut, 2);
  assert.equal(solution.errorCount, 1);
  assert.equal(solution.tightCount, 1);
});

test('validRuns splits on invalid segments only', () => {
  const solution = { segments: [{ ok: true }, { ok: true }, { ok: false }, { ok: true }] };
  assert.deepEqual(validRuns(solution).map((r) => r.length), [2, 1]);

  // A too-tight segment is still valid, so it must not break a run (R-64).
  assert.equal(validRuns({ segments: [{ ok: true }, { ok: true, tooTight: true }] }).length, 1);
});
