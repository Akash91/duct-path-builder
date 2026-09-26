// Routing rules for spans that are not one shop elbow. Dimension-free: callers resolve their
// own vectors into the tangent frame and pass scalars in.
//
// A shop elbow is planar — it yaws in plan or pitches in elevation, never both at once. When a
// span needs both, the primary route is an angled straight; the fallback is two compact 90°
// cardinals; only then is it a compound bend.

/** A kick is a slight aim, not a fitting. Outside this band the piece cannot be made. */
export const KICK_MIN_DEG = 0.5;
export const KICK_MAX_DEG = 60;

/**
 * Can an angled straight be built? `alongTrack` is the chord's projection on the incoming
 * tangent, `kickDeg` the heading change at the kick, `outLength` the straight after it.
 */
export function angledStraightPlan({ alongTrack, lead, kickDeg, outLength }) {
  if (!(alongTrack >= lead)) return { ok: false, reason: 'lead-too-short' };
  if (!(outLength > 0)) return { ok: false, reason: 'target-behind' };
  if (!(kickDeg >= KICK_MIN_DEG)) return { ok: false, reason: 'kick-too-slight' };
  if (!(kickDeg <= KICK_MAX_DEG)) return { ok: false, reason: 'kick-too-sharp' };
  return { ok: true, lead, kickDeg, outLength };
}

/**
 * Fallback route: run on, turn 90° onto the lateral cardinal, turn 90° onto the vertical.
 * Two perpendicular turns span the whole offset, so no third bend is needed.
 *
 * A 90° fillet of radius r eats exactly r off each leg (r·tan45° = r), and each elbow still
 * needs its flange stubs, so every leg has to carry its share plus the offsets.
 */
export function cardinalPlan({ along, lateral, vertical, minRadius, flangeOffset }) {
  const r = Math.max(minRadius, 0);
  const s = Math.abs(lateral);
  const u = Math.abs(vertical);

  if (!(along >= r + flangeOffset)) return { ok: false, reason: 'lead-too-short' };
  // The middle leg is shortened by both elbows, so it needs two radii and two stubs.
  if (!(s >= 2 * r + 2 * flangeOffset)) return { ok: false, reason: 'lateral-too-short' };
  if (!(u >= r + flangeOffset)) return { ok: false, reason: 'vertical-too-short' };

  return {
    ok: true,
    radius: r,
    legs: [along, s, u],
    lateralSign: Math.sign(lateral) || 1,
    verticalSign: Math.sign(vertical) || 1,
  };
}
