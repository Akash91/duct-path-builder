import { makePoint, reserveIds } from './solve.js';
import { DEFAULT_CONFIG } from './config.js';

// Namespaced per app, so the 2D and 3D builders never overwrite each other's autosave.
// v2: coordinates and diameters are millimetres (R-140). Old v1 saves are left unused.
let storageKey = 'curve-path-builder/2d/v2';

let seed = { ...DEFAULT_CONFIG.defaults };
let features = { ...DEFAULT_CONFIG.features };

// Straight — 30° plan elbow — straight, so the demo has leftover to splice and 60 mm stubs.
// In 3D with drain on, the same XY path sits on a 3° ramp so the opening straight can drain.
const demoPoints = () => {
  const pts = [
    makePoint(0, 0),
    makePoint(1600, 0),
    makePoint(2083.0, 129.4),
    makePoint(3295.4, 829.4),
  ];
  if (storageKey.includes('/3d/') && features.drainSlope) {
    const deg = Number.isFinite(seed.slopeDeg) ? seed.slopeDeg : 3;
    const k = Math.tan((deg * Math.PI) / 180);
    for (const p of pts) p.z = p.x * k;
  }
  return pts;
};

const defaults = () => ({
  points: demoPoints(),
  ...seed,
  features,
  // A disabled feature is also an unchecked toggle, so nothing else needs to know.
  showDuct: features.duct,
  showJacket: features.jacket,
  showGuides: features.guideRays,
  snapEnabled: features.snapping,
  selectedId: null,
  selectedPieceId: null,
  pieceOverrides: {},
  pieceSplits: {},
});

let state = defaults();
const listeners = new Set();

/** Apply a loaded config. Must run before restore() and the first render. */
export function configure(config, namespace = '2d') {
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
  update({
    points: [],
    selectedId: null,
    selectedPieceId: null,
    pieceOverrides: {},
    pieceSplits: {},
  });
}

export function selectPiece(id) {
  update({ selectedPieceId: id || null });
}

export function setPieceOverride(id, patch) {
  if (!id) return;
  update((s) => {
    const prev = s.pieceOverrides?.[id] ?? {};
    const next = { ...prev };
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || Number.isNaN(value)) delete next[key];
      else if (Number.isFinite(value)) next[key] = value;
    }
    const pieceOverrides = { ...s.pieceOverrides };
    if (Object.keys(next).length === 0) delete pieceOverrides[id];
    else pieceOverrides[id] = next;
    return { pieceOverrides };
  });
}

export function splitPiece(gapKey, cuts = 2) {
  const n = Math.max(2, Math.floor(Number(cuts) || 2));
  if (!gapKey) return;
  update((s) => ({
    pieceSplits: { ...s.pieceSplits, [gapKey]: n },
    selectedPieceId: null,
  }));
}

const persisted = [
  'initialHeading', 'initialElevation', 'toleranceDeg',
  'ductWidth', 'jacketWidth', 'minRadiusRatio',
  'maxPieceLengthMm', 'flangeBendOffsetMm',
  'slopeDeg', 'slopeToleranceDeg',
];

export function toJSON() {
  const data = { version: 2, points: state.points };
  for (const key of persisted) data[key] = state[key];
  data.pieceOverrides = state.pieceOverrides ?? {};
  data.pieceSplits = state.pieceSplits ?? {};
  return JSON.stringify(data, null, 2);
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

  const pick = (value, key) => (Number.isFinite(value) ? value : seed[key]);

  const patch = {
    points,
    selectedId: null,
    selectedPieceId: null,
    pieceOverrides: (data.pieceOverrides && typeof data.pieceOverrides === 'object') ? data.pieceOverrides : {},
    pieceSplits: (data.pieceSplits && typeof data.pieceSplits === 'object') ? data.pieceSplits : {},
  };
  for (const key of persisted) patch[key] = pick(data[key], key);
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
