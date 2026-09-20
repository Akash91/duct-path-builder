import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POINT_DOT_R, POINT_SPHERE_R, POINT_MARKER_R, POINT_HIT_R,
  ORIGIN, ORIGIN_AXIS_MM, MIN_FOCUS_STANDOFF,
  originSpec, markersSmallerThanDuct, fitPoints,
  centerViewOnPoint, focusCameraOnPoint,
} from '../src/core/view.js';
import { pieceLabel, pieceDetailModel } from '../src/core/piecePanel.js';
import { layoutPieces, suggestedSplitCuts, pieceWidths, describePiece, pieceTipHtml } from '../src/core/flange.js';
import { solvePath } from '../src/2d/geometry.js';
import {
  configure, getState, selectPiece, setPieceOverride, splitPiece, clearPoints, resetToDefaults,
} from '../src/core/store.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('point glyphs stay small against the duct and jacket (R-155)', () => {
  assert.equal(markersSmallerThanDuct(180, 400), true);
  assert.ok(POINT_DOT_R * 2 < 180 * 0.2);
  assert.ok(POINT_SPHERE_R * 2 < 180 * 0.2);
  assert.ok(POINT_MARKER_R * 2 < 180 * 0.2);
  assert.ok(POINT_HIT_R < 400 / 2, 'hit target is not the size of the jacket');
});

test('the origin reference is at (0,0,0) with XYZ axes (R-137)', () => {
  const spec = originSpec();
  assert.deepEqual(spec.position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(spec.axes, ['x', 'y', 'z']);
  assert.equal(spec.label, '0,0,0');
  assert.equal(spec.axisMm, ORIGIN_AXIS_MM);
  assert.deepEqual(ORIGIN, { x: 0, y: 0, z: 0 });
});

test('Fit always includes the origin even when every point is far away (R-137)', () => {
  const box = fitPoints([{ x: 4000, y: 2000, z: 800 }]);
  assert.equal(box.includesOrigin, true);
  assert.equal(box.min.x, 0);
  assert.equal(box.min.y, 0);
  assert.equal(box.min.z, 0);
  assert.equal(box.max.x, 4000);
});

test('selecting a table point pans 2D without changing zoom (R-154)', () => {
  const view = { x: 10, y: 20, w: 800, h: 600 };
  const next = centerViewOnPoint(view, { x: 1600, y: 400 });
  close(next.w, 800);
  close(next.h, 600);
  close(next.x, 1600 - 400);
  close(next.y, 400 - 300);
});

test('selecting a table point retargets 3D and never closer than the standoff (R-154)', () => {
  const camera = { x: 100, y: -100, z: 80 };
  const target = { x: 0, y: 0, z: 0 };
  const point = { x: 3295, y: 829, z: 0 };
  const next = focusCameraOnPoint(camera, target, point, MIN_FOCUS_STANDOFF);
  assert.deepEqual(next.target, { x: 3295, y: 829, z: 0 });
  assert.ok(next.standoff >= MIN_FOCUS_STANDOFF - 1e-9);
  const dist = Math.hypot(
    next.camera.x - next.target.x,
    next.camera.y - next.target.y,
    next.camera.z - next.target.z,
  );
  close(dist, next.standoff, 1e-6);
});

test('the piece dropdown lists derived pieces and can split a straight (R-152)', () => {
  const sol = solvePath([{ x: 0, y: 0 }, { x: 2100, y: 0 }], 0, 0.5, 0);
  const pieces = layoutPieces(sol, { offsetMm: 60, maxPieceMm: 1050 }).pieces;
  assert.ok(pieces.length >= 2);
  assert.match(pieceLabel(pieces[0], 0), /^1\. Straight · \d+ mm$/);

  const model = pieceDetailModel(pieces[0], { maxPieceLengthMm: 1050, ductWidth: 180, jacketWidth: 400, features: { jacket: true } });
  assert.equal(model.empty, false);
  assert.equal(model.kind, 'Straight');
  assert.equal(model.canSplit, true);
  assert.equal(model.splitCuts, suggestedSplitCuts(pieces[0].length, 1050));
  assert.ok(model.gapKey);

  const info = describePiece(pieces[0], { ductWidth: 180, jacketWidth: 400 });
  assert.equal(info.kind, 'Straight');
  assert.equal(info.ductWidth, 180);
});

test('an elbow that is too long cannot be split from the dropdown (R-149, R-152)', () => {
  const piece = {
    id: 'elbow-1',
    kind: 'elbow',
    length: 1600,
    ok: false,
    reason: 'elbow-too-long',
    gapKey: null,
  };
  const model = pieceDetailModel(piece, { maxPieceLengthMm: 1050, ductWidth: 180, jacketWidth: 400 });
  assert.equal(model.canSplit, false);
  assert.match(model.warn, /cannot be split/i);
  assert.match(model.warn, /compact/i);
});

test('hover copy names length and arc degrees (R-151)', () => {
  const info = describePiece(
    { id: 'elbow-1', kind: 'elbow', length: 626, theta: 30, ok: true },
    { ductWidth: 180, jacketWidth: 400 },
  );
  assert.match(pieceTipHtml(info), /Length 626 mm/);
  assert.match(pieceTipHtml(info), /Arc 30°/);
});

test('per-piece diameter override falls back to the globals', () => {
  const piece = { id: 'straight-0.00', kind: 'straight', length: 800 };
  assert.deepEqual(
    pieceWidths(piece, { ductWidth: 180, jacketWidth: 400 }),
    { ductWidth: 180, jacketWidth: 400 },
  );
  assert.equal(
    pieceWidths(piece, { ductWidth: 180, jacketWidth: 400, pieceOverrides: { 'straight-0.00': { ductWidth: 220 } } }).ductWidth,
    220,
  );
});

test('store select / split / override keep piece UI state (R-152)', () => {
  configure({ ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, autosave: false, flanges: true } }, 'invariants');
  resetToDefaults();
  assert.equal(getState().selectedPieceId, null);
  assert.deepEqual(getState().pieceSplits, {});

  selectPiece('straight-0.00');
  assert.equal(getState().selectedPieceId, 'straight-0.00');

  setPieceOverride('straight-0.00', { ductWidth: 220 });
  assert.equal(getState().pieceOverrides['straight-0.00'].ductWidth, 220);

  splitPiece('0.00:1050.00', 2);
  assert.equal(getState().pieceSplits['0.00:1050.00'], 2);
  assert.equal(getState().selectedPieceId, null);

  clearPoints();
  assert.deepEqual(getState().pieceSplits, {});
  assert.deepEqual(getState().pieceOverrides, {});
  assert.equal(getState().points.length, 0);
});
