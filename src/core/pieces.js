// Flange-to-flange shop pieces, derived from the solved path. Table points are centerline
// waypoints, not parts: consecutive straights merge across a point and are spliced only when
// they outrun the maximum piece length. Path ends count as flanges.
//
// Dimension-free. Each segment hands over a `shop` descriptor of scalars; the vector geometry
// of the same layout lives in the 2D and 3D expanders.

import { DEG } from './angles.js';
import { validRuns } from './solve.js';

/** What a piece is bought as. */
export const PIECE_KINDS = ['straight', 'elbow', 'angled'];

/** How a stretch is drawn: plain run, shop elbow arc, or an angled-straight kick. */
export const VISUAL_KINDS = ['straight', 'elbow', 'kick'];

const EPS = 1e-6;

/**
 * Pick the drawn radius of a shop elbow and the straight it leaves behind.
 *
 * The table arc of radius R and the tightest legal fillet of radius r share both tangent rays,
 * so a fillet touches down (R − r)·tan(θ/2) short of where the table arc did — equally on both
 * sides. Shrinking to r_min is only worth it while that leftover still carries a flange stub.
 */
export function elbowLayout({ tableRadius, theta, minRadius = 0, flangeOffset, maxPieceLength }) {
  const half = Math.tan((theta * DEG) / 2);
  const rad = theta * DEG;

  let radius = tableRadius;
  if (minRadius > 0 && minRadius < tableRadius && (tableRadius - minRadius) * half >= flangeOffset - EPS) {
    radius = minRadius;
  }

  let reason = null;
  let pieceLength = 2 * flangeOffset + radius * rad;

  if (pieceLength > maxPieceLength + EPS) {
    // Last resort before rejecting: tighten further, but never past the bend limit.
    const shrunk = (maxPieceLength - 2 * flangeOffset) / rad;
    if (shrunk >= minRadius && shrunk > 0) {
      radius = Math.min(radius, shrunk);
      pieceLength = 2 * flangeOffset + radius * rad;
    } else {
      reason = 'elbow-too-long';
    }
  }

  return {
    radius,
    theta,
    arcLength: radius * rad,
    tangentLength: radius * half,
    leftover: (tableRadius - radius) * half,
    pieceLength,
    reason,
  };
}

/** Break one span's shop descriptor into the alternating straight / bend stretches it builds. */
export function stretchesFor(shop) {
  if (!shop) return [];

  if (shop.kind === 'straight') return [{ kind: 'straight', length: shop.length }];

  if (shop.kind === 'elbow') {
    return [
      { kind: 'straight', length: shop.leftover },
      { kind: 'elbow', theta: shop.theta, radius: shop.radius, length: shop.arcLength },
      { kind: 'straight', length: shop.leftover },
    ];
  }

  if (shop.kind === 'angled') {
    return [
      { kind: 'straight', length: shop.lead },
      { kind: 'kick', kickDeg: shop.kickDeg, length: 0 },
      { kind: 'straight', length: shop.outLength },
    ];
  }

  if (shop.kind === 'cardinal') {
    const out = [];
    shop.legs.forEach((leg, i) => {
      out.push({ kind: 'straight', length: leg });
      if (i < shop.legs.length - 1) {
        out.push({ kind: 'elbow', theta: 90, radius: shop.radius, length: shop.radius * (90 * DEG) });
      }
    });
    return out;
  }

  return [];
}

/** Even split, so a 2100 mm run becomes two 1050s rather than a 1050 and a stub. */
export function spliceStraight(length, maxPieceLength) {
  if (length <= EPS) return [];
  const n = Math.max(1, Math.ceil(length / maxPieceLength - 1e-9));
  return Array.from({ length: n }, () => length / n);
}

/**
 * Walk one run of valid segments and cut it into pieces.
 * `start` / `end` are arc lengths along the run's shop centerline, so a renderer can put a
 * flange at every boundary without knowing anything about how the layout was decided.
 */
export function layoutRun(run, opts) {
  const { flangeOffset, maxPieceLength, minLead } = opts;

  const raw = run.flatMap((seg) => stretchesFor(seg.shop).map((s) => ({ ...s, segIndex: seg.index })));

  // Merge straights across table points: a waypoint is not a flange.
  const stretches = [];
  for (const st of raw) {
    const last = stretches[stretches.length - 1];
    if (st.kind === 'straight' && last && last.kind === 'straight') last.length += st.length;
    else stretches.push({ ...st });
  }

  const pieces = [];
  const issues = [];
  let cursor = 0;
  let pending = 0;
  let pendingSeg = run[0]?.index ?? 0;

  const emitStraights = (length, segIndex) => {
    for (const part of spliceStraight(length, maxPieceLength)) {
      pieces.push({ kind: 'straight', length: part, arcDeg: 0, radius: Infinity, segIndex, start: cursor, end: cursor + part });
      cursor += part;
    }
  };

  for (let i = 0; i < stretches.length; i++) {
    const st = stretches[i];

    if (st.kind === 'straight') {
      pending += st.length;
      pendingSeg = st.segIndex;
      continue;
    }

    if (st.kind === 'elbow') {
      const lead = pending - flangeOffset;
      if (lead < -EPS) issues.push({ reason: 'short-stub', segIndex: st.segIndex });
      emitStraights(Math.max(lead, 0), pendingSeg);

      const length = 2 * flangeOffset + st.length;
      pieces.push({ kind: 'elbow', length, arcDeg: st.theta, radius: st.radius, segIndex: st.segIndex, start: cursor, end: cursor + length });
      cursor += length;
      // The trailing stub is already inside the piece, so the next straight owes it back.
      pending = -flangeOffset;
      pendingSeg = st.segIndex;
      continue;
    }

    if (st.kind === 'kick') {
      const next = stretches[i + 1];
      const out = next && next.kind === 'straight' ? next.length : 0;
      const lead = Math.max(pending, 0);
      if (pending < minLead - EPS) issues.push({ reason: 'short-stub', segIndex: st.segIndex });

      // A kick takes no flanges, so it rides inside one piece with as much of the run as fits.
      const take = Math.min(out, Math.max(0, maxPieceLength - lead));
      const length = lead + take;
      pieces.push({ kind: 'angled', length, arcDeg: st.kickDeg, radius: Infinity, segIndex: st.segIndex, start: cursor, end: cursor + length });
      cursor += length;

      pending = out - take;
      pendingSeg = next ? next.segIndex : st.segIndex;
      if (next && next.kind === 'straight') i++;
      continue;
    }
  }

  if (pending < -EPS) issues.push({ reason: 'short-stub', segIndex: pendingSeg });
  emitStraights(Math.max(pending, 0), pendingSeg);

  return { pieces, issues, length: cursor };
}

/** Stable handle for a piece, so a user-requested extra cut survives a re-solve. */
export const pieceKey = (piece) => `${piece.runIndex}:${piece.start.toFixed(1)}`;

/** Every piece in the path, numbered end to end, plus whatever the layout could not satisfy. */
export function layoutPieces(solution, opts) {
  const runs = validRuns(solution);
  const extraSplits = opts.extraSplits ?? {};
  const pieces = [];
  const issues = [];

  runs.forEach((run, runIndex) => {
    const laid = layoutRun(run, opts);
    for (const piece of laid.pieces) {
      const tagged = { ...piece, runIndex };
      // A leftover straight may be cut again by hand; a fitting never is.
      const cuts = tagged.kind === 'straight' ? (extraSplits[pieceKey(tagged)] ?? 0) : 0;
      const parts = cuts > 0 ? cuts + 1 : 1;

      for (let i = 0; i < parts; i++) {
        const length = tagged.length / parts;
        pieces.push({
          ...tagged,
          length,
          start: tagged.start + length * i,
          end: tagged.start + length * (i + 1),
          index: pieces.length,
        });
      }
    }
    issues.push(...laid.issues);
  });

  for (const seg of solution.segments) {
    if (seg.shop?.reason) issues.push({ reason: seg.shop.reason, segIndex: seg.index });
  }

  return { pieces, issues };
}

/** One-line shop read of a piece. Every length is millimetres. */
export function pieceLabel(piece) {
  const mm = `${piece.length.toFixed(0)} mm`;
  if (piece.kind === 'elbow') return `Elbow ${piece.arcDeg}° · r ${piece.radius.toFixed(0)} mm · ${mm}`;
  if (piece.kind === 'angled') return `Angled straight ${piece.arcDeg.toFixed(1)}° kick · ${mm}`;
  return `Straight · ${mm}`;
}
