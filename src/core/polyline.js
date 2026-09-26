// Arc-length walking over a sampled shop centerline.
//
// The samples come from real straights and real circular arcs, so linear interpolation between
// them is the centerline — no spline is fitted through them. A spline would bulge around a
// table point that happens to sit on a tangent, which is exactly the failure this avoids.
//
// Points are {x, y, z}; a 2D caller simply leaves z at 0.

const z = (p) => p.z ?? 0;

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y, z(b) - z(a));
}

/** Cumulative arc length at each sample, starting at 0. */
export function cumulative(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + distance(points[i - 1], points[i]));
  return out;
}

export function totalLength(points) {
  const c = cumulative(points);
  return c.length ? c[c.length - 1] : 0;
}

const lerp = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: z(a) + (z(b) - z(a)) * t,
});

/** Point and unit tangent at arc length `s`, clamped to the ends. */
export function stationAt(points, s, cum = cumulative(points)) {
  if (points.length === 0) return null;
  if (points.length === 1) return { point: points[0], tangent: { x: 1, y: 0, z: 0 } };

  const total = cum[cum.length - 1];
  const at = Math.min(Math.max(s, 0), total);

  let i = 1;
  while (i < cum.length - 1 && cum[i] < at) i++;

  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? (at - cum[i - 1]) / span : 0;
  const a = points[i - 1];
  const b = points[i];
  const len = distance(a, b) || 1;

  return {
    point: lerp(a, b, t),
    tangent: { x: (b.x - a.x) / len, y: (b.y - a.y) / len, z: (z(b) - z(a)) / len },
  };
}

/** The stretch of the polyline between two arc lengths, with both ends landed exactly. */
export function slice(points, from, to, cum = cumulative(points)) {
  const out = [];
  const head = stationAt(points, from, cum);
  if (head) out.push(head.point);

  for (let i = 0; i < points.length; i++) {
    if (cum[i] > from + 1e-9 && cum[i] < to - 1e-9) out.push(points[i]);
  }

  const tail = stationAt(points, to, cum);
  if (tail) out.push(tail.point);
  return out;
}
