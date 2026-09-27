// The shop read of a 3D path: which of the three manufactured kinds each span becomes, and
// what the demo path is supposed to look like when it loads.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifySegment, solvePath, expandRun, tangentFrame } from '../src/3d/geometry.js';
import { layoutPieces } from '../src/core/pieces.js';
import { validRuns } from '../src/core/solve.js';
import { DEMO_POINTS } from '../src/core/store.js';
import { angledStraightPlan, cardinalPlan, KICK_MIN_DEG, KICK_MAX_DEG } from '../src/core/routing.js';
import { totalLength } from '../src/core/polyline.js';
import { DEG } from '../src/core/angles.js';
import * as V from '../src/3d/vec3.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const X = V.vec(1, 0, 0);

const SHOP = {
  toleranceDeg: 2, minRadius: 600, flangeOffset: 60, maxPieceLength: 1050,
  minLead: 100, slopeDeg: 3, slopeToleranceDeg: 1, drain: true,
};

// Shipped 3D defaults: drawing radii kept, jacket-sized bend limit, 1250 mm pieces.
const DEMO_SHOP = {
  toleranceDeg: 2, minRadius: 509, flangeOffset: 60, maxPieceLength: 1250,
  minLead: 100, slopeDeg: 3, slopeToleranceDeg: 1, drain: true, compact: false,
};

const DEMO = DEMO_POINTS.map(([x, y, z]) => ({ x, y, z }));

const DEMO_ROUTES = [
  'angled', 'elev', 'straight', 'plan', 'straight',
  'elev', 'straight', 'elev', 'straight', 'elev', 'straight',
];

test('the demo path reads as the drawing: sloped start, four elbows, risers', () => {
  const { segments, errorCount, tightCount } = solvePath(DEMO, X, DEMO_SHOP);

  assert.equal(errorCount, 0);
  assert.equal(tightCount, 0);
  assert.deepEqual(segments.map((s) => s.route), DEMO_ROUTES);
  assert.deepEqual(segments.filter((s) => s.shop.kind === 'elbow').map((s) => s.arc.theta), [90, 30, 30, 45, 30]);
});

test('demo span 1 is an angled straight: 100 mm lead, 3° kick, sloped run', () => {
  const [span] = solvePath(DEMO, X, DEMO_SHOP).segments;

  close(span.shop.lead, 100);
  assert.ok(span.shop.kickDeg > KICK_MIN_DEG && span.shop.kickDeg < 5, `kick was ${span.shop.kickDeg}`);
  close(span.kick.at.x, 100);
  close(span.kick.at.z, 0); // the stub follows the level start heading
});

test('demo elbows keep the radii the drawing implies', () => {
  const spans = solvePath(DEMO, X, DEMO_SHOP).segments.filter((s) => s.shop.kind === 'elbow');
  const expected = [657, 675, 675, 509, 560];

  assert.equal(spans.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    close(spans[i].shop.radius, expected[i], 0.1);
    close(spans[i].shop.leftover, 0);
  }
});

test('demo leftovers splice at the maximum piece length', () => {
  const solution = solvePath(DEMO, X, DEMO_SHOP);
  assert.equal(solution.segments[2].route, 'straight');

  const { pieces } = layoutPieces(solution, DEMO_SHOP);
  assert.deepEqual([...new Set(pieces.map((p) => p.kind))].sort(), ['angled', 'elbow', 'straight']);
  for (const p of pieces) assert.ok(p.length <= DEMO_SHOP.maxPieceLength + 1e-6, `piece ${p.index} is ${p.length}`);
  assert.equal(pieces.filter((p) => p.kind === 'elbow').length, 5);
});

test('the expanded run is the shop centerline, not the table arcs', () => {
  const solution = solvePath(DEMO, X, DEMO_SHOP);
  const [run] = validRuns(solution);
  const { points, stretches } = expandRun(run);

  assert.ok(stretches.some((s) => s.kind === 'elbow'));
  assert.ok(stretches.some((s) => s.kind === 'kick'));

  const elbow = stretches.find((s) => s.kind === 'elbow');
  const span = solution.segments[1];
  const inward = V.normalize(V.cross(span.arc.normal, span.arc.tStart));
  const center = V.add(elbow.points[0], V.scale(inward, span.shop.radius));
  for (const p of elbow.points) close(V.distance(center, p), span.shop.radius, 1e-6);

  const { pieces } = layoutPieces(solution, DEMO_SHOP);
  const cut = pieces.reduce((n, p) => n + p.length, 0);
  // The drawn polyline chords its arcs, so it falls a hair short of the true cut length.
  close(totalLength(points), cut, 0.5);
});

test('a Y+Z span off every cone is aimed, not turned into a fitting', () => {
  const p0 = { x: 0, y: 0, z: 0 };
  // A slight offset in both, off the cones but reachable by aiming within the kick ceiling.
  const p1 = { x: 4000, y: 200, z: 200 };
  const seg = classifySegment(p0, p1, X, SHOP);

  assert.equal(seg.ok, true);
  assert.equal(seg.route, 'angled');
  assert.equal(seg.arc, null);
  assert.equal(seg.shop.kind, 'angled');
  assert.ok(seg.shop.kickDeg <= KICK_MAX_DEG);
});

test('a Y+Z span on a cone is a rolled elbow, not a mitre', () => {
  // 45 degrees off the tangent, rolled roughly halfway between plan and elevation.
  const dir = V.normalize(V.vec(Math.cos(45 * DEG), Math.sin(45 * DEG) * 0.7, Math.sin(45 * DEG) * 0.714));
  const seg = classifySegment({ x: 0, y: 0, z: 0 }, V.scale(dir, 3000), X, SHOP);

  assert.equal(seg.ok, true);
  assert.equal(seg.route, 'rolled');
  assert.equal(seg.arc.theta, 90);
  assert.ok(Math.abs(seg.devPlan) > SHOP.toleranceDeg && Math.abs(seg.devElev) > SHOP.toleranceDeg);
});

test('a Y+Z span too sharp to aim is not quietly mitred', () => {
  // 19 degrees of aim is a lobsterback mitre, not a fitting: it has to be an elbow or fail.
  const seg = classifySegment({ x: 0, y: 0, z: 0 }, { x: 2000, y: 600, z: 300 }, X, SHOP);

  assert.equal(seg.ok, false);
  assert.equal(seg.reason, 'compound-bend');
});

test('the cardinal pair is a fallback, not the first answer', () => {
  const p0 = { x: 0, y: 0, z: 0 };
  // Reachable by aiming, so the angled straight wins and the cardinals are never consulted.
  assert.equal(classifySegment(p0, { x: 4000, y: 200, z: 200 }, X, SHOP).route, 'angled');

  // Too sharp to aim, but each cardinal leg still has room.
  const sharp = classifySegment(p0, { x: 900, y: 3000, z: 2000 }, X, SHOP);
  assert.equal(sharp.route, 'cardinal');
  assert.equal(sharp.shop.kind, 'cardinal');

  // Too sharp to aim and too cramped to turn twice.
  const cramped = classifySegment(p0, { x: 120, y: 300, z: 200 }, X, SHOP);
  assert.equal(cramped.ok, false);
  assert.equal(cramped.reason, 'compound-bend');
});

test('a span that never moves sideways is off the fan, not a compound bend', () => {
  // A near-horizontal run asked to turn up ~76 degrees: no Y at all, just past the 45 degree fan.
  const seg = classifySegment({ x: 0, y: 0, z: 0 }, { x: 665, y: 0, z: 3498 }, X, SHOP);

  assert.equal(seg.ok, false);
  assert.equal(seg.reason, 'no-legal-arc');
  close(seg.devPlan, 0, 1e-9);
  assert.ok(seg.devElev > 45, 'the turn is outside the fan');
});

test('an angled straight needs its lead, a forward target and a slight kick', () => {
  assert.equal(angledStraightPlan({ alongTrack: 80, lead: 100, kickDeg: 3, outLength: 500 }).ok, false);
  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: 3, outLength: 0 }).ok, false);
  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: 0.2, outLength: 500 }).ok, false);
  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: 20, outLength: 500 }).ok, false);
  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: 75, outLength: 500 }).ok, false);

  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: KICK_MIN_DEG, outLength: 500 }).ok, true);
  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: KICK_MAX_DEG, outLength: 500 }).ok, true);
});

test('each cardinal leg has to carry its own elbows', () => {
  const base = { minRadius: 600, flangeOffset: 60 };
  assert.equal(cardinalPlan({ along: 2000, lateral: 2000, vertical: 2000, ...base }).ok, true);
  assert.equal(cardinalPlan({ along: 500, lateral: 2000, vertical: 2000, ...base }).ok, false);
  assert.equal(cardinalPlan({ along: 2000, lateral: 1100, vertical: 2000, ...base }).ok, false);
  assert.equal(cardinalPlan({ along: 2000, lateral: 2000, vertical: 500, ...base }).ok, false);
});

test('an elevation elbow is legal, and so is a plan elbow off a ramp', () => {
  const p0 = { x: 0, y: 0, z: 0 };

  const up = classifySegment(p0, { x: 1732, y: 0, z: 1000 }, X, SHOP); // 30 degrees, pure elevation
  assert.equal(up.route, 'elev');
  assert.equal(up.arc.theta, 60);

  const ramped = V.normalize(V.vec(1, 0, Math.tan(3 * DEG)));
  const frame = tangentFrame(ramped);
  const chord = V.add(V.scale(frame.tau, 1000 * Math.cos(15 * DEG)), V.scale(frame.side, 1000 * Math.sin(15 * DEG)));
  const plan = classifySegment(p0, V.add(p0, chord), ramped, SHOP);
  assert.equal(plan.route, 'plan');
  assert.equal(plan.arc.theta, 30);
});

test('too tight does not break the run', () => {
  const p0 = { x: 0, y: 0, z: 0 };
  const p1 = { x: 200 * Math.cos(15 * DEG), y: 200 * Math.sin(15 * DEG), z: 0 };
  const seg = classifySegment(p0, p1, X, { ...SHOP, drain: false });

  assert.equal(seg.ok, true);
  assert.equal(seg.tooTight, true);
  assert.equal(seg.reason, 'too-tight');
  assert.ok(seg.arc, 'the real arc is still drawn');
});
