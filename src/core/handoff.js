// One-shot handoff of the current path between the 2D and 3D builders.
//
// sessionStorage rather than localStorage: this is a transfer, not a save. It must not linger
// or compete with either app's own namespaced autosave.

const KEY = 'curve-path-builder/handoff';

export function sendPath(json) {
  try {
    sessionStorage.setItem(KEY, json);
    return true;
  } catch {
    return false;
  }
}

/** Returns the handed-over path once, then forgets it. */
export function takePath() {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value) sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}
