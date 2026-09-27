import { DEG, legalBearings, minChordFor, expandRun } from './geometry.js';
import { tangentAt, minRadiusFor, validRuns, shopOptions } from '../core/solve.js';
import { layoutPieces, pieceLabel } from '../core/pieces.js';
import { cumulative, stationAt, slice } from '../core/polyline.js';
import { captureEdit, restoreEdit } from '../core/tableFocus.js';

const GUIDE_LENGTH = 6000;

// Drawing unit for pins, labels and hairlines. Derived from the band diameter rather than the
// zoom, so pan and zoom stay pure viewBox changes and never re-render the path.
let k = 1;
const unitFor = (state) => Math.max(state.ductWidth, state.jacketWidth, 60) / 60;

const n = (v) => Math.round(v * 1000) / 1000;
const mm = (v) => `${v.toFixed(0)} mm`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

/**
 * A `d` walked along the shop centerline. Straight chords and circular arcs only — no spline is
 * fitted through the samples, which would bulge around a table point sitting on a tangent.
 */
const polyPathD = (points) =>
  points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${n(p.x)} ${n(p.y)}`).join(' ');

/** Turn direction glyph; a straight run has no handedness. */
const turnGlyph = (arc) => (arc.straight ? '' : arc.dir > 0 ? ' \u21bb' : ' \u21ba');

const chordPathD = (seg) => `M ${n(seg.from.x)} ${n(seg.from.y)} L ${n(seg.to.x)} ${n(seg.to.y)}`;

/** Every valid run, expanded once into the geometry the shop would actually build. */
function shopRuns(solution) {
  return validRuns(solution).map((run) => {
    const { points, stretches } = expandRun(run);
    return { run, points, stretches, cum: cumulative(points) };
  });
}

/**
 * A concentric band around the shop centerline, drawn as a stroke (R-31, R-33, R-34, R-38).
 * Each run is one path so the flat caps land only on the genuinely open ends (R-35); drawing
 * per-segment would notch the outside of every joint.
 */
function renderBand(runs, cls, width) {
  return runs
    .map((r) => `<path class="${cls}" d="${polyPathD(r.points)}" stroke-width="${n(width)}" />`)
    .join('');
}

/**
 * The centerline, stretch by stretch, so the amber circular middle of an elbow reads against
 * the plain runs on either side of it.
 */
function renderCenterline(solution, runs) {
  const shop = runs
    .flatMap((r) => r.stretches.map((st) => {
      const seg = solution.segments[st.segIndex];
      const cls = st.kind === 'elbow' ? 'seg seg--elbow'
        : st.kind === 'kick' ? 'seg seg--kick'
          : seg?.tooTight ? 'seg seg--tight' : 'seg seg--ok';
      return `<path class="${cls}" data-seg="${st.segIndex}" stroke-width="${n(2.5 * k)}" d="${polyPathD(st.points)}" />`;
    }))
    .join('');

  const bad = solution.segments
    .filter((s) => !s.ok && s.reason !== 'degenerate')
    .map((s) => `<path class="seg seg--error" data-seg="${s.index}" stroke-width="${n(2 * k)}" stroke-dasharray="${n(7 * k)} ${n(6 * k)}" d="${chordPathD(s)}" />`)
    .join('');

  return shop + bad;
}

/**
 * A flange is a collar plus a plate, not a torus: edge-on here, an open cylinder and a ring in
 * 3D. Both views put it at the same station and give it the same diameter.
 */
function renderFlanges(state, runs, pieces) {
  if (!state.features.flanges || !state.showFlanges) return '';

  // The flange bolts to the duct and sits under the insulation, so the jacket does not size it.
  const outer = state.features.duct ? state.ductWidth : state.jacketWidth;
  const half = (outer * 1.2) / 2;
  const collar = 22;
  const out = [];

  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const stations = new Set([0]);
    for (const piece of pieces) {
      if (piece.runIndex !== i) continue;
      stations.add(piece.start);
      stations.add(piece.end);
    }

    for (const s of stations) {
      const at = stationAt(r.points, s, r.cum);
      if (!at) continue;
      const { point, tangent } = at;
      const px = -tangent.y;
      const py = tangent.x;
      // Plate edge-on, then the collar running back along the duct.
      const plate = `<line class="flange-plate" stroke-width="${n(Math.max(outer * 0.05, 2 * k))}" x1="${n(point.x - px * half)}" y1="${n(point.y - py * half)}" x2="${n(point.x + px * half)}" y2="${n(point.y + py * half)}" />`;
      const lip = [1, -1].map((k2) => {
        const ox = px * k2 * (outer / 2);
        const oy = py * k2 * (outer / 2);
        return `<line class="flange-collar" stroke-width="${n(Math.max(outer * 0.03, k))}" x1="${n(point.x + ox)}" y1="${n(point.y + oy)}" x2="${n(point.x + ox - tangent.x * collar)}" y2="${n(point.y + oy - tangent.y * collar)}" />`;
      }).join('');
      out.push(plate + lip);
    }
  }
  return out.join('');
}

/** Invisible fat strokes so hovering a piece reports its flange-to-flange length and bend. */
function renderPieceHits(state, runs, pieces, selectedIndex) {
  const width = Math.max(state.ductWidth, 60);
  return pieces
    .map((piece) => {
      const r = runs[piece.runIndex];
      if (!r) return '';
      const pts = slice(r.points, piece.start, piece.end, r.cum);
      const cls = `piece-hit${piece.index === selectedIndex ? ' piece-hit--selected' : ''}`;
      return `<path class="${cls}" data-piece="${piece.index}" stroke-width="${n(width)}" d="${polyPathD(pts)}"><title>${esc(pieceLabel(piece))}</title></path>`;
    })
    .join('');
}

function marker(s, cls, glyph, title) {
  const mx = (s.from.x + s.to.x) / 2;
  const my = (s.from.y + s.to.y) / 2;
  return `<g class="${cls}" transform="translate(${n(mx)} ${n(my)})">
    <circle r="${n(11 * k)}" />
    <text y="${n(4 * k)}" font-size="${n(14 * k)}">${glyph}</text>
    <title>${title}</title>
  </g>`;
}

/** Markers for both failure modes: unreachable bearing, and legal but unbendable (R-23, R-62). */
function renderMarkers(solution) {
  return solution.segments
    .map((s) => {
      if (s.tooTight) {
        return marker(s, 'tight-marker', '\u25e0',
          `Segment ${s.index + 1}: radius ${mm(s.arc.radius)} is below the ${mm(s.minRadius)} needed; move the point at least ${mm(s.minChord)} out`);
      }
      if (!s.ok && s.reason !== 'degenerate') {
        return marker(s, 'err-marker', '!',
          `Segment ${s.index + 1}: ${s.reason} \u2014 off nearest legal bearing by ${s.error.toFixed(2)}\u00b0`);
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
        ? `<line class="guide guide--blocked" stroke-width="${n(k)}" stroke-dasharray="${n(2 * k)} ${n(4 * k)}" x1="${n(anchor.x)}" y1="${n(anchor.y)}" x2="${n(anchor.x + blocked * ux)}" y2="${n(anchor.y + blocked * uy)}" />`
        : '';

      const open = `<line class="guide" stroke-width="${n(k)}" stroke-dasharray="${n(3 * k)} ${n(5 * k)}" x1="${n(anchor.x + blocked * ux)}" y1="${n(anchor.y + blocked * uy)}" x2="${n(anchor.x + GUIDE_LENGTH * ux)}" y2="${n(anchor.y + GUIDE_LENGTH * uy)}" />`;

      const ld = Math.max(74 * k, blocked + 30 * k);
      const label = theta === 0 ? 'straight' : `${theta}\u00b0${dir > 0 ? '\u21bb' : '\u21ba'}`;
      const text = `<text class="guide-label" font-size="${n(10 * k)}" x="${n(anchor.x + ld * ux)}" y="${n(anchor.y + ld * uy)}">${label}</text>`;

      const tip = blocked > 0 ? `<title>${theta}\u00b0: no closer than ${mm(blocked)}</title>` : '';
      return stub + open + text + tip;
    })
    .join('');

  const tx = anchor.x + 130 * k * Math.cos(tau * DEG);
  const ty = anchor.y + 130 * k * Math.sin(tau * DEG);
  const tangent = `<line class="guide-tangent" stroke-width="${n(1.5 * k)}" x1="${n(anchor.x)}" y1="${n(anchor.y)}" x2="${n(tx)}" y2="${n(ty)}" />`;

  return tangent + rays;
}

/** Pins, not a second duct: the drawn dot stays well under the band diameter. */
function renderPoints(state) {
  const cap = Math.max(state.ductWidth, state.jacketWidth) * 0.2;
  const dot = Math.min(6 * k, cap / 2);

  return state.points
    .map((p, i) => {
      const cls = ['pt', p.id === state.selectedId ? 'pt--selected' : ''].join(' ').trim();
      return `<g class="${cls}" data-id="${p.id}">
        <circle class="pt-hit" cx="${n(p.x)}" cy="${n(p.y)}" r="${n(18 * k)}" />
        <circle class="pt-dot" cx="${n(p.x)}" cy="${n(p.y)}" r="${n(dot)}" stroke-width="${n(2.5 * k)}" />
        <text class="pt-label" font-size="${n(11 * k)}" x="${n(p.x + 12 * k)}" y="${n(p.y - 10 * k)}">${i + 1}</text>
      </g>`;
    })
    .join('');
}

export function renderCanvas(layers, state, solution, anchorIndex) {
  k = unitFor(state);
  const runs = shopRuns(solution);
  const { pieces } = layoutPieces(solution, shopOptions(state));

  layers.jacket.innerHTML = state.features.jacket && state.showJacket ? renderBand(runs, 'jacket', state.jacketWidth) : '';
  layers.duct.innerHTML = state.features.duct && state.showDuct ? renderBand(runs, 'duct', state.ductWidth) : '';
  layers.flanges.innerHTML = renderFlanges(state, runs, pieces);
  layers.path.innerHTML = renderCenterline(solution, runs);
  layers.guides.innerHTML = renderGuides(state, solution, anchorIndex);
  layers.markers.innerHTML = renderMarkers(solution);
  layers.points.innerHTML = renderPoints(state);
  layers.pieces.innerHTML = renderPieceHits(state, runs, pieces, state.selectedPieceIndex);

  return pieces;
}

export function renderTable(tbody, state, solution) {
  const editing = captureEdit(tbody);

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
          status = `<span class="tag tag--warn" title="radius ${mm(incoming.arc.radius)}, needs ${mm(incoming.minRadius)}">${incoming.arc.theta}\u00b0 too tight</span>`;
        } else if (incoming.ok && incoming.reason === 'elbow-too-long') {
          status = `<span class="tag tag--warn">${incoming.arc.theta}\u00b0 over piece length</span>`;
        } else if (incoming.ok) {
          status = `<span class="tag tag--ok">${incoming.arc.straight ? 'straight' : `${incoming.arc.theta}\u00b0${turnGlyph(incoming.arc)}`}</span>`;
        } else if (incoming.reason === 'degenerate') {
          status = '<span class="tag tag--err">duplicate</span>';
        } else {
          status = `<span class="tag tag--err" title="${incoming.reason}">off by ${incoming.error.toFixed(1)}\u00b0</span>`;
        }
      }

      const fixable = incoming && (incoming.tooTight || (!incoming.ok && incoming.reason !== 'degenerate'));
      const fix = fixable
        ? `<button class="mini" data-act="fix" data-id="${p.id}" title="Move onto the nearest legal ray, at least the minimum bend distance out">fix</button>`
        : '';

      return `<tr data-id="${p.id}" class="${p.id === state.selectedId ? 'row--selected' : ''}">
        <td class="idx">${i + 1}</td>
        <td><input class="num" type="number" step="any" data-field="x" data-id="${p.id}" value="${n(p.x)}" aria-label="x of point ${i + 1}" /></td>
        <td><input class="num" type="number" step="any" data-field="y" data-id="${p.id}" value="${n(p.y)}" aria-label="y of point ${i + 1}" /></td>
        <td class="status">${status}${fix}</td>
        <td class="actions">
          <button class="mini" data-act="up" data-id="${p.id}" title="Move up">↑</button>
          <button class="mini" data-act="down" data-id="${p.id}" title="Move down">↓</button>
          <button class="mini mini--danger" data-act="del" data-id="${p.id}" title="Delete">✕</button>
        </td>
      </tr>`;
    })
    .join('');

  restoreEdit(tbody, editing);
}

export { runPathD };

export function renderSummary(el, solution, state) {
  const total = solution.segments.length;
  const bad = solution.errorCount;
  const tight = solution.tightCount;

  if (total === 0) {
    el.textContent = 'Add at least two points to form a segment.';
  } else {
    const parts = [`${total - bad} valid`, `${bad} invalid`, `${tight} too tight`];
    parts.push(`exit tangent ${solution.tangentOut.toFixed(1)}\u00b0`);
    if (state.features.minBendRadius) parts.push(`min radius ${mm(minRadiusFor(state))}`);
    el.textContent = parts.join(' \u00b7 ');
  }

  el.classList.toggle('summary--bad', bad > 0);
  el.classList.toggle('summary--warn', bad === 0 && tight > 0);
}
