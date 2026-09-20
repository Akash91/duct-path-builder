// Fabrication layout (docs/requirements.md §10). The solver still sees one continuous centerline;
// this module *cuts* that line into manufactured pieces bounded by flanges, without moving points.
//
// An elbow is its own piece: flange — offset — arc — offset — flange. The stubs are taken from
// the adjacent straights. Leftover straights are spliced so none exceeds maxPieceLengthMm.

import { DEG } from './angles.js';
import { EPS } from './arcMath.js';
import { validRuns, minRadiusFor } from './solve.js';

export function flangeOptionsFor(state) {
  if (!state.features?.flanges) return null;
  return {
    offsetMm: Math.max(0, state.flangeBendOffsetMm ?? 60),
    maxPieceMm: Math.max(1, state.maxPieceLengthMm ?? 1050),
    splits: state.pieceSplits ?? {},
    minRadius: minRadiusFor(state),
  };
}

export function defaultAddReach(state, fallback = 2200) {
  if (state.features?.flanges) return Math.max(1, state.maxPieceLengthMm ?? 1050);
  return fallback;
}

export function segmentLength(seg) {
  if (!seg?.ok || !seg.arc) return 0;
  if (seg.arc.straight || !(seg.arc.theta > 0) || !Number.isFinite(seg.arc.radius)) {
    return seg.chord ?? 0;
  }
  return seg.arc.radius * seg.arc.theta * DEG;
}

export function isBend(seg) {
  return Boolean(seg?.ok && seg.arc && !seg.arc.straight && seg.arc.theta > 0);
}

/**
 * Shop elbow radius: prefer the tightest legal bend so leftover length is straight (R-149).
 * `r_min` when it fits in `maxPieceMm`, otherwise the largest radius that still fits one piece.
 */
export function shopElbowRadius(radius, thetaDeg, offsetMm, maxPieceMm, minRadius = 0) {
  if (!(thetaDeg > 0) || !(radius > 0) || !Number.isFinite(radius)) return radius;
  const thetaRad = thetaDeg * DEG;
  const room = maxPieceMm - 2 * offsetMm;
  const rFit = room > EPS ? room / thetaRad : 0;
  let r = minRadius > 0 ? Math.min(radius, minRadius) : radius;
  if (2 * offsetMm + r * thetaRad > maxPieceMm + 1e-6 && rFit > EPS) {
    r = Math.min(radius, rFit);
  }
  return Math.max(0, r);
}

/**
 * A long circular arc is not a shop piece. Fit a compact elbow of the same sweep
 * (tightest legal radius), and turn the leftover into leading/trailing straights (R-149).
 */
export function compactBendParams(seg, offsetMm, maxPieceMm, minRadius = 0) {
  if (!isBend(seg)) return { compact: false, radius: Infinity, lead: 0, trail: 0, theta: 0, ok: true };
  const R = seg.arc.radius;
  const theta = seg.arc.theta;
  const thetaRad = theta * DEG;
  const originalElbow = 2 * offsetMm + R * thetaRad;
  const r = shopElbowRadius(R, theta, offsetMm, maxPieceMm, minRadius);
  const lead = Math.max(0, (R - r) * Math.tan(thetaRad / 2));
  const elbow = 2 * offsetMm + r * thetaRad;
  return {
    compact: lead > EPS,
    radius: r,
    lead,
    trail: lead,
    theta,
    ok: elbow <= maxPieceMm + 1e-6,
    originalElbow,
    originalRadius: R,
  };
}

/** 1D fabrication spans for one solved segment. Lengths are millimetres along the shop centerline. */
export function fabricationSpans(seg, offsetMm, maxPieceMm, minRadius = 0) {
  if (!seg?.ok) return [];
  if (!isBend(seg)) {
    const length = segmentLength(seg) || seg.chord || 0;
    return [{ kind: 'straight', role: 'full', length, theta: 0, radius: Infinity }];
  }
  const p = compactBendParams(seg, offsetMm, maxPieceMm, minRadius);
  if (!p.compact) {
    return [{ kind: 'arc', role: 'full', length: segmentLength(seg), theta: seg.arc.theta, radius: seg.arc.radius }];
  }
  return [
    { kind: 'straight', role: 'lead', length: p.lead, theta: 0, radius: Infinity },
    { kind: 'arc', role: 'arc', length: p.radius * seg.arc.theta * DEG, theta: seg.arc.theta, radius: p.radius },
    { kind: 'straight', role: 'trail', length: p.trail, theta: 0, radius: Infinity },
  ];
}

function miniSeg(source, span) {
  const bend = span.kind === 'arc';
  return {
    ok: true,
    index: source.index,
    from: source.from,
    to: source.to,
    chord: span.length,
    arc: bend
      ? { straight: false, theta: span.theta, radius: span.radius }
      : { straight: true, theta: 0, radius: Infinity },
    _span: span,
    _source: source,
  };
}

function fabStations(run, offsetMm, maxPieceMm, minRadius) {
  const stations = [];
  let s = 0;
  for (const seg of run) {
    const parts = (seg.legs?.length ? seg.legs : [seg]).map((part) => ({
      ...part,
      index: part.index ?? seg.index,
    }));
    for (const part of parts) {
      for (const span of fabricationSpans(part, offsetMm, maxPieceMm, minRadius)) {
        const mini = miniSeg(part, span);
        const length = span.length;
        stations.push({
          seg: mini,
          s0: s,
          s1: s + length,
          length,
          bend: isBend(mini),
          source: part,
          span,
        });
        s += length;
      }
    }
  }
  return { stations, total: s };
}

function runStations(run) {
  const stations = [];
  let s = 0;
  for (const seg of run) {
    const length = segmentLength(seg);
    stations.push({ seg, s0: s, s1: s + length, length, bend: isBend(seg) });
    s += length;
  }
  return { stations, total: s };
}

export function locateOnRun(run, s) {
  const { stations, total } = runStations(run);
  if (!stations.length) return null;
  const clamped = Math.min(Math.max(0, s), total);
  for (const st of stations) {
    if (clamped <= st.s1 + 1e-9) {
      return { ...st, local: clamped - st.s0 };
    }
  }
  const last = stations[stations.length - 1];
  return { ...last, local: last.length };
}

/** Pose at arc-length `s` along a valid run, using the view's `poseAlong(seg, localDist)`. */
export function poseOnRun(run, s, poseAlong) {
  if (!run?.length || typeof poseAlong !== 'function') return null;
  const at = locateOnRun(run, s);
  if (!at) return null;
  return poseAlong(at.seg, at.local);
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 - 1e-6 && a1 > b0 + 1e-6;
}

function gapKey(s0, s1) {
  return `${s0.toFixed(2)}:${s1.toFixed(2)}`;
}

function subdivideSpan(s0, s1, maxPieceMm, splits, addFlange) {
  const span = s1 - s0;
  const key = gapKey(s0, s1);
  const auto = Math.max(1, Math.ceil(span / maxPieceMm - 1e-9));
  const extra = Number(splits[key]) || 1;
  const cuts = Math.max(auto, extra);
  if (cuts <= 1) return [{ s0, s1, gapKey: key }];

  const pieceLen = span / cuts;
  const out = [];
  for (let k = 0; k < cuts; k++) {
    const a = s0 + k * pieceLen;
    const b = k === cuts - 1 ? s1 : s0 + (k + 1) * pieceLen;
    if (k > 0) addFlange(a, 'splice');
    out.push(...subdivideSpan(a, b, maxPieceMm, splits, addFlange));
  }
  return out;
}

export function layoutRun(run, offsetMm, maxPieceMm, splits = {}, minRadius = 0) {
  const flanges = [];
  const pieces = [];
  const errors = [];
  const { stations, total } = fabStations(run, offsetMm, maxPieceMm, minRadius);
  const fabRun = stations.map((st) => st.seg);

  if (!(total > EPS) || !stations.length) {
    return { pieces, flanges, errors, total };
  }

  const addFlange = (s, kind) => {
    if (flanges.some((f) => Math.abs(f.s - s) < 1e-6)) return;
    flanges.push({ s, kind, run });
  };

  const reserved = [];

  for (const st of stations) {
    if (!st.bend) continue;

    const want0 = st.s0 - offsetMm;
    const want1 = st.s1 + offsetMm;
    let ok = true;
    let reason = null;

    if (want0 < -1e-6 || want1 > total + 1e-6) {
      ok = false;
      reason = 'short-stub';
    }

    // Each stub must sit on a straight. Landing on another arc means two bends are too close.
    if (offsetMm > EPS) {
      const midL = (want0 + st.s0) / 2;
      const midR = (st.s1 + want1) / 2;
      if (want0 >= -1e-6 && locateOnRun(fabRun, midL)?.bend) {
        ok = false;
        reason = 'short-stub';
      }
      if (want1 <= total + 1e-6 && locateOnRun(fabRun, midR)?.bend) {
        ok = false;
        reason = 'short-stub';
      }
    }

    const s0 = Math.max(0, want0);
    const s1 = Math.min(total, want1);

    for (const r of reserved) {
      if (overlaps(s0, s1, r.s0, r.s1)) {
        ok = false;
        reason = 'short-stub';
      }
    }

    if (s1 - s0 > maxPieceMm + 1e-6) {
      ok = false;
      reason = reason ?? 'elbow-too-long';
    }

    reserved.push({ s0, s1 });
    addFlange(s0, 'elbow');
    addFlange(s1, 'elbow');

    const piece = {
      kind: 'elbow',
      id: `elbow-${st.seg.index}-${st.s0.toFixed(1)}`,
      s0,
      s1,
      length: s1 - s0,
      arcLength: st.length,
      theta: st.seg.arc.theta,
      ok,
      reason,
      segIndex: st.seg.index,
      run,
    };
    pieces.push(piece);
    if (!ok) errors.push({ type: reason, piece });
  }

  reserved.sort((a, b) => a.s0 - b.s0);

  const gaps = [];
  let cursor = 0;
  for (const r of reserved) {
    if (r.s0 > cursor + 1e-6) gaps.push({ s0: cursor, s1: r.s0 });
    cursor = Math.max(cursor, r.s1);
  }
  if (total > cursor + 1e-6) gaps.push({ s0: cursor, s1: total });

  addFlange(0, 'end');
  addFlange(total, 'end');

  for (const gap of gaps) {
    const spans = subdivideSpan(gap.s0, gap.s1, maxPieceMm, splits, addFlange);
    for (const { s0: a, s1: b, gapKey: key } of spans) {
      pieces.push({
        kind: 'straight',
        id: `straight-${a.toFixed(2)}`,
        s0: a,
        s1: b,
        length: b - a,
        ok: (b - a) <= maxPieceMm + 1e-6,
        reason: (b - a) <= maxPieceMm + 1e-6 ? null : 'piece-too-long',
        gapKey: key,
        segIndex: locateOnRun(fabRun, (a + b) / 2)?.seg.index ?? 0,
        run,
      });
    }
  }

  pieces.sort((a, b) => a.s0 - b.s0 || a.s1 - b.s1);
  flanges.sort((a, b) => a.s - b.s);
  return { pieces, flanges, errors, total };
}

export function layoutPieces(solution, options) {
  if (!options || !solution) {
    return { pieces: [], flanges: [], errors: [], totals: [] };
  }
  const { offsetMm, maxPieceMm, splits = {}, minRadius = 0 } = options;
  const laid = validRuns(solution).map((run) => layoutRun(run, offsetMm, maxPieceMm, splits, minRadius));
  return {
    pieces: laid.flatMap((r) => r.pieces),
    flanges: laid.flatMap((r) => r.flanges),
    errors: laid.flatMap((r) => r.errors),
  };
}

export function fabricationDigest(laid) {
  const n = laid.pieces.length;
  if (!n) return '';
  const elbows = laid.pieces.filter((p) => p.kind === 'elbow').length;
  const bad = laid.pieces.filter((p) => !p.ok).length;
  const parts = [
    `${n} piece${n === 1 ? '' : 's'}`,
    `${elbows} elbow${elbows === 1 ? '' : 's'}`,
  ];
  if (bad) parts.push(`${bad} over length / short stub`);
  return parts.join(' · ');
}

/** Visual collar + plate, scaled from the current duct so it reads at millimetre plant sizes. */
export function flangeDrawDims(state) {
  const duct = Math.max(1, state.ductWidth ?? 180);
  const jacket = Math.max(duct, state.jacketWidth ?? duct);
  const outer = (state.features?.jacket && state.showJacket !== false) ? jacket : duct;
  const ductR = duct / 2;
  const outerR = outer / 2;
  return {
    ductR,
    outerR,
    innerR: ductR + Math.max(2, duct * 0.02),
    plateR: outerR + Math.max(18, duct * 0.16),
    wall: Math.max(3, duct * 0.025),
    plateT: Math.max(4, duct * 0.03),
    collarL: Math.max(16, duct * 0.12),
    holeR: Math.max(3.5, duct * 0.028),
  };
}

/** Per-piece diameters; missing override falls back to the global sliders. */
export function pieceWidths(piece, state) {
  const o = state.pieceOverrides?.[piece?.id] ?? {};
  return {
    ductWidth: Number.isFinite(o.ductWidth) ? o.ductWidth : state.ductWidth,
    jacketWidth: Number.isFinite(o.jacketWidth) ? o.jacketWidth : state.jacketWidth,
  };
}

export function describePiece(piece, state) {
  const { ductWidth, jacketWidth } = pieceWidths(piece, state);
  const theta = piece.kind === 'elbow' ? (piece.theta ?? 0) : 0;
  return {
    id: piece.id,
    kind: piece.kind === 'elbow' ? 'Elbow' : 'Straight',
    lengthMm: piece.length,
    theta,
    sweepLabel: theta > 0 ? `${theta}°` : 'straight',
    ductWidth,
    jacketWidth,
    ok: piece.ok,
    gapKey: piece.gapKey ?? null,
    pieceKind: piece.kind,
  };
}

export function pieceTipHtml(info) {
  if (!info) return '';
  return `<strong>${info.kind}</strong>
    <span>Length ${Math.round(info.lengthMm)} mm</span>
    <span>Arc ${info.theta > 0 ? info.sweepLabel : '0°'}</span>`;
}

export function placePieceTip(el, info, clientX, clientY) {
  if (!el) return;
  if (!info) {
    el.hidden = true;
    return;
  }
  el.innerHTML = pieceTipHtml(info);
  el.hidden = false;
  el.style.left = `${clientX + 14}px`;
  el.style.top = `${clientY + 14}px`;
}

/** Stations along a flange-to-flange piece, for hover hit-testing (R-151). */
export function samplePieceLocs(piece, stepMm = 40) {
  if (!piece?.run || !(piece.length > EPS)) return [];
  const n = Math.max(2, Math.ceil(piece.length / stepMm) + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = piece.s0 + (piece.length * i) / (n - 1);
    out.push({ s, ...locateOnRun(piece.run, s) });
  }
  return out;
}

/** Nearest piece to a point, or null if farther than `threshold` mm. Works in 2D or 3D. */
export function pickPieceAt(pieces, point, poseAlong, threshold) {
  if (!pieces?.length || !point || typeof poseAlong !== 'function') return null;
  let best = null;
  let bestD = threshold;
  for (const piece of pieces) {
    for (const loc of samplePieceLocs(piece)) {
      if (!loc?.seg) continue;
      const pose = poseAlong(loc.seg, loc.local);
      if (!pose) continue;
      const d = Math.hypot(
        pose.x - point.x,
        pose.y - point.y,
        (pose.z ?? 0) - (point.z ?? 0),
      );
      if (d < bestD) {
        bestD = d;
        best = piece;
      }
    }
  }
  return best;
}

export function pickPieceAt2d(pieces, point, poseAlong, threshold) {
  return pickPieceAt(pieces, point, poseAlong, threshold);
}

export function pickPieceAt3d(pieces, point, poseAlong, threshold) {
  return pickPieceAt(pieces, point, poseAlong, threshold);
}

/** How many even pieces to cut a straight into. Always at least 2 so the dropdown can split further. */
export function suggestedSplitCuts(lengthMm, maxPieceMm) {
  return Math.max(2, Math.ceil(lengthMm / maxPieceMm - 1e-9));
}
