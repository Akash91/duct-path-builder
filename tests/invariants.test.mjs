// Invariants that are easy to break by accident and expensive to notice: the layering rule,
// the millimetre vocabulary, the origin datum, the row-focus standoff and the piece dropdown.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FOCUS_STANDOFF, focusEye, boundsWithOrigin } from '../src/core/view.js';
import { solvePath } from '../src/2d/geometry.js';
import { minRadiusFor } from '../src/core/solve.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('core never reaches into a view', () => {
  for (const file of readdirSync(join(root, 'src/core'))) {
    const source = read(`src/core/${file}`);
    assert.doesNotMatch(source, /from '\.\.\/(2d|3d)\//, `${file} imports a view`);
    assert.doesNotMatch(source, /\bthree\b/, `${file} reaches for Three.js`);
  }
});

test('geometry runs without a renderer or a DOM', () => {
  // Importing 2D geometry above already proved this; solving is the point of the module.
  const { segments } = solvePath([{ x: 0, y: 0 }, { x: 1600, y: 0 }], 0, { toleranceDeg: 2 });
  assert.equal(segments.length, 1);
});

test('both pages label their coordinates in millimetres', () => {
  for (const page of ['index.html', 'index3d.html']) {
    const html = read(page);
    assert.match(html, /x \(mm\)/, `${page} x column`);
    assert.match(html, /y \(mm\)/, `${page} y column`);
    assert.match(html, /Max piece length/, `${page} piece length control`);
  }
  assert.match(read('index3d.html'), /z \(mm\)/);
});

test('the shipped defaults are millimetres, not centimetres', () => {
  const { defaults } = DEFAULT_CONFIG;
  assert.equal(defaults.ductWidth, 180);
  assert.equal(defaults.jacketWidth, 400);
  assert.equal(defaults.maxPieceLength, 1050);
  assert.equal(defaults.elbowFlangeOffset, 60);
  assert.equal(defaults.angledMinLead, 100);

  // config.json carries a real duct rather than the built-in fallback, so check the scale
  // rather than the value: a centimetre-era file would be an order of magnitude smaller.
  const shipped = JSON.parse(read('config.json'));
  assert.ok(shipped.defaults.ductWidth >= 100, 'duct is millimetres');
  assert.ok(shipped.defaults.maxPieceLength >= 500, 'piece length is millimetres');
  assert.equal(shipped.features.threeD, true);
  assert.equal(shipped.features.drainSlope, true);
  assert.equal(shipped.features.flanges, true);
});

test('both pages carry the duct-pieces dropdown', () => {
  for (const page of ['index.html', 'index3d.html']) {
    const html = read(page);
    assert.match(html, /id="pieceSelect"/, `${page} piece dropdown`);
    assert.match(html, /Duct pieces/, `${page} pieces accordion`);
    assert.match(html, /<details class="accordion" id="settings">/, `${page} collapsible settings`);
  }
});

test('duct, jacket and flanges are toggleable layers, and start hidden', () => {
  for (const page of ['index.html', 'index3d.html']) {
    const html = read(page);
    for (const id of ['showDuct', 'showJacket', 'showFlanges']) {
      assert.match(html, new RegExp(`id="${id}" type="checkbox" />`), `${page} ${id} must start unchecked`);
    }
    assert.match(html, /data-feature="flanges"><input id="showFlanges"/, `${page} flange toggle is flag-gated`);
  }

  const store = read('src/core/store.js');
  for (const key of ['showDuct', 'showJacket', 'showFlanges']) {
    assert.match(store, new RegExp(`${key}: false`), `${key} must default off`);
  }

  // Hidden is not disabled: a jacket that is merely unticked still sets the bend limit.
  const bendLimit = minRadiusFor({
    features: { minBendRadius: true, duct: true, jacket: true },
    ductWidth: 180, jacketWidth: 400, minRadiusRatio: 1.5,
    showDuct: false, showJacket: false,
  });
  assert.equal(bendLimit, 600);
});

test('the 3D scene always draws an origin triad and offers a reset', () => {
  const render = read('src/3d/render.js');
  assert.match(render, /originTriad/);
  assert.match(render, /0,0,0/);
  assert.match(render, /AXIS_COLOR/);
  assert.match(render, /export function resetView/);
  assert.match(read('index3d.html'), /id="btnReset"/);
});

test('the 3D duct is walked by arc length, never fitted with a spline', () => {
  const render = read('src/3d/render.js');
  assert.doesNotMatch(render, /CatmullRom|SplineCurve|QuadraticBezier|CubicBezier/);
  assert.match(render, /class ShopCurve extends THREE\.Curve/);
});

test('row focus keeps the approach and never closes past the standoff', () => {
  assert.equal(FOCUS_STANDOFF, 9000);

  const target = { x: 3000, y: 1000, z: 200 };
  const near = focusEye({ x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, target);
  assert.ok(Math.hypot(near.x - target.x, near.y - target.y, near.z - target.z) >= FOCUS_STANDOFF - 1e-6);

  // A camera already further out is not pulled in.
  const far = focusEye({ x: 40000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, target);
  assert.ok(Math.hypot(far.x - target.x, far.y - target.y, far.z - target.z) > 39000);
});

test('fit frames the origin even when the path is nowhere near it', () => {
  const { min, max } = boundsWithOrigin([{ x: 9000, y: 9000, z: 9000 }]);
  assert.deepEqual(min, { x: 0, y: 0, z: 0 });
  assert.deepEqual(max, { x: 9000, y: 9000, z: 9000 });
});

test('2D leaves z alone and the 3D handoff warns when it cannot', () => {
  const main2d = read('src/2d/main.js');
  assert.doesNotMatch(main2d, /movePoint\([^)]*\bz:/);
  assert.match(main2d, /Flattened from 3D/);
  assert.match(main2d, /non-zero z/);
});

test('autosave is namespaced per app and on the drawing-demo key', () => {
  const store = read('src/core/store.js');
  assert.match(store, /curve-path-builder\/\$\{namespace\}\/v3/);
});

test('a coordinate field survives being clicked into', () => {
  // Selecting a row re-renders, and the table is rebuilt wholesale. If a click inside an input
  // reaches that path, the input the user just focused is replaced mid-click and the caret is
  // thrown away, leaving the spinner arrows as the only way to change a number.
  for (const page of ['src/2d/main.js', 'src/3d/main.js']) {
    const source = read(page);
    const guard = source.indexOf("e.target.closest('input')) return");
    const select = source.indexOf('selectedId: row.dataset.id');
    assert.ok(guard !== -1, `${page} must ignore clicks that land in a field`);
    assert.ok(guard < select, `${page} must bail out before selecting the row`);
  }
});

test('a table rebuild carries the edit in progress across it', () => {
  for (const view of ['src/2d/render.js', 'src/3d/panel.js']) {
    const source = read(view);
    assert.match(source, /captureEdit\(tbody\)/, `${view} must remember the edit`);
    assert.match(source, /restoreEdit\(tbody, editing\)/, `${view} must put it back`);
    // Fractional millimetres have to be typeable; step="1" rejects them.
    assert.doesNotMatch(source, /type="number" step="1"/, `${view} must accept fractional mm`);
  }
});
