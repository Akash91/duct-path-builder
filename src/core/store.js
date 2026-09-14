import { makePoint, reserveIds } from './solve.js';
import { DEFAULT_CONFIG } from './config.js';

// Namespaced per app, so the 2D and 3D builders never overwrite each other's autosave.
let storageKey = 'curve-path-builder/2d/v1';

let seed = { ...DEFAULT_CONFIG.defaults };
let features = { ...DEFAULT_CONFIG.features };

const defaults = () => ({
  points: [makePoint(150, 400), makePoint(420, 330), makePoint(700, 350)],
  ...seed,
  features,
  // A disabled feature is also an unchecked toggle, so nothing else needs to know.
  showDuct: features.duct,
  showJacket: features.jacket,
  showGuides: features.guideRays,
  snapEnabled: features.snapping,
  selectedId: null,
});

let state = defaults();
const listeners = new Set();

/** Apply a loaded config. Must run before restore() and the first render. */
export function configure(config, namespace = '2d') {
  storageKey = `curve-path-builder/${namespace}/v1`;
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

export function toJSON() {
  const { points, initialHeading, initialElevation, toleranceDeg, ductWidth, jacketWidth, minRadiusRatio } = state;
  return JSON.stringify({ version: 1, points, initialHeading, initialElevation, toleranceDeg, ductWidth, jacketWidth, minRadiusRatio }, null, 2);
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

  update({
    points,
    initialHeading: pick(data.initialHeading, 'initialHeading'),
    initialElevation: pick(data.initialElevation, 'initialElevation'),
    toleranceDeg: pick(data.toleranceDeg, 'toleranceDeg'),
    ductWidth: pick(data.ductWidth, 'ductWidth'),
    jacketWidth: pick(data.jacketWidth, 'jacketWidth'),
    minRadiusRatio: pick(data.minRadiusRatio, 'minRadiusRatio'),
    selectedId: null,
  });
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
