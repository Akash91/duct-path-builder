// The shop read of a 3D path: which of the three manufactured kinds each span becomes, and
// what the demo path is supposed to look like when it loads.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifySegment, solvePath, expandSegment, expandRun, tangentFrame } from '../src/3d/geometry.js';
import { layoutPieces } from '../src/core/pieces.js';
import { validRuns } from '../src/core/solve.js';
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

// The shipped demo, lifted onto the 3 degree drain ramp exactly as the store seeds it.
const ramp = Math.tan(3 * DEG);
const DEMO = [[0, 0], [1600, 0], [2083.0, 129.4], [3295.4, 829.4]]
  .map(([x, y]) => ({ x, y, z: Math.round(x * ramp * 10) / 10 }));

test('the demo path reads as kick, short elbow, long straight', () => {
  const { segments, errorCount } = solvePath(DEMO, X, SHOP);

  assert.equal(errorCount, 0);
  assert.deepEqual(segments.map((s) => s.route), ['angled', 'plan', 'straight']);
});

test('demo span 1 is an angled straight: 100 mm lead, slight kick, sloped run', () => {
  const [span] = solvePath(DEMO, X, SHOP).segments;

  close(span.shop.lead, 100);
  assert.ok(span.shop.kickDeg > KICK_MIN_DEG && span.shop.kickDeg < 10, `kick was ${span.shop.kickDeg}`);
  close(span.kick.at.x, 100);
  close(span.kick.at.z, 0); // the stub follows the level start heading
});

test('demo span 2 is a compact 30 degree plan elbow that finishes before point 3', () => {
  const span = solvePath(DEMO, X, SHOP).segments[1];

  assert.equal(span.route, 'plan');
  assert.equal(span.arc.theta, 30);
  close(span.shop.radius, 600);
  close(span.shop.arcLength, 600 * 30 * DEG, 1e-4);
  assert.ok(Math.abs(span.shop.leftover - 98) < 2, `lead was ${span.shop.leftover}`);

  // The trail is already on the outgoing heading, so the next span can run straight.
  const stretches = expandSegment(span);
  assert.deepEqual(stretches.map((s) => s.kind), ['straight', 'elbow', 'straight']);
  const trail = stretches[2].points;
  const trailDir = V.normalize(V.sub(trail[1], trail[0]));
  close(V.dot(trailDir, span.tOut), 1, 1e-9);
});

test('demo span 3 is one straight, spliced at the maximum piece length', () => {
  const solution = solvePath(DEMO, X, SHOP);
  const span = solution.segments[2];
  assert.equal(span.route, 'straight');

  const { pieces } = layoutPieces(solution, SHOP);
  assert.deepEqual([...new Set(pieces.map((p) => p.kind))].sort(), ['angled', 'elbow', 'straight']);
  for (const p of pieces) assert.ok(p.length <= SHOP.maxPieceLength + 1e-6, `piece ${p.index} is ${p.length}`);
  assert.equal(pieces.filter((p) => p.kind === 'elbow').length, 1);
});

test('the expanded run is the shop centerline, not the table arcs', () => {
  const solution = solvePath(DEMO, X, SHOP);
  const [run] = validRuns(solution);
  const { points, stretches } = expandRun(run);

  assert.ok(stretches.some((s) => s.kind === 'elbow'));
  assert.ok(stretches.some((s) => s.kind === 'kick'));

  // Every sample of the amber stretch sits on a circle of the shrunken radius.
  const elbow = stretches.find((s) => s.kind === 'elbow');
  const span = solution.segments[1];
  const inward = V.normalize(V.cross(span.arc.normal, span.arc.tStart));
  const center = V.add(elbow.points[0], V.scale(inward, span.shop.radius));
  for (const p of elbow.points) close(V.distance(center, p), span.shop.radius, 1e-6);

  const { pieces } = layoutPieces(solution, SHOP);
  const cut = pieces.reduce((n, p) => n + p.length, 0);
  // The drawn polyline chords its arcs, so it falls a hair short of the true cut length.
  close(totalLength(points), cut, 0.05);
});

test('a span that moves in Y and Z is aimed, not rolled into one elbow', () => {
  const p0 = { x: 0, y: 0, z: 0 };
  const p1 = { x: 2000, y: 600, z: 300 };
  const seg = classifySegment(p0, p1, X, SHOP);

  assert.equal(seg.ok, true);
  assert.equal(seg.route, 'angled');
  assert.equal(seg.arc, null, 'a Y+Z span is never one rolling elbow');
  assert.equal(seg.shop.kind, 'angled');
});

test('the cardinal pair is a fallback, not the first answer', () => {
  const p0 = { x: 0, y: 0, z: 0 };
  // Reachable by aiming, so the angled straight wins and the cardinals are never consulted.
  assert.equal(classifySegment(p0, { x: 2000, y: 600, z: 300 }, X, SHOP).route, 'angled');

  // Too sharp to aim, but each cardinal leg still has room.
  const sharp = classifySegment(p0, { x: 900, y: 3000, z: 2000 }, X, SHOP);
  assert.equal(sharp.route, 'cardinal');
  assert.equal(sharp.shop.kind, 'cardinal');

  // Too sharp to aim and too cramped to turn twice.
  const cramped = classifySegment(p0, { x: 120, y: 300, z: 200 }, X, SHOP);
  assert.equal(cramped.ok, false);
  assert.equal(cramped.reason, 'compound-bend');
});

test('an angled straight needs its lead, a forward target and a slight kick', () => {
  assert.equal(angledStraightPlan({ alongTrack: 80, lead: 100, kickDeg: 3, outLength: 500 }).ok, false);
  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: 3, outLength: 0 }).ok, false);
  assert.equal(angledStraightPlan({ alongTrack: 500, lead: 100, kickDeg: 0.2, outLength: 500 }).ok, false);
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
