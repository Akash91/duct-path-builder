// Flange-to-flange shop pieces: compact elbows, spliced straights, and the stubs a fitting
// needs on either side of its arc.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  elbowLayout, spliceStraight, layoutRun, stretchesFor, pieceLabel, VISUAL_KINDS,
} from '../src/core/pieces.js';
import { DEG } from '../src/core/angles.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const OPTS = { flangeOffset: 60, maxPieceLength: 1050, minLead: 100 };
const seg = (index, shop) => ({ index, shop, ok: true });

test('an elbow shrinks to the bend limit while the leftover still carries a stub', () => {
  // The demo 30 degree span: a 967 mm table arc filleted down to the 600 mm floor.
  const laid = elbowLayout({ tableRadius: 967.3, theta: 30, minRadius: 600, ...OPTS });

  close(laid.radius, 600);
  close(laid.arcLength, 600 * 30 * DEG, 1e-4);
  close(laid.leftover, (967.3 - 600) * Math.tan(15 * DEG), 1e-6);
  assert.ok(laid.leftover >= 60, 'leftover must still hold a 60 mm stub on each side');
  close(laid.pieceLength, 120 + 600 * 30 * DEG, 1e-4);
  assert.equal(laid.reason, null);
});

test('when the leftover cannot hold a stub, the table radius is kept', () => {
  const laid = elbowLayout({ tableRadius: 640, theta: 30, minRadius: 600, ...OPTS });
  close(laid.radius, 640);
  close(laid.leftover, 0);
});

test('the leftover of a fillet is equal on both sides', () => {
  const laid = elbowLayout({ tableRadius: 2000, theta: 90, minRadius: 600, ...OPTS });
  const stretches = stretchesFor({ kind: 'elbow', ...laid });
  close(stretches[0].length, stretches[2].length);
});

test('an elbow that cannot fit one piece is reported, never split along the bend', () => {
  // A 90 degree bend at a 900 mm floor is 1414 mm of arc before any flange is added.
  const laid = elbowLayout({ tableRadius: 4000, theta: 90, minRadius: 900, ...OPTS });
  assert.equal(laid.reason, 'elbow-too-long');
  assert.ok(laid.pieceLength > OPTS.maxPieceLength);

  const { pieces } = layoutRun([seg(0, { kind: 'elbow', ...laid })], OPTS);
  const elbows = pieces.filter((p) => p.kind === 'elbow');
  assert.equal(elbows.length, 1, 'the bend stays one piece even when it overflows');
});

test('a long straight splices into even pieces', () => {
  assert.deepEqual(spliceStraight(900, 1050), [900]);
  assert.deepEqual(spliceStraight(2100, 1050), [1050, 1050]);
  assert.deepEqual(spliceStraight(1100, 1050).map((v) => Math.round(v)), [550, 550]);
  assert.deepEqual(spliceStraight(0, 1050), []);
});

test('consecutive straights merge across a table point before splicing', () => {
  const run = [seg(0, { kind: 'straight', length: 600 }), seg(1, { kind: 'straight', length: 600 })];
  const { pieces } = layoutRun(run, OPTS);

  assert.deepEqual(pieces.map((p) => p.kind), ['straight', 'straight']);
  close(pieces[0].length, 600); // 1200 split evenly, not a 1050 and a 150 stub
  close(pieces[1].length, 600);
});

test('leftover after an elbow becomes its own straight, not part of the fitting', () => {
  const elbow = elbowLayout({ tableRadius: 967.3, theta: 30, minRadius: 600, ...OPTS });
  const run = [
    seg(0, { kind: 'straight', length: 1500 }),
    seg(1, { kind: 'elbow', ...elbow }),
    seg(2, { kind: 'straight', length: 1400 }),
  ];
  const { pieces, issues } = layoutRun(run, OPTS);

  assert.deepEqual(issues, []);
  const kinds = pieces.map((p) => p.kind);
  assert.equal(kinds.filter((k) => k === 'elbow').length, 1);
  assert.ok(kinds.indexOf('elbow') > 0 && kinds.indexOf('elbow') < kinds.length - 1);

  const fitting = pieces.find((p) => p.kind === 'elbow');
  close(fitting.length, elbow.pieceLength, 1e-4);
  for (const p of pieces) assert.ok(p.length <= OPTS.maxPieceLength + 1e-6);

  // Stations run end to end with no gap, so a flange sits at every boundary.
  for (let i = 1; i < pieces.length; i++) close(pieces[i].start, pieces[i - 1].end);
});

test('two elbows closer than their stubs allow is a short stub', () => {
  const elbow = elbowLayout({ tableRadius: 610, theta: 30, minRadius: 600, ...OPTS });
  const run = [
    seg(0, { kind: 'elbow', ...elbow }),
    seg(1, { kind: 'straight', length: 40 }),
    seg(2, { kind: 'elbow', ...elbow }),
  ];
  const { issues } = layoutRun(run, OPTS);
  assert.ok(issues.some((i) => i.reason === 'short-stub'));
});

test('an angled straight is one piece with no elbow flanges on its kick', () => {
  const run = [seg(0, { kind: 'angled', lead: 100, kickDeg: 3, outLength: 500 })];
  const { pieces, issues } = layoutRun(run, OPTS);

  assert.deepEqual(issues, []);
  assert.deepEqual(pieces.map((p) => p.kind), ['angled']);
  close(pieces[0].length, 600);
  close(pieces[0].arcDeg, 3);
});

test('a long angled straight keeps the kick in one piece and splices the rest', () => {
  const run = [seg(0, { kind: 'angled', lead: 100, kickDeg: 3, outLength: 1500 })];
  const { pieces } = layoutRun(run, OPTS);

  assert.equal(pieces[0].kind, 'angled');
  close(pieces[0].length, OPTS.maxPieceLength);
  for (const p of pieces.slice(1)) assert.equal(p.kind, 'straight');
  close(pieces.reduce((n, p) => n + p.length, 0), 1600);
});

test('visual kinds are straight, elbow and kick', () => {
  assert.deepEqual(VISUAL_KINDS, ['straight', 'elbow', 'kick']);
  assert.deepEqual(
    stretchesFor({ kind: 'angled', lead: 100, kickDeg: 2, outLength: 900 }).map((s) => s.kind),
    ['straight', 'kick', 'straight'],
  );
});

test('every piece label carries millimetres', () => {
  const labels = [
    pieceLabel({ kind: 'straight', length: 1050, arcDeg: 0, radius: Infinity }),
    pieceLabel({ kind: 'elbow', length: 434, arcDeg: 30, radius: 600 }),
    pieceLabel({ kind: 'angled', length: 600, arcDeg: 3, radius: Infinity }),
  ];
  for (const label of labels) assert.match(label, /mm/);
});
