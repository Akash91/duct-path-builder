// Minimal vector helpers. Plain objects so points and tangents share one shape with the store.

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });

export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const length = (a) => Math.hypot(a.x, a.y, a.z);

export function normalize(a) {
  const l = length(a);
  return l === 0 ? vec() : scale(a, 1 / l);
}

export const distance = (a, b) => length(sub(a, b));

/** Rodrigues rotation of `v` about unit `axis` by `angleRad`. */
export function rotateAbout(v, axis, angleRad) {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return add(
    add(scale(v, c), scale(cross(axis, v), s)),
    scale(axis, dot(axis, v) * (1 - c)),
  );
}

/** Unit vector from azimuth (about +Z, from +X) and elevation above the XY plane. */
export function fromAngles(azimuthDeg, elevationDeg) {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return { x: Math.cos(e) * Math.cos(a), y: Math.cos(e) * Math.sin(a), z: Math.sin(e) };
}
