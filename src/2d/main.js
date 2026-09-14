import { DEG, legalBearings, snapToLegal, solvePath } from './geometry.js';
import { setSweeps } from '../core/angles.js';
import { tangentAt, minRadiusFor } from '../core/solve.js';
import { renderCanvas, renderTable, renderSummary } from './render.js';
import { loadConfig, applyFeatureFlags } from '../core/config.js';
import { sendPath, takePath } from '../core/handoff.js';
import {
  getState, subscribe, update, restore, configure,
  addPoint, movePoint, removePoint, reorderPoint, clearPoints,
  toJSON, fromJSON,
} from '../core/store.js';

const $ = (id) => document.getElementById(id);

const svg = $('canvas');
const layers = {
  guides: $('layer-guides'),
  jacket: $('layer-jacket'),
  duct: $('layer-duct'),
  path: $('layer-path'),
  markers: $('layer-markers'),
  points: $('layer-points'),
};
const ptBody = $('ptBody');
const summaryEl = $('summary');

let solution = { segments: [], tangentOut: 0, errorCount: 0 };
let drag = null;

// ---------------------------------------------------------------- coordinates

const scratch = svg.createSVGPoint();

function toSvgCoords(evt) {
  scratch.x = evt.clientX;
  scratch.y = evt.clientY;
  return scratch.matrixTransform(svg.getScreenCTM().inverse());
}

// ---------------------------------------------------------------- render loop

/** Which point the guide rays fan out from. */
function anchorIndex(state) {
  if (drag) return drag.index - 1;
  if (state.selectedId) return state.points.findIndex((p) => p.id === state.selectedId);
  return state.points.length - 1;
}

function syncControls(state) {
  $('initialHeading').value = state.initialHeading;
  $('tolerance').value = state.toleranceDeg;
  $('ductWidth').value = state.ductWidth;
  $('jacketWidth').value = state.jacketWidth;
  $('minRadiusRatio').value = state.minRadiusRatio;
  $('showDuct').checked = state.showDuct;
  $('showJacket').checked = state.showJacket;
  $('showGuides').checked = state.showGuides;
  $('snapEnabled').checked = state.snapEnabled;
  $('v-heading').textContent = `${state.initialHeading}°`;
  $('v-tol').textContent = `±${state.toleranceDeg}°`;
  $('v-duct').textContent = String(state.ductWidth);
  $('v-jacket').textContent = String(state.jacketWidth);
  $('v-ratio').textContent = `${state.minRadiusRatio.toFixed(1)} × D`;

  const minR = minRadiusFor(state);
  $('ratioNote').textContent = state.minRadiusRatio < 1
    ? `Minimum centerline radius ${minR.toFixed(0)}. Below 0.5 × D the inner edge folds back on itself.`
    : `Minimum centerline radius ${minR.toFixed(0)}, measured against the widest band.`;
  $('ratioNote').classList.toggle('ctl-note--warn', state.minRadiusRatio < 1);

  // The jacket is drawn under the duct, so a smaller diameter silently vanishes (R-39).
  const swallowed = state.jacketWidth <= state.ductWidth;
  $('jacketNote').textContent = swallowed
    ? 'Jacket is not wider than the duct, so it is hidden behind it.'
    : `Outer diameter. ${((state.jacketWidth - state.ductWidth) / 2).toFixed(1)} of cover around the duct.`;
  $('jacketNote').classList.toggle('ctl-note--warn', swallowed);
}

function render() {
  const state = getState();
  solution = solvePath(state.points, state.initialHeading, state.toleranceDeg, minRadiusFor(state));
  renderCanvas(layers, state, solution, anchorIndex(state));
  renderTable(ptBody, state, solution);
  renderSummary(summaryEl, solution, state);
  syncControls(state);
}

// ---------------------------------------------------------------- viewport

const BASE = { w: 1200, h: 800 };
const MIN_W = 150;
const MAX_W = 24000;

// Viewport is session state, not document state: panning must not touch the store or re-render.
let view = { x: 0, y: 0, ...BASE };
let pan = null;

function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
}

/** SVG units per screen pixel, accounting for xMidYMid meet letterboxing. */
function svgPerPixel(v) {
  const rect = svg.getBoundingClientRect();
  return 1 / Math.min(rect.width / v.w, rect.height / v.h);
}

function fitView() {
  const { points } = getState();
  if (points.length === 0) {
    view = { x: 0, y: 0, ...BASE };
    return applyView();
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const pad = Math.max(90, Math.max(maxX - minX, maxY - minY) * 0.12);
  const aspect = BASE.w / BASE.h;

  let w = Math.max(maxX - minX + pad * 2, MIN_W);
  let h = Math.max(maxY - minY + pad * 2, MIN_W / aspect);
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;

  view = { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };
  applyView();
}

const inView = (p) => p.x >= view.x && p.x <= view.x + view.w && p.y >= view.y && p.y <= view.y + view.h;

applyView();

// ---------------------------------------------------------------- canvas input

svg.addEventListener('pointerdown', (e) => {
  const state = getState();
  const hit = e.target.closest('.pt');

  if (hit) {
    const id = hit.dataset.id;
    drag = { id, index: state.points.findIndex((p) => p.id === id), moved: false };
    update({ selectedId: id });
    // Capture on the SVG, not the dot: layers are re-rendered on every move.
    svg.setPointerCapture(e.pointerId);
    return;
  }

  pan = { clientX: e.clientX, clientY: e.clientY, view: { ...view } };
  svg.setPointerCapture(e.pointerId);
  svg.classList.add('panning');
});

svg.addEventListener('pointermove', (e) => {
  if (pan) {
    const k = svgPerPixel(pan.view);
    view.x = pan.view.x - (e.clientX - pan.clientX) * k;
    view.y = pan.view.y - (e.clientY - pan.clientY) * k;
    applyView();
    return;
  }

  if (!drag) return;
  drag.moved = true;

  const state = getState();
  const { x, y } = toSvgCoords(e);

  let target = { x, y };
  if (state.features.snapping && state.snapEnabled && drag.index > 0) {
    target = snapToLegal(
      state.points[drag.index - 1],
      target,
      tangentAt(solution, drag.index - 1, state.initialHeading),
      minRadiusFor(state),
    );
  }
  movePoint(drag.id, { x: round(target.x), y: round(target.y) });
});

/** Zoom about the cursor, so the point under it stays put. */
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = toSvgCoords(e);
  const target = view.w * Math.exp(e.deltaY * 0.0015);
  const k = Math.min(Math.max(target, MIN_W), MAX_W) / view.w;

  view.x = p.x - (p.x - view.x) * k;
  view.y = p.y - (p.y - view.y) * k;
  view.w *= k;
  view.h *= k;
  applyView();
}, { passive: false });

function endDrag(e) {
  if (!pan && !drag) return;
  if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);

  if (pan) {
    pan = null;
    svg.classList.remove('panning');
    return;
  }

  drag = null;
  render();
}

svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

const round = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- table input

ptBody.addEventListener('change', (e) => {
  const input = e.target.closest('.num');
  if (!input) return;

  const value = Number.parseFloat(input.value);
  if (!Number.isFinite(value)) return render();

  const p = getState().points.find((q) => q.id === input.dataset.id);
  if (!p) return;
  movePoint(p.id, { [input.dataset.field]: value });
});

ptBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const { act, id } = btn.dataset;
    if (act === 'del') removePoint(id);
    else if (act === 'up') reorderPoint(id, -1);
    else if (act === 'down') reorderPoint(id, 1);
    else if (act === 'fix') autoFix(id);
    return;
  }
  const row = e.target.closest('tr[data-id]');
  if (row) update({ selectedId: row.dataset.id });
});

/** R-22: slide the point onto the nearest legal ray, out to the minimum bend distance if needed. */
function autoFix(id) {
  const state = getState();
  const i = state.points.findIndex((p) => p.id === id);
  if (i < 1) return;

  const fixed = snapToLegal(
    state.points[i - 1],
    state.points[i],
    tangentAt(solution, i - 1, state.initialHeading),
    minRadiusFor(state),
  );
  movePoint(id, { x: round(fixed.x), y: round(fixed.y) });
}

// ---------------------------------------------------------------- controls

$('initialHeading').addEventListener('input', (e) => update({ initialHeading: Number(e.target.value) }));
$('tolerance').addEventListener('input', (e) => update({ toleranceDeg: Number(e.target.value) }));
$('ductWidth').addEventListener('input', (e) => update({ ductWidth: Number(e.target.value) }));
$('jacketWidth').addEventListener('input', (e) => update({ jacketWidth: Number(e.target.value) }));
$('minRadiusRatio').addEventListener('input', (e) => update({ minRadiusRatio: Number(e.target.value) }));
$('showDuct').addEventListener('change', (e) => update({ showDuct: e.target.checked }));
$('showJacket').addEventListener('change', (e) => update({ showJacket: e.target.checked }));
$('showGuides').addEventListener('change', (e) => update({ showGuides: e.target.checked }));
$('snapEnabled').addEventListener('change', (e) => update({ snapEnabled: e.target.checked }));

/** Places the new point on a legal ray so it starts out valid. */
$('btnAdd').addEventListener('click', () => {
  const state = getState();
  if (state.points.length === 0) {
    addPoint(200, 400);
    return fitView();
  }

  const last = state.points[state.points.length - 1];
  const tau = tangentAt(solution, state.points.length - 1, state.initialHeading);
  // Extend straight ahead (the 0 sweep), so a plain "add" never introduces a turn.
  const { bearing } = legalBearings(tau).find((c) => c.theta === 0);
  const added = { x: round(last.x + 220 * Math.cos(bearing * DEG)), y: round(last.y + 220 * Math.sin(bearing * DEG)) };

  addPoint(added.x, added.y);
  if (!inView(added)) fitView();
});

$('btnFit').addEventListener('click', fitView);

$('btnClear').addEventListener('click', () => clearPoints());

$('btnExport').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([toJSON()], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'arc-path.json' });
  a.click();
  URL.revokeObjectURL(url);
});

$('btnImport').addEventListener('click', () => $('fileInput').click());

$('btnCross').addEventListener('click', () => {
  sendPath(toJSON());
  window.location.href = 'index3d.html';
});

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    fromJSON(await file.text());
    fitView();
  } catch (err) {
    window.alert(`Could not import: ${err.message}`);
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- boot

const config = await loadConfig();
setSweeps(config.sweeps);
configure(config, '2d');
applyFeatureFlags(config.features);

subscribe(render);

const handed = config.features.crossLink ? takePath() : null;
if (handed) receiveHandoff(handed);
else restore();

render();
fitView();

/**
 * A 3D path only survives the trip if it is planar. Its xy projection is a different path
 * geometrically, so say so rather than silently showing angles the user did not author.
 */
function receiveHandoff(json) {
  try {
    fromJSON(json);
  } catch {
    return restore();
  }

  const lifted = getState().points.filter((p) => p.z !== 0).length;
  if (lifted === 0) return;

  const notice = $('notice');
  notice.hidden = false;
  notice.textContent = `Flattened from 3D: ${lifted} point${lifted === 1 ? '' : 's'} had a non-zero z, which this view drops. The angles below are for the xy projection, not the original path.`;
}
