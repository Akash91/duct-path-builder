import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEG, arcFromChord, classifySegment, legalBearings, minChordFor,
  nearestLegal, snapToLegal, distance, bearingDeg, solvePath,
} from '../src/2d/geometry.js';
import { normalizeDeg, setSweeps, getSweeps, DEFAULT_SWEEPS } from '../src/core/angles.js';
import { validRuns } from '../src/core/solve.js';
import { arcPathD, runPathD } from '../src/2d/render.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const at = (p, bearing, dist) => ({
  x: p.x + dist * Math.cos(bearing * DEG),
  y: p.y + dist * Math.sin(bearing * DEG),
});

test('normalizeDeg wraps into (-180, 180]', () => {
  close(normalizeDeg(370), 10);
  close(normalizeDeg(-190), 170);
  close(normalizeDeg(180), 180);
  close(normalizeDeg(-180), 180);
});

test('arc endpoints are both exactly one radius from the centre', () => {
  for (const theta of [30, 45, 60]) {
    for (const dir of [1, -1]) {
      const p0 = { x: 40, y: 90 };
      const p1 = { x: 310, y: 220 };
      const arc = arcFromChord(p0, p1, theta, dir);
      close(distance(arc.center, p0), arc.radius, 1e-8);
      close(distance(arc.center, p1), arc.radius, 1e-8);
      close(Math.abs(normalizeDeg(arc.tEnd - arc.tStart)), theta, 1e-8);
    }
  }
});

test('legal bearings lay the half-angles off from the incoming tangent', () => {
  const got = legalBearings(0).map((c) => c.bearing).sort((a, b) => a - b);
  assert.deepEqual(got, [-45, -30, -22.5, -15, 0, 15, 22.5, 30, 45]);

  const shifted = legalBearings(20).map((c) => c.bearing).sort((a, b) => a - b);
  assert.deepEqual(shifted, [-25, -10, -2.5, 5, 20, 35, 42.5, 50, 65]);
});

test('a 0 sweep is a straight run with infinite radius and no handedness', () => {
  const p0 = { x: 10, y: 10 };
  const arc = arcFromChord(p0, { x: 210, y: 10 }, 0, 0);

  assert.equal(arc.straight, true);
  assert.equal(arc.radius, Infinity);
  assert.equal(arc.center, null);
  close(arc.tStart, arc.tEnd, 1e-12); // a straight run does not rotate the tangent
  assert.equal(legalBearings(0).filter((c) => c.theta === 0).length, 1);
});

test('with a zero-width band, feasibility is angular only — distance never matters', () => {
  const p0 = { x: 500, y: 400 };
  const tau = 37;
  for (const { bearing, theta } of legalBearings(tau)) {
    for (const dist of [0.5, 12, 250, 9000]) {
      const seg = classifySegment(p0, at(p0, bearing, dist), tau, 0.0001);
      assert.ok(seg.ok, `bearing ${bearing} at distance ${dist} should be legal`);
      close(seg.error, 0, 1e-9);
      assert.equal(seg.arc.theta, theta);
    }
  }
});

test('carrying straight on is legal and keeps the tangent unchanged', () => {
  const p0 = { x: 0, y: 0 };
  const seg = classifySegment(p0, at(p0, 75, 200), 75, 0.0001);

  assert.equal(seg.ok, true);
  assert.equal(seg.arc.theta, 0);
  assert.equal(seg.arc.straight, true);
  close(seg.error, 0, 1e-9);
  close(seg.tOut, 75, 1e-9);
});

test('a 90 degree sweep stays a short-way arc', () => {
  const p0 = { x: 0, y: 0 };
  const seg = classifySegment(p0, at(p0, 45, 200), 0, 0.0001);

  assert.equal(seg.ok, true);
  assert.equal(seg.arc.theta, 90);
  assert.equal(seg.arc.largeArcFlag, 0);
  close(seg.arc.radius, 200 / (2 * Math.sin(45 * DEG)), 1e-9);
  close(seg.tOut, 90, 1e-9); // a quarter turn from a heading of 0
});

test('turning harder than 45 degrees is still impossible', () => {
  const p0 = { x: 0, y: 0 };
  const seg = classifySegment(p0, at(p0, 75 + 60, 200), 75, 2);

  assert.equal(seg.ok, false);
  assert.equal(seg.reason, 'no-legal-arc');
  close(Math.abs(seg.error), 15, 1e-9); // 60 off tau, nearest ray is tau+45
});

test('the widest gap between adjacent legal rays is 7.5 degrees', () => {
  const p0 = { x: 0, y: 0 };
  // Midway between the straight ray and the 30deg ray is the worst reachable case.
  const seg = classifySegment(p0, at(p0, 7.5, 200), 0, 2);

  assert.equal(seg.ok, false);
  close(Math.abs(seg.error), 7.5, 1e-9);

  // The 30-to-45 gap is the same width, so the bound holds across the whole fan.
  close(Math.abs(classifySegment(p0, at(p0, 37.5, 200), 0, 2).error), 7.5, 1e-9);
});

test('tolerance flips a borderline segment', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = at(p0, 15 + 3, 200); // 3 degrees off the tau+15 ray

  assert.equal(classifySegment(p0, p1, 0, 2).ok, false);
  assert.equal(classifySegment(p0, p1, 0, 4).ok, true);

  // Accepted within tolerance, the arc still has an exact 30deg sweep (R-17).
  const seg = classifySegment(p0, p1, 0, 4);
  assert.equal(seg.arc.theta, 30);
  close(Math.abs(normalizeDeg(seg.arc.tEnd - seg.arc.tStart)), 30, 1e-9);
});

test('a zero-length segment is flagged as degenerate, not as a bad angle', () => {
  const seg = classifySegment({ x: 5, y: 5 }, { x: 5, y: 5 }, 0, 2);
  assert.equal(seg.ok, false);
  assert.equal(seg.reason, 'degenerate');
});

test('snapToLegal preserves distance and lands on a legal ray', () => {
  const p0 = { x: 100, y: 100 };
  const p1 = { x: 342, y: 17 };
  const snapped = snapToLegal(p0, p1, 20);

  close(distance(p0, snapped), distance(p0, p1), 1e-8);
  close(nearestLegal(bearingDeg(p0, snapped), 20).error, 0, 1e-8);
  assert.equal(classifySegment(p0, snapped, 20, 0.0001).ok, true);
});

test('an error does not cascade to the segments after it', () => {
  const tol = 10;
  const p0 = { x: 0, y: 0 };
  const p1 = at(p0, 22.5, 200); //  45deg, tau -> 45
  const p2 = at(p1, 60, 150); //   30deg, tau -> 75
  const p3 = at(p2, 135, 180); //  60 off tau: past the 30deg limit, so off by 30
  const p4 = at(p3, 157.5, 140); // legal again from the recovered chord bearing of 135

  const { segments, errorCount } = solvePath([p0, p1, p2, p3, p4], 0, tol);

  assert.equal(errorCount, 1);
  assert.deepEqual(segments.map((s) => s.ok), [true, true, false, true]);
  assert.equal(segments[0].arc.theta, 45);
  assert.equal(segments[1].arc.theta, 30);
  close(segments[2].tOut, 135, 1e-8); // recovery: outgoing tangent is the straight chord
  assert.equal(segments[3].arc.theta, 45);
});

test('a straight run threads correctly through a mixed path', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = at(p0, 15, 100); //  30deg, tau -> 30
  const p2 = at(p1, 30, 250); //  straight, tau stays 30
  const p3 = at(p2, 0, 120); //   60deg the other way, tau -> -30

  const { segments, errorCount } = solvePath([p0, p1, p2, p3], 0, 0.0001);

  assert.equal(errorCount, 0);
  assert.deepEqual(segments.map((s) => s.arc.theta), [30, 0, 60]);
  assert.equal(segments[1].arc.straight, true);
  close(segments[1].tOut, 30, 1e-8);
  close(segments[2].tOut, -30, 1e-8);
});

test('duct width is not part of the centerline geometry', () => {
  const p0 = { x: 0, y: 0 };
  const { segments } = solvePath([p0, at(p0, 22.5, 200)], 0, 1);
  // arcPathD takes only the segment — there is no width input it could consume.
  assert.equal(arcPathD(segments[0]).includes('NaN'), false);
  assert.equal(arcPathD.length, 1);
});

test('consecutive valid segments merge into one duct run', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = at(p0, 15, 100); //  30deg
  const p2 = at(p1, 30, 250); //  straight
  const p3 = at(p2, 0, 120); //   60deg

  const runs = validRuns(solvePath([p0, p1, p2, p3], 0, 0.0001));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].length, 3);

  // One M for the whole run, so butt caps land only on the two open ends.
  const d = runPathD(runs[0]);
  assert.equal(d.match(/M/g).length, 1);
  assert.equal(d.match(/[AL] /g).length, 3);
});

test('a violation splits the duct into separate runs', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = at(p0, 15, 100); //  30deg
  const p2 = at(p1, 130, 200); // unreachable, breaks the run
  const p3 = at(p2, 145, 150); // 30deg from the recovered tangent

  const runs = validRuns(solvePath([p0, p1, p2, p3], 0, 2));
  assert.deepEqual(runs.map((r) => r.length), [1, 1]);
});

test('minChordFor inverts the radius formula', () => {
  // d = 2 * r * sin(theta/2); at 60deg that is exactly r.
  close(minChordFor(60, 200), 200, 1e-9);
  close(minChordFor(30, 200), 2 * 200 * Math.sin(15 * DEG), 1e-9);
  assert.equal(minChordFor(0, 200), 0); // a straight run has no minimum
});

test('a bend tighter than the band can follow is flagged but stays angularly valid', () => {
  const p0 = { x: 0, y: 0 };
  const minRadius = 150;

  // 60deg over a short chord: r = chord, so 60 is well under the 150 required.
  const tight = classifySegment(p0, at(p0, 30, 60), 0, 0.0001, minRadius);
  assert.equal(tight.ok, true); // the centerline itself is legal
  assert.equal(tight.tooTight, true);
  assert.equal(tight.reason, 'too-tight');
  close(tight.arc.radius, 60, 1e-8);
  close(tight.minChord, 150, 1e-8);

  // Same bearing, far enough out: now it clears.
  const fine = classifySegment(p0, at(p0, 30, 400), 0, 0.0001, minRadius);
  assert.equal(fine.tooTight, false);
});

test('distance now matters — the same bearing passes or fails on length alone', () => {
  const p0 = { x: 0, y: 0 };
  const minRadius = 100;
  // On the 45deg ray the cutoff is 2 * 100 * sin(22.5) ~= 76.5.
  const results = [40, 70, 90, 500].map(
    (d) => classifySegment(p0, at(p0, 22.5, d), 0, 0.0001, minRadius).tooTight,
  );
  assert.deepEqual(results, [true, true, false, false]);
});

test('a straight run is never too tight, however short', () => {
  const p0 = { x: 0, y: 0 };
  const seg = classifySegment(p0, at(p0, 0, 0.5), 0, 0.0001, 10_000);
  assert.equal(seg.ok, true);
  assert.equal(seg.tooTight, false);
});

test('snapToLegal pushes a point out to the minimum bend distance', () => {
  const p0 = { x: 100, y: 100 };
  const minRadius = 200;
  const near = at(p0, 30, 20); // on the 60deg ray, far too close

  const snapped = snapToLegal(p0, near, 0, minRadius);
  close(distance(p0, snapped), minChordFor(60, minRadius), 1e-8);
  assert.equal(classifySegment(p0, snapped, 0, 0.0001, minRadius).tooTight, false);

  // Already far enough out, so the distance is left alone.
  const far = at(p0, 30, 900);
  close(distance(p0, snapToLegal(p0, far, 0, minRadius)), 900, 1e-8);
});

test('solvePath counts tight bends separately from errors', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = at(p0, 15, 40); //  30deg but very tight
  const p2 = at(p1, 30, 600); // straight, always fine

  const { errorCount, tightCount } = solvePath([p0, p1, p2], 0, 0.0001, 300);
  assert.equal(errorCount, 0);
  assert.equal(tightCount, 1);
});
