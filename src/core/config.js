// Runtime configuration. Edit config.json — no rebuild, just reload.
//
// To add a feature flag: add a boolean here, mark the owning elements in index.html with
// data-feature="yourFlag", and gate any behaviour on state.features.yourFlag.

export const DEFAULT_CONFIG = {
  sweeps: [0, 30, 45, 60, 90],
  features: {
    duct: true,
    jacket: true,
    minBendRadius: true,
    guideRays: true,
    snapping: true,
    importExport: true,
    crossLink: true,
    threeD: false,
    autosave: true,
  },
  defaults: {
    initialHeading: 0,
    initialElevation: 0,
    toleranceDeg: 2,
    ductWidth: 18,
    jacketWidth: 40,
    minRadiusRatio: 1.5,
  },
};

/** Section-wise merge, so a config file may override only the keys it cares about. */
function merge(base, over) {
  const sweeps = Array.isArray(over.sweeps) && over.sweeps.length ? over.sweeps : base.sweeps;

  const defaults = { ...base.defaults };
  for (const [key, value] of Object.entries(over.defaults ?? {})) {
    if (key in base.defaults && Number.isFinite(value)) defaults[key] = value;
  }

  const features = { ...base.features };
  for (const [key, value] of Object.entries(over.features ?? {})) {
    features[key] = Boolean(value);
  }

  return { sweeps: [...sweeps], features, defaults };
}

export async function loadConfig(url = 'config.json') {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return merge(DEFAULT_CONFIG, await response.json());
  } catch (err) {
    // A missing or malformed config must never take the app down.
    console.warn(`[config] falling back to built-in defaults: ${err.message}`);
    return merge(DEFAULT_CONFIG, {});
  }
}

/**
 * Hide anything whose flags are not all enabled.
 * `data-feature` takes a comma-separated list, so an element can require several at once.
 */
export function applyFeatureFlags(features, root = document) {
  for (const el of root.querySelectorAll('[data-feature]')) {
    const required = el.dataset.feature.split(',').map((s) => s.trim()).filter(Boolean);
    el.hidden = !required.every((name) => features[name]);
  }
}
