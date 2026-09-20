import { DEG, legalBearings, minChordFor, poseAlong, expandRun } from './geometry.js';
import { tangentAt, minRadiusFor, validRuns } from '../core/solve.js';
import {
  flangeOptionsFor, layoutPieces, fabricationDigest, flangeDrawDims, poseOnRun,
  pickPieceAt2d, samplePieceLocs,
} from '../core/flange.js';
import { POINT_DOT_R, POINT_HIT_R, POINT_MARKER_R, ORIGIN } from '../core/view.js';

const GUIDE_LENGTH = 4000;

const n = (v) => Math.round(v * 1000) / 1000;

/** The command that draws a segment, without the leading `M` (R-02 / N-02). */
function segCommand(seg) {
  const { to, arc } = seg;
  if (arc.straight) return `L ${n(to.x)} ${n(to.y)}`;
  return `A ${n(arc.radius)} ${n(arc.radius)} 0 ${arc.largeArcFlag} ${arc.sweepFlag} ${n(to.x)} ${n(to.y)}`;
}

/** SVG `A` command, or `L` when the sweep is 0 and the radius is infinite. */
export function arcPathD(seg) {
  return `M ${n(seg.from.x)} ${n(seg.from.y)} ${segCommand(seg)}`;
}

/** One `d` for a whole run: a single `M`, then one command per segment. */
function runPathD(run) {
  return `M ${n(run[0].from.x)} ${n(run[0].from.y)} ${run.map(segCommand).join(' ')}`;
}

/** Turn direction glyph; a straight run has no handedness. */
const turnGlyph = (arc) => (arc.straight ? '' : arc.dir > 0 ? ' ↻' : ' ↺');

const chordPathD = (seg) => `M ${n(seg.from.x)} ${n(seg.from.y)} L ${n(seg.to.x)} ${n(seg.to.y)}`;

/**
 * A concentric band around the centerline, drawn as a stroke (R-31, R-33, R-34, R-38).
 * Each run is one path so the flat caps land only on the genuinely open ends (R-35); drawing
 * per-segment would notch the outside of every joint.
 */
function renderBand(runs, cls, width) {
  return runs
    .map((run) => `<path class="${cls}" d="${runPathD(run)}" stroke-width="${n(width)}" />`)
    .join('');
}

function renderCenterline(solution, shopRuns, flangesOn) {
  const errors = solution.segments
    .map((s) => {
      if (s.ok || s.reason === 'degenerate') return '';
      return `<path class="seg seg--error" data-seg="${s.index}" d="${chordPathD(s)}" />`;
    })
    .join('');

  if (!flangesOn) {
    const ok = solution.segments
      .map((s) => {
        if (!s.ok) return '';
        const cls = s.tooTight ? 'seg seg--tight' : 'seg seg--ok';
        return `<path class="${cls}" data-seg="${s.index}" d="${arcPathD(s)}" />`;
      })
      .join('');
    return ok + errors;
  }

  const shop = (shopRuns ?? [])
    .map((run) => run
      .map((s) => {
        const cls = s.tooTight ? 'seg seg--tight' : 'seg seg--ok';
        return `<path class="${cls}" data-seg="${s.index}" d="${arcPathD(s)}" />`;
      })
      .join(''))
    .join('');
  return shop + errors;
}

function marker(s, cls, glyph, title) {
  const mx = (s.from.x + s.to.x) / 2;
  const my = (s.from.y + s.to.y) / 2;
  return `<g class="${cls}" transform="translate(${n(mx)} ${n(my)})">
    <circle r="${POINT_MARKER_R}" />
    <text y="4">${glyph}</text>
    <title>${title}</title>
  </g>`;
}

/** Markers for both failure modes: unreachable bearing, and legal but unbendable (R-23, R-62). */
function renderMarkers(solution) {
  return solution.segments
    .map((s) => {
      if (s.tooTight) {
        return marker(s, 'tight-marker', '◠',
          `Segment ${s.index + 1}: radius ${s.arc.radius.toFixed(0)} is below the ${s.minRadius.toFixed(0)} needed; move the point at least ${s.minChord.toFixed(0)} out`);
      }
      if (!s.ok && s.reason !== 'degenerate') {
        return marker(s, 'err-marker', '!',
          `Segment ${s.index + 1}: off nearest legal bearing by ${s.error.toFixed(2)}°`);
      }
      return '';
    })
    .join('');
}

/**
 * Six ghost rays from the anchor point (R-20). Their existence is the whole point of §3.2:
 * the next point may sit anywhere along one of these, at any distance.
 */
function renderGuides(state, solution, anchorIndex) {
  if (!state.features.guideRays || !state.showGuides || anchorIndex < 0 || anchorIndex >= state.points.length) return '';

  const anchor = state.points[anchorIndex];
  const tau = tangentAt(solution, anchorIndex, state.initialHeading);
  const minRadius = minRadiusFor(state);

  const rays = legalBearings(tau)
    .map(({ theta, dir, bearing }) => {
      const rad = bearing * DEG;
      const ux = Math.cos(rad);
      const uy = Math.sin(rad);
      // The stretch nearer than this cannot be bent by a band of the current width (R-63).
      const blocked = Math.min(minChordFor(theta, minRadius), GUIDE_LENGTH);

      const stub = blocked > 0
        ? `<line class="guide guide--blocked" x1="${n(anchor.x)}" y1="${n(anchor.y)}" x2="${n(anchor.x + blocked * ux)}" y2="${n(anchor.y + blocked * uy)}" />`
        : '';

      const open = `<line class="guide" x1="${n(anchor.x + blocked * ux)}" y1="${n(anchor.y + blocked * uy)}" x2="${n(anchor.x + GUIDE_LENGTH * ux)}" y2="${n(anchor.y + GUIDE_LENGTH * uy)}" />`;

      const ld = Math.max(240, blocked + 90);
      const label = theta === 0 ? 'straight' : `${theta}°${dir > 0 ? '↻' : '↺'}`;
      const text = `<text class="guide-label" x="${n(anchor.x + ld * ux)}" y="${n(anchor.y + ld * uy)}">${label}</text>`;

      return stub + open + text;
    })
    .join('');

  const tx = anchor.x + 400 * Math.cos(tau * DEG);
  const ty = anchor.y + 400 * Math.sin(tau * DEG);
  const tangent = `<line class="guide-tangent" x1="${n(anchor.x)}" y1="${n(anchor.y)}" x2="${n(tx)}" y2="${n(ty)}" />`;

  return tangent + rays;
}

function renderPoints(state) {
  return state.points
    .map((p, i) => {
      const cls = ['pt', p.id === state.selectedId ? 'pt--selected' : ''].join(' ').trim();
      return `<g class="${cls}" data-id="${p.id}">
        <circle class="pt-hit" cx="${n(p.x)}" cy="${n(p.y)}" r="${POINT_HIT_R}" />
        <circle class="pt-dot" cx="${n(p.x)}" cy="${n(p.y)}" r="${POINT_DOT_R}" />
        <text class="pt-label" x="${n(p.x) + 10}" y="${n(p.y) - 8}">${i + 1}</text>
      </g>`;
    })
    .join('');
}

function flangeMark(pose, dims, kind, err) {
  const a = pose.tangentDeg * DEG;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const px = -uy;
  const py = ux;
  const { x, y } = pose;
  const R = dims.plateR;
  const c = dims.collarL / 2;
  const ir = dims.innerR;
  const cls = err ? 'flange flange--err' : 'flange';
  const plate = `M ${n(x - px * R)} ${n(y - py * R)} L ${n(x + px * R)} ${n(y + py * R)}`;
  const collar = [
    `M ${n(x - ux * c - px * ir)} ${n(y - uy * c - py * ir)} L ${n(x + ux * c - px * ir)} ${n(y + uy * c - py * ir)}`,
    `M ${n(x - ux * c + px * ir)} ${n(y - uy * c + py * ir)} L ${n(x + ux * c + px * ir)} ${n(y + uy * c + py * ir)}`,
  ].join(' ');
  return `<g class="${cls}">
    <title>${kind} flange</title>
    <path class="flange-plate" d="${plate}" />
    <path class="flange-collar" d="${collar}" />
  </g>`;
}

function renderFlanges(state, solution, spatial) {
  const options = flangeOptionsFor(state);
  if (!options) return '';
  const laid = layoutPieces(solution, options);
  const dims = flangeDrawDims(state);
  const badStations = new Set(
    laid.errors.flatMap((e) => [e.piece.s0, e.piece.s1].map((s) => s.toFixed(3))),
  );
  return laid.flanges
    .map((f) => {
      const pose = poseOnRun(spatial(f.run), f.s, poseAlong);
      if (!pose) return '';
      const err = badStations.has(f.s.toFixed(3));
      return flangeMark(pose, dims, f.kind, err);
    })
    .join('');
}

function renderOrigin() {
  const s = 36;
  return `<g class="origin" pointer-events="none">
    <line x1="${ORIGIN.x - s}" y1="${ORIGIN.y}" x2="${ORIGIN.x + s}" y2="${ORIGIN.y}" />
    <line x1="${ORIGIN.x}" y1="${ORIGIN.y - s}" x2="${ORIGIN.x}" y2="${ORIGIN.y + s}" />
    <circle cx="${ORIGIN.x}" cy="${ORIGIN.y}" r="3" />
    <text x="${ORIGIN.x + 8}" y="${ORIGIN.y - 8}">0,0</text>
  </g>`;
}

function spatialFor(state) {
  const options = flangeOptionsFor(state);
  const cache = new Map();
  return (run) => {
    if (!options || !run) return run;
    if (!cache.has(run)) cache.set(run, expandRun(run, options));
    return cache.get(run);
  };
}

export function hoverPieces(state, solution) {
  const options = flangeOptionsFor(state);
  const laid = layoutPieces(solution, options);
  const spatial = spatialFor(state);
  return laid.pieces.map((p) => ({ ...p, run: spatial(p.run) }));
}

export function hitPiece(state, solution, point) {
  const threshold = Math.max(state.ductWidth, state.jacketWidth) / 2 + 24;
  return pickPieceAt2d(hoverPieces(state, solution), point, poseAlong, threshold);
}

export function highlightHoveredPiece(layer, piece) {
  if (!layer) return;
  if (!piece) {
    layer.innerHTML = '';
    return;
  }
  const cmds = [];
  for (const loc of samplePieceLocs(piece, 16)) {
    if (!loc?.seg) continue;
    const pose = poseAlong(loc.seg, loc.local);
    if (!pose) continue;
    cmds.push(`${cmds.length ? 'L' : 'M'} ${n(pose.x)} ${n(pose.y)}`);
  }
  layer.innerHTML = cmds.length ? `<path class="piece-hit" d="${cmds.join(' ')}" />` : '';
}

export function renderCanvas(layers, state, solution, anchorIndex) {
  const options = flangeOptionsFor(state);
  const solverRuns = validRuns(solution);
  const spatial = spatialFor(state);
  const runs = options ? solverRuns.map((run) => spatial(run)) : solverRuns;

  layers.jacket.innerHTML = state.features.jacket && state.showJacket ? renderBand(runs, 'jacket', state.jacketWidth) : '';
  layers.duct.innerHTML = state.features.duct && state.showDuct ? renderBand(runs, 'duct', state.ductWidth) : '';
  layers.path.innerHTML = renderCenterline(solution, runs, Boolean(options));
  if (layers.flanges) layers.flanges.innerHTML = renderFlanges(state, solution, spatial);
  if (layers.hover) layers.hover.innerHTML = '';
  layers.guides.innerHTML = renderOrigin() + renderGuides(state, solution, anchorIndex);
  layers.markers.innerHTML = renderMarkers(solution);
  layers.points.innerHTML = renderPoints(state);
}

export function renderTable(tbody, state, solution) {
  if (state.points.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No points yet — use “Add point”.</td></tr>';
    return;
  }

  tbody.innerHTML = state.points
    .map((p, i) => {
      const incoming = solution.segments[i - 1];
      let status = '<span class="tag tag--start">start</span>';
      if (incoming) {
        if (incoming.ok && incoming.tooTight) {
          status = `<span class="tag tag--warn" title="radius ${incoming.arc.radius.toFixed(0)}, needs ${incoming.minRadius.toFixed(0)}">${incoming.arc.theta}° too tight</span>`;
        } else if (incoming.ok) {
          status = `<span class="tag tag--ok">${incoming.arc.straight ? 'straight' : `${incoming.arc.theta}°${turnGlyph(incoming.arc)}`}</span>`;
        } else if (incoming.reason === 'degenerate') {
          status = '<span class="tag tag--err">duplicate</span>';
        } else {
          status = `<span class="tag tag--err">off by ${incoming.error.toFixed(1)}°</span>`;
        }
      }

      const fixable = incoming && (incoming.tooTight || (!incoming.ok && incoming.reason !== 'degenerate'));
      const fix = fixable
        ? `<button class="mini" data-act="fix" data-id="${p.id}" title="Move onto the nearest legal ray, at least the minimum bend distance out">fix</button>`
        : '';

      return `<tr data-id="${p.id}" class="${p.id === state.selectedId ? 'row--selected' : ''}">
        <td class="idx">${i + 1}</td>
        <td><input class="num" type="number" step="1" data-field="x" data-id="${p.id}" value="${n(p.x)}" aria-label="x of point ${i + 1}" /></td>
        <td><input class="num" type="number" step="1" data-field="y" data-id="${p.id}" value="${n(p.y)}" aria-label="y of point ${i + 1}" /></td>
        <td class="status">${status}${fix}</td>
        <td class="actions">
          <button class="mini" data-act="up" data-id="${p.id}" title="Move up">↑</button>
          <button class="mini" data-act="down" data-id="${p.id}" title="Move down">↓</button>
          <button class="mini mini--danger" data-act="del" data-id="${p.id}" title="Delete">✕</button>
        </td>
      </tr>`;
    })
    .join('');
}

export { runPathD };

export function renderSummary(el, solution, state) {
  const total = solution.segments.length;
  const bad = solution.errorCount;
  const tight = solution.tightCount;
  const laid = layoutPieces(solution, flangeOptionsFor(state));
  const digest = fabricationDigest(laid);

  if (total === 0) {
    el.textContent = 'Add at least two points to form a segment.';
  } else {
    const parts = [`${total - bad}/${total} segments valid`];
    if (tight > 0) parts.push(`${tight} too tight to bend`);
    parts.push(`exit tangent ${solution.tangentOut.toFixed(1)}°`);
    if (state.features.minBendRadius) parts.push(`min radius ${minRadiusFor(state).toFixed(0)} mm`);
    if (digest) parts.push(digest);
    el.textContent = parts.join(' · ');
  }

  el.classList.toggle('summary--bad', bad > 0);
  el.classList.toggle('summary--warn', bad === 0 && (tight > 0 || laid.errors.length > 0));
}
