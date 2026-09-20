import test from 'node:test';
import assert from 'node:assert/strict';

import { DEG } from '../src/core/angles.js';
import {
  layoutPieces, layoutRun, segmentLength, isBend,
  flangeOptionsFor, defaultAddReach, fabricationDigest,
  compactBendParams, fabricationSpans, pickPieceAt2d, pickPieceAt3d,
  describePiece, pieceTipHtml,
} from '../src/core/flange.js';
import { solvePath, poseAlong, expandRun } from '../src/2d/geometry.js';
import { validRuns } from '../src/core/solve.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const OPT = { offsetMm: 60, maxPieceMm: 1050 };

const at = (p, bearing, dist) => ({
  x: p.x + dist * Math.cos(bearing * DEG),
  y: p.y + dist * Math.sin(bearing * DEG),
});

function solve(points) {
  return solvePath(points, 0, 0.5, 0);
}

test('with the feature off nothing is laid out', () => {
  const sol = solve([{ x: 0, y: 0 }, { x: 2000, y: 0 }]);
  const laid = layoutPieces(sol, null);
  assert.equal(laid.pieces.length, 0);
  assert.equal(laid.flanges.length, 0);
});

test('a long straight is auto-spliced at 1050 mm', () => {
  const sol = solve([{ x: 0, y: 0 }, { x: 2100, y: 0 }]);
  const laid = layoutPieces(sol, OPT);
  assert.equal(laid.pieces.length, 2);
  assert.ok(laid.pieces.every((p) => p.kind === 'straight' && p.ok));
  close(laid.pieces[0].length, 1050);
  close(laid.pieces[1].length, 1050);
  assert.deepEqual(laid.flanges.map((f) => f.kind), ['end', 'splice', 'end']);
});

test('a 2000 mm run becomes two 1000 mm pieces', () => {
  const sol = solve([{ x: 0, y: 0 }, { x: 2000, y: 0 }]);
  const laid = layoutPieces(sol, OPT);
  assert.equal(laid.pieces.length, 2);
  close(laid.pieces[0].length, 1000);
  close(laid.pieces[1].length, 1000);
});

test('an elbow is its own piece with 60 mm stubs cut from the adjacent straights', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 1600, y: 0 };
  const p2 = at(p1, 15, 500);
  const p3 = at(p2, 30, 1400);
  const sol = solve([p0, p1, p2, p3]);
  assert.equal(sol.errorCount, 0);
  assert.equal(sol.segments.filter((s) => isBend(s)).length, 1);

  const laid = layoutPieces(sol, OPT);
  const elbows = laid.pieces.filter((p) => p.kind === 'elbow');
  assert.equal(elbows.length, 1);
  const elbow = elbows[0];
  assert.equal(elbow.ok, true);
  const arc = segmentLength(sol.segments[1]);
  close(elbow.length, 60 + arc + 60, 1e-4);
  close(elbow.s0, 1600 - 60, 1e-4);
  close(elbow.s1, 1600 + arc + 60, 1e-4);

  // Leftover before the elbow: 1540 mm → two even pieces. After: 1340 mm → two.
  const straights = laid.pieces.filter((p) => p.kind === 'straight');
  assert.equal(straights.length, 4);
  assert.ok(straights.every((p) => p.ok && p.length <= 1050 + 1e-6));
  close(straights[0].length + straights[1].length, 1540, 1e-4);
  close(straights[2].length + straights[3].length, 1340, 1e-4);
});

test('a path that starts on a bend has no 60 mm incoming stub', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = at(p0, 15, 400);
  const sol = solve([p0, p1]);
  assert.equal(sol.errorCount, 0);
  assert.equal(isBend(sol.segments[0]), true);

  const laid = layoutPieces(sol, OPT);
  const elbow = laid.pieces.find((p) => p.kind === 'elbow');
  assert.equal(elbow.ok, false);
  assert.equal(elbow.reason, 'short-stub');
});

test('two bends with less than 120 mm between their arcs fail', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 400, y: 0 };
  const p2 = at(p1, 15, 200);
  const p3 = at(p2, 45, 200);
  const p4 = at(p3, 60, 400);
  const sol = solve([p0, p1, p2, p3, p4]);
  assert.equal(sol.errorCount, 0);
  const bends = sol.segments.filter(isBend);
  assert.equal(bends.length, 2);

  const laid = layoutPieces(sol, OPT);
  const elbows = laid.pieces.filter((p) => p.kind === 'elbow');
  assert.ok(elbows.some((e) => !e.ok && e.reason === 'short-stub'));
});

test('an elbow longer than 1050 mm is compacted into straights plus a sharp turn (R-149)', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 200, y: 0 };
  const p2 = at(p1, 15, 5000);
  const p3 = at(p2, 30, 200);
  const sol = solve([p0, p1, p2, p3]);
  assert.equal(sol.errorCount, 0);

  const bend = sol.segments[1];
  const params = compactBendParams(bend, OPT.offsetMm, OPT.maxPieceMm, 0);
  assert.equal(params.compact, true);
  assert.equal(params.ok, true);
  assert.ok(params.lead > 60);
  close(params.lead, params.trail);
  assert.ok(2 * OPT.offsetMm + params.radius * params.theta * DEG <= OPT.maxPieceMm + 1e-6);

  const spans = fabricationSpans(bend, OPT.offsetMm, OPT.maxPieceMm, 0);
  assert.deepEqual(spans.map((s) => s.role), ['lead', 'arc', 'trail']);

  const laid = layoutPieces(sol, OPT);
  const elbows = laid.pieces.filter((p) => p.kind === 'elbow');
  assert.equal(elbows.length, 1);
  assert.equal(elbows[0].ok, true);
  assert.ok(elbows[0].length <= OPT.maxPieceMm + 1e-6);
  assert.equal(elbows[0].theta, 30);
  assert.ok(laid.pieces.every((p) => p.ok && p.length <= OPT.maxPieceMm + 1e-6));
  assert.ok(laid.pieces.filter((p) => p.kind === 'straight').length >= 2);

  const run = validRuns(sol)[0];
  const shop = expandRun(run, OPT);
  close(shop.reduce((n, s) => n + segmentLength(s), 0), layoutRun(run, OPT.offsetMm, OPT.maxPieceMm).total, 1e-3);
  assert.equal(shop.filter(isBend).length, 1);
  const shopBend = shop.find(isBend);
  close(shopBend.arc.radius, params.radius, 1e-3);
  assert.ok(shop.filter((s) => s.arc.straight).length >= 2);
});

test('a bend that already fits is still compacted down to r_min so leftover is straight (R-149)', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 1600, y: 0 };
  const p2 = at(p1, 15, 500);
  const p3 = at(p2, 30, 1400);
  const sol = solve([p0, p1, p2, p3]);
  const bend = sol.segments[1];
  const original = compactBendParams(bend, OPT.offsetMm, OPT.maxPieceMm, 0);
  assert.equal(original.compact, false);

  const minRadius = 600;
  const params = compactBendParams(bend, OPT.offsetMm, OPT.maxPieceMm, minRadius);
  assert.equal(params.compact, true);
  close(params.radius, minRadius, 1e-6);
  assert.ok(params.lead > original.lead);
  assert.ok(params.lead > 60);
  assert.ok(2 * OPT.offsetMm + params.radius * params.theta * DEG <= OPT.maxPieceMm + 1e-6);

  const shop = expandRun(validRuns(sol)[0], { ...OPT, minRadius });
  const straights = shop.filter((s) => s.arc.straight);
  const elbow = shop.find(isBend);
  const straightLen = straights.reduce((n, s) => n + segmentLength(s), 0);
  assert.ok(straightLen > segmentLength(elbow));
  close(elbow.arc.radius, minRadius, 1e-6);
});

test('elbow-too-long remains only if even a compact elbow cannot fit (R-149)', () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 200, y: 0 };
  const p2 = at(p1, 15, 5000);
  const p3 = at(p2, 30, 200);
  const sol = solve([p0, p1, p2, p3]);
  const laid = layoutPieces(sol, { offsetMm: 60, maxPieceMm: 100 });
  const elbow = laid.pieces.find((p) => p.kind === 'elbow');
  assert.equal(elbow.ok, false);
  assert.equal(elbow.reason, 'elbow-too-long');
});

test('piece hover reports length and arc degrees (R-151)', () => {
  const elbow = describePiece(
    { id: 'elbow-1', kind: 'elbow', length: 626.4, theta: 30, ok: true },
    { ductWidth: 180, jacketWidth: 400 },
  );
  assert.equal(elbow.kind, 'Elbow');
  assert.equal(elbow.sweepLabel, '30°');
  const html = pieceTipHtml(elbow);
  assert.match(html, /Length 626 mm/);
  assert.match(html, /Arc 30°/);

  const straight = describePiece(
    { id: 'straight-0.00', kind: 'straight', length: 1050, ok: true },
    { ductWidth: 180, jacketWidth: 400 },
  );
  assert.match(pieceTipHtml(straight), /Length 1050 mm/);
  assert.match(pieceTipHtml(straight), /Arc 0°/);
});

test('pickPieceAt2d finds the nearest flange-to-flange piece (R-151)', () => {
  const sol = solve([{ x: 0, y: 0 }, { x: 800, y: 0 }]);
  const laid = layoutPieces(sol, OPT);
  assert.equal(laid.pieces.length, 1);
  const hit = pickPieceAt2d(laid.pieces, { x: 400, y: 0 }, poseAlong, 50);
  assert.equal(hit.id, laid.pieces[0].id);
  const miss = pickPieceAt2d(laid.pieces, { x: 400, y: 400 }, poseAlong, 50);
  assert.equal(miss, null);
});

test('pickPieceAt3d uses z as well as xy (R-151)', () => {
  const sol = solve([{ x: 0, y: 0 }, { x: 800, y: 0 }]);
  const laid = layoutPieces(sol, OPT);
  const hit = pickPieceAt3d(laid.pieces, { x: 400, y: 0, z: 0 }, poseAlong, 50);
  assert.equal(hit.id, laid.pieces[0].id);
  const miss = pickPieceAt3d(laid.pieces, { x: 400, y: 0, z: 400 }, poseAlong, 50);
  assert.equal(miss, null);
});

test('flangeOptionsFor and defaultAddReach follow the feature flag', () => {
  assert.equal(flangeOptionsFor({ features: {} }), null);
  const on = flangeOptionsFor({ features: { flanges: true } });
  assert.equal(on.offsetMm, 60);
  assert.equal(on.maxPieceMm, 1050);
  assert.deepEqual(on.splits, {});
  assert.equal(defaultAddReach({ features: { flanges: true }, maxPieceLengthMm: 1050 }), 1050);
  assert.equal(defaultAddReach({ features: {} }, 2200), 2200);
});

test('fabricationDigest names piece counts', () => {
  const sol = solve([{ x: 0, y: 0 }, { x: 2100, y: 0 }]);
  const text = fabricationDigest(layoutPieces(sol, OPT));
  assert.match(text, /2 pieces/);
  assert.match(text, /0 elbows/);
});

test('layoutRun on an empty run is a no-op', () => {
  const laid = layoutRun([], 60, 1050);
  assert.equal(laid.pieces.length, 0);
  assert.equal(laid.flanges.length, 0);
});

test('2D poseAlong on a straight lands at the requested distance', () => {
  const sol = solve([{ x: 10, y: 20 }, { x: 110, y: 20 }]);
  const pose = poseAlong(sol.segments[0], 40);
  close(pose.x, 50);
  close(pose.y, 20);
  close(pose.tangentDeg, 0);
});

test('a dropdown split further-cuts an already auto-spliced straight', () => {
  const sol = solve([{ x: 0, y: 0 }, { x: 2100, y: 0 }]);
  const first = layoutPieces(sol, OPT);
  assert.equal(first.pieces.length, 2);
  const key = first.pieces[0].gapKey;
  const laid = layoutPieces(sol, { ...OPT, splits: { [key]: 2 } });
  assert.equal(laid.pieces.length, 3);
  assert.ok(laid.pieces.every((p) => p.ok && p.kind === 'straight'));
  close(laid.pieces.reduce((n, p) => n + p.length, 0), 2100);
});
