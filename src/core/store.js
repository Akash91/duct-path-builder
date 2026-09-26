import { makePoint, reserveIds } from './solve.js';
import { DEFAULT_CONFIG } from './config.js';
import { DEG } from './angles.js';

// Namespaced per app, so the 2D and 3D builders never overwrite each other's autosave.
// v2 is the millimetre era; any older centimetre save is left where it is rather than rescaled.
let storageKey = 'curve-path-builder/2d/v2';
let app = '2d';

let seed = { ...DEFAULT_CONFIG.defaults };
let features = { ...DEFAULT_CONFIG.features };

/** The shipped demo path, in millimetres. */
const DEMO = [[0, 0], [1600, 0], [2083.0, 129.4], [3295.4, 829.4]];

/** In 3D the opening run has to drain, so the demo sits on the configured ramp. */
function demoPoints() {
  const ramp = app === '3d' && features.drainSlope ? Math.tan(seed.slopeDeg * DEG) : 0;
  return DEMO.map(([x, y]) => makePoint(x, y, Math.round(x * ramp * 10) / 10));
}

const defaults = () => ({
  points: demoPoints(),
  ...seed,
  features,
  // The bands and their fittings start hidden: the centerline is what the user is authoring,
  // and a 400 mm jacket buries it. They still count towards the bend limit while hidden.
  showDuct: false,
  showJacket: false,
  showFlanges: false,
  // A disabled feature is also an unchecked toggle, so nothing else needs to know.
  showGuides: features.guideRays,
  snapEnabled: features.snapping,
  selectedId: null,
  selectedPieceIndex: 0,
  extraSplits: {},
});

let state = defaults();
const listeners = new Set();

/** Apply a loaded config. Must run before restore() and the first render. */
export function configure(config, namespace = '2d') {
  app = namespace;
  storageKey = `curve-path-builder/${namespace}/v2`;
  seed = { ...DEFAULT_CONFIG.defaults, ...config.defaults };
  features = { ...DEFAULT_CONFIG.features, ...config.features };
  state = defaults();
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  save();
  for (const fn of listeners) fn(state);
}

/** Every mutation funnels through here so there is exactly one re-render path. */
export function update(patch) {
  state = typeof patch === 'function' ? { ...state, ...patch(state) } : { ...state, ...patch };
  notify();
}

export function addPoint(x, y, z = 0) {
  update((s) => ({ points: [...s.points, makePoint(x, y, z)] }));
}

/** `patch` carries whichever axes changed, so 2D and 3D share one call. */
export function movePoint(id, patch) {
  update((s) => ({ points: s.points.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
}

export function removePoint(id) {
  update((s) => ({
    points: s.points.filter((p) => p.id !== id),
    selectedId: s.selectedId === id ? null : s.selectedId,
  }));
}

export function reorderPoint(id, delta) {
  update((s) => {
    const i = s.points.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= s.points.length) return {};
    const points = [...s.points];
    [points[i], points[j]] = [points[j], points[i]];
    return { points };
  });
}

export function clearPoints() {
  update({ points: [], selectedId: null });
}

/** Keys carried through export, import, autosave and the cross-link handoff alike. */
const SETTINGS = [
  'initialHeading', 'initialElevation', 'toleranceDeg',
  'ductWidth', 'jacketWidth', 'minRadiusRatio',
  'maxPieceLength', 'elbowFlangeOffset', 'angledMinLead',
  'slopeDeg', 'slopeToleranceDeg',
];

export function toJSON() {
  const out = { version: 2, units: 'mm', points: state.points };
  for (const key of SETTINGS) out[key] = state[key];
  return JSON.stringify(out, null, 2);
}

export function fromJSON(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.points)) throw new Error('Expected a "points" array');

  // Ids are regenerated rather than trusted, so imported JSON can never inject markup.
  const points = data.points.map((p, i) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(`Point ${i} needs numeric x and y`);
    }
    return { id: `p${i + 1}`, x: p.x, y: p.y, z: Number.isFinite(p.z) ? p.z : 0 };
  });
  reserveIds(points);

  const patch = { points, selectedId: null, selectedPieceIndex: 0 };
  for (const key of SETTINGS) patch[key] = Number.isFinite(data[key]) ? data[key] : seed[key];

  update(patch);
}

function save() {
  if (!features.autosave) return;
  try {
    localStorage.setItem(storageKey, toJSON());
  } catch {
    // Private mode or quota exceeded — autosave is best-effort.
  }
}

/** With autosave off, config defaults always win on reload. */
export function restore() {
  if (!features.autosave) return;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) fromJSON(raw);
  } catch {
    state = defaults();
  }
}

export function resetToDefaults() {
  state = defaults();
  notify();
}
