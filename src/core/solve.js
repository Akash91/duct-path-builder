// Path walking and run grouping. Dimension-free: the tangent is opaque here, so 2D can pass a
// bearing in degrees and 3D a unit vector, and this loop does not care which.

let nextId = 1;

/** Points always carry z, so the same schema serves both apps (R-13). */
export function makePoint(x, y, z = 0) {
  return { id: `p${nextId++}`, x, y, z };
}

/** Keep id generation ahead of any ids restored from storage or an import. */
export function reserveIds(points) {
  for (const p of points) {
    const n = Number.parseInt(String(p.id).replace(/^p/, ''), 10);
    if (Number.isFinite(n) && n >= nextId) nextId = n + 1;
  }
}

/**
 * Walk the point list front-to-back, carrying each arc's exit tangent into the next
 * segment as its incoming tangent (R-10). `classify` supplies the dimension-specific test.
 */
export function walkPath(points, initialTangent, classify) {
  const segments = [];
  let tangent = initialTangent;

  for (let i = 0; i + 1 < points.length; i++) {
    const result = classify(points[i], points[i + 1], tangent);
    segments.push({
      index: i,
      fromId: points[i].id,
      toId: points[i + 1].id,
      from: points[i],
      to: points[i + 1],
      tauIn: tangent,
      ...result,
    });
    tangent = result.tOut;
  }

  return {
    segments,
    tangentOut: tangent,
    errorCount: segments.reduce((n, s) => n + (s.ok ? 0 : 1), 0),
    tightCount: segments.reduce((n, s) => n + (s.tooTight ? 1 : 0), 0),
  };
}

/** Split the path into maximal stretches of consecutive valid segments (R-36). */
export function validRuns(solution) {
  const runs = [];
  let current = null;

  for (const seg of solution.segments) {
    if (!seg.ok) { current = null; continue; }
    if (current === null) { current = []; runs.push(current); }
    current.push(seg);
  }
  return runs;
}

/** Incoming tangent at a point, i.e. what a segment leaving it must match. */
export function tangentAt(solution, pointIndex, initialTangent) {
  if (pointIndex <= 0) return initialTangent;
  const prev = solution.segments[pointIndex - 1];
  return prev ? prev.tOut : initialTangent;
}

/**
 * The bend limit comes from the widest band in the assembly, not the centerline.
 * A hidden jacket still counts — it physically exists; a disabled one does not (R-61, R-77).
 */
export function minRadiusFor(state) {
  if (!state.features.minBendRadius) return 0;
  const duct = state.features.duct ? state.ductWidth : 0;
  const jacket = state.features.jacket ? state.jacketWidth : 0;
  return state.minRadiusRatio * Math.max(duct, jacket);
}
