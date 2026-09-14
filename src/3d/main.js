import { legalCones, snapToLegal, solvePath } from './geometry.js';
import { initScene, renderScene, fitCamera } from './render.js';
import { renderTable, renderSummary } from './panel.js';
import * as V from './vec3.js';

import { setSweeps } from '../core/angles.js';
import { minChordFor } from '../core/arcMath.js';
import { tangentAt, minRadiusFor } from '../core/solve.js';
import { loadConfig, applyFeatureFlags } from '../core/config.js';
import { sendPath, takePath } from '../core/handoff.js';
import {
  getState, subscribe, update, restore, configure,
  addPoint, movePoint, removePoint, reorderPoint, clearPoints,
  toJSON, fromJSON,
} from '../core/store.js';

const $ = (id) => document.getElementById(id);

// Assigned during boot: creating a WebGL context before the flag check would waste it.
let ctx = null;
const ptBody = $('ptBody');
const summaryEl = $('summary');

let solution = { segments: [], tangentOut: null, errorCount: 0, tightCount: 0 };

/** State plus the derived unit tangent, which the renderer and solver both need. */
function viewState() {
  const state = getState();
  return { ...state, initialTangent: V.fromAngles(state.initialHeading, state.initialElevation) };
}

function anchorIndex(state) {
  if (state.selectedId) return state.points.findIndex((p) => p.id === state.selectedId);
  return state.points.length - 1;
}

function syncControls(state) {
  $('initialHeading').value = state.initialHeading;
  $('initialElevation').value = state.initialElevation;
  $('tolerance').value = state.toleranceDeg;
  $('ductWidth').value = state.ductWidth;
  $('jacketWidth').value = state.jacketWidth;
  $('minRadiusRatio').value = state.minRadiusRatio;
  $('showDuct').checked = state.showDuct;
  $('showJacket').checked = state.showJacket;
  $('showGuides').checked = state.showGuides;
  $('snapEnabled').checked = state.snapEnabled;

  $('v-heading').textContent = `${state.initialHeading}°`;
  $('v-elevation').textContent = `${state.initialElevation}°`;
  $('v-tol').textContent = `±${state.toleranceDeg}°`;
  $('v-duct').textContent = String(state.ductWidth);
  $('v-jacket').textContent = String(state.jacketWidth);
  $('v-ratio').textContent = `${state.minRadiusRatio.toFixed(1)} × D`;

  const minR = minRadiusFor(state);
  $('ratioNote').textContent = state.minRadiusRatio < 1
    ? `Minimum centerline radius ${minR.toFixed(0)}. Below 0.5 × D the inner surface folds through itself.`
    : `Minimum centerline radius ${minR.toFixed(0)}, measured against the widest band.`;
  $('ratioNote').classList.toggle('ctl-note--warn', state.minRadiusRatio < 1);

  const swallowed = state.jacketWidth <= state.ductWidth;
  $('jacketNote').textContent = swallowed
    ? 'Jacket is not wider than the duct, so it is hidden inside it.'
    : `Outer diameter. ${((state.jacketWidth - state.ductWidth) / 2).toFixed(1)} of cover around the duct.`;
  $('jacketNote').classList.toggle('ctl-note--warn', swallowed);

  // Keeps the collapsed accordion honest about what it is hiding.
  $('accDigest').textContent = [
    state.features.duct ? `duct ${state.ductWidth}` : null,
    state.features.jacket ? `jacket ${state.jacketWidth}` : null,
    `±${state.toleranceDeg}°`,
  ].filter(Boolean).join(' · ');
}

function render() {
  const state = viewState();
  solution = solvePath(state.points, state.initialTangent, state.toleranceDeg, minRadiusFor(state));

  renderScene(ctx, state, solution, anchorIndex(state));
  renderTable(ptBody, state, solution);
  renderSummary(summaryEl, solution, state);
  syncControls(state);
}

const round = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- table input

ptBody.addEventListener('change', (e) => {
  const input = e.target.closest('.num');
  if (!input) return;

  const value = Number.parseFloat(input.value);
  if (!Number.isFinite(value)) return render();

  const p = getState().points.find((q) => q.id === input.dataset.id);
  if (!p) return;
  movePoint(p.id, { ...p, [input.dataset.field]: value });
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

function autoFix(id) {
  const state = viewState();
  const i = state.points.findIndex((p) => p.id === id);
  if (i < 1) return;

  const fixed = snapToLegal(
    state.points[i - 1],
    state.points[i],
    tangentAt(solution, i - 1, state.initialTangent),
    minRadiusFor(state),
  );
  movePoint(id, { x: round(fixed.x), y: round(fixed.y), z: round(fixed.z) });
}

// ---------------------------------------------------------------- controls

$('initialHeading').addEventListener('input', (e) => update({ initialHeading: Number(e.target.value) }));
$('initialElevation').addEventListener('input', (e) => update({ initialElevation: Number(e.target.value) }));
$('tolerance').addEventListener('input', (e) => update({ toleranceDeg: Number(e.target.value) }));
$('ductWidth').addEventListener('input', (e) => update({ ductWidth: Number(e.target.value) }));
$('jacketWidth').addEventListener('input', (e) => update({ jacketWidth: Number(e.target.value) }));
$('minRadiusRatio').addEventListener('input', (e) => update({ minRadiusRatio: Number(e.target.value) }));
$('showDuct').addEventListener('change', (e) => update({ showDuct: e.target.checked }));
$('showJacket').addEventListener('change', (e) => update({ showJacket: e.target.checked }));
$('showGuides').addEventListener('change', (e) => update({ showGuides: e.target.checked }));
$('snapEnabled').addEventListener('change', (e) => update({ snapEnabled: e.target.checked }));

/** New points land on a cone, so an added point starts out valid. */
$('btnAdd').addEventListener('click', () => {
  const state = viewState();
  if (state.points.length === 0) {
    addPoint(0, 0, 0);
    return fitCamera(ctx, getState().points);
  }

  const last = state.points[state.points.length - 1];
  const tangent = tangentAt(solution, state.points.length - 1, state.initialTangent);
  const minRadius = minRadiusFor(state);

  // Straight ahead by default: the 0 cone has no dead zone and introduces no turn.
  const reach = Math.max(260, minChordFor(legalCones().at(-1).theta, minRadius));
  const target = V.add(last, V.scale(tangent, reach));

  addPoint(round(target.x), round(target.y), round(target.z));
  fitCamera(ctx, getState().points);
});

$('btnFit').addEventListener('click', () => fitCamera(ctx, getState().points));
$('btnClear').addEventListener('click', () => clearPoints());

$('btnExport').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([toJSON()], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'arc-path-3d.json' });
  a.click();
  URL.revokeObjectURL(url);
});

$('btnImport').addEventListener('click', () => $('fileInput').click());

$('btnCross').addEventListener('click', () => {
  sendPath(toJSON());
  window.location.href = 'index.html';
});

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    fromJSON(await file.text());
    fitCamera(ctx, getState().points);
  } catch (err) {
    window.alert(`Could not import: ${err.message}`);
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- boot

const config = await loadConfig();

if (config.features.threeD) boot();
else showDisabled();

function boot() {
  setSweeps(config.sweeps);
  configure(config, '3d');
  applyFeatureFlags(config.features);

  ctx = initScene($('viewport'));
  subscribe(render);

  // A valid 2D path is always a valid 3D path: its rays are these cones cut by the z = 0 plane.
  const handed = config.features.crossLink ? takePath() : null;
  if (handed) {
    try { fromJSON(handed); } catch { restore(); }
  } else {
    restore();
  }

  render();
  fitCamera(ctx, getState().points);
}

/**
 * Client-side gating only: the file is still served, so this is a product switch, not a
 * security control. It exists so the 3D view stays off until deliberately enabled.
 */
function showDisabled() {
  document.body.innerHTML = `
    <div class="disabled-card">
      <h1>3D view is turned off</h1>
      <p>Enable <code>features.threeD</code> in <code>config.json</code> and reload.</p>
      <p><a href="index.html">Back to the 2D builder</a></p>
    </div>`;
  document.body.className = 'is-disabled';
}
