// View helpers. Dimension-free arithmetic on {x, y, z} so both stages agree on framing.

/** Never fly closer to a point than this, in millimetres. */
export const FOCUS_STANDOFF = 9000;

const z = (p) => p.z ?? 0;

/**
 * Move the eye onto `target` while keeping the approach it already had.
 * Selecting a row should pan, not zoom, so the distance is only ever pushed outwards.
 */
export function focusEye(eye, oldTarget, target, standoff = FOCUS_STANDOFF) {
  let dx = eye.x - oldTarget.x;
  let dy = eye.y - oldTarget.y;
  let dz = z(eye) - z(oldTarget);

  let len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) { dx = 0.5; dy = -0.7; dz = 0.5; len = Math.hypot(dx, dy, dz); }

  const dist = Math.max(len, standoff);
  return {
    x: target.x + (dx / len) * dist,
    y: target.y + (dy / len) * dist,
    z: z(target) + (dz / len) * dist,
  };
}

/** Bounding box of the points plus the origin, which must always stay in frame. */
export function boundsWithOrigin(points) {
  const all = [{ x: 0, y: 0, z: 0 }, ...points];
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const p of all) {
    min.x = Math.min(min.x, p.x); max.x = Math.max(max.x, p.x);
    min.y = Math.min(min.y, p.y); max.y = Math.max(max.y, p.y);
    min.z = Math.min(min.z, z(p)); max.z = Math.max(max.z, z(p));
  }
  return { min, max };
}
