// Viewport and marker invariants that both builders share. Kept dimension-free so Node tests
// can lock the behaviours without a DOM or WebGL (docs/requirements.md R-137, R-152, R-154).

/** Drawn point must stay a pin, not a second duct. Diameter is well under the duct Ø. */
export const POINT_DOT_R = 6;
export const POINT_HIT_R = 18;
export const POINT_MARKER_R = 8;
export const POINT_SPHERE_R = 6;

/** 3D origin triad length (mm). */
export const ORIGIN_AXIS_MM = 400;

/** Selecting a table row pans the 3D camera but never closer than this (mm). */
export const MIN_FOCUS_STANDOFF = 9000;

export const ORIGIN = { x: 0, y: 0, z: 0 };

export function originSpec() {
  return {
    position: { ...ORIGIN },
    axes: ['x', 'y', 'z'],
    label: '0,0,0',
    axisMm: ORIGIN_AXIS_MM,
  };
}

/** Point glyphs stay small against the plant diameters. */
export function markersSmallerThanDuct(ductWidth = 180, jacketWidth = 400) {
  const outer = Math.max(ductWidth, jacketWidth);
  const drawn = Math.max(POINT_DOT_R, POINT_SPHERE_R, POINT_MARKER_R) * 2;
  return drawn < outer * 0.2 && drawn < ductWidth * 0.4;
}

/** Fit always frames the world origin as well as the authored points (R-137). */
export function fitPoints(points, { includeOrigin = true } = {}) {
  const pts = includeOrigin ? [ORIGIN, ...(points ?? [])] : [...(points ?? [])];
  if (pts.length === 0) pts.push(ORIGIN);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    minZ = Math.min(minZ, p.z ?? 0);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    maxZ = Math.max(maxZ, p.z ?? 0);
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    includesOrigin: minX <= 0 && maxX >= 0 && minY <= 0 && maxY >= 0 && minZ <= 0 && maxZ >= 0,
  };
}

/** 2D: pan so `point` is centred; zoom (`w`/`h`) is unchanged (R-154). */
export function centerViewOnPoint(view, point) {
  if (!view || !point) return view;
  return {
    ...view,
    x: point.x - view.w / 2,
    y: point.y - view.h / 2,
  };
}

/**
 * 3D: keep the current approach direction, retarget onto `point`, and pull back if closer
 * than `minStandoff` (R-154).
 */
export function focusCameraOnPoint(camera, target, point, minStandoff = MIN_FOCUS_STANDOFF) {
  if (!camera || !target || !point) return { camera, target };
  let ox = camera.x - target.x;
  let oy = camera.y - target.y;
  let oz = camera.z - target.z;
  let len = Math.hypot(ox, oy, oz);
  if (!(len > 0)) {
    ox = 0.5;
    oy = -0.7;
    oz = 0.5;
    len = Math.hypot(ox, oy, oz);
  }
  const dist = Math.max(len, minStandoff);
  const s = dist / len;
  return {
    target: { x: point.x, y: point.y, z: point.z ?? 0 },
    camera: {
      x: point.x + ox * s,
      y: point.y + oy * s,
      z: (point.z ?? 0) + oz * s,
    },
    standoff: dist,
  };
}
