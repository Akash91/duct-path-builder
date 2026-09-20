// Side-panel DOM for the 3D builder. Mirrors the 2D table, with z exposed.

import { minRadiusFor } from '../core/solve.js';
import { flangeOptionsFor, layoutPieces, fabricationDigest } from '../core/flange.js';
import { turnKind } from './geometry.js';

const n = (v) => Math.round(v * 1000) / 1000;

function statusTag(incoming) {
  if (!incoming) return '<span class="tag tag--start">start</span>';

  if (incoming.ok && incoming.legs?.length) {
    const bits = incoming.legs.map((leg) => {
      const kind = turnKind(leg);
      return kind === 'straight' ? 'straight' : `${leg.arc.theta}° ${kind}`;
    });
    const cls = incoming.tooTight ? 'tag--warn' : 'tag--ok';
    const title = incoming.tooTight
      ? `shop elbows are tighter than ${incoming.minRadius.toFixed(0)} mm — table points can still move in y and z; each piece turns in only one plane`
      : 'table points can move in y and z; each shop piece turns in only one plane';
    return `<span class="tag ${cls}" title="${title}">${bits.join(' + ')}</span>`;
  }
  if (incoming.ok && incoming.tooTight) {
    return `<span class="tag tag--warn" title="radius ${incoming.arc.radius.toFixed(0)}, needs ${incoming.minRadius.toFixed(0)}">${incoming.arc.theta}° too tight</span>`;
  }
  if (incoming.ok) {
    const kind = turnKind(incoming);
    return `<span class="tag tag--ok">${kind === 'straight' ? 'straight' : `${incoming.arc.theta}° ${kind}`}</span>`;
  }
  if (incoming.reason === 'degenerate') return '<span class="tag tag--err">duplicate</span>';
  if (incoming.reason === 'off-slope') {
    return `<span class="tag tag--err" title="a horizontal run must rise or fall at least 3° so it can drain either way. Off by ${incoming.error.toFixed(1)}°">too flat</span>`;
  }
  if (incoming.reason === 'compound-bend') {
    return `<span class="tag tag--err" title="a physical elbow turns in plan (Y) or elevation (Z), not both. This span could not be auto-routed into planar shop pieces (the target is behind the incoming tangent). Fix keeps the nearer plane. Off a cardinal by ${incoming.planeError.toFixed(1)}°">y and z together</span>`;
  }
  return `<span class="tag tag--err">off by ${incoming.error.toFixed(1)}°</span>`;
}

export function renderTable(tbody, state, solution) {
  if (state.points.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No points yet — use “Add point”.</td></tr>';
    return;
  }

  tbody.innerHTML = state.points
    .map((p, i) => {
      const incoming = solution.segments[i - 1];
      const fixable = incoming && (incoming.tooTight || (!incoming.ok && incoming.reason !== 'degenerate'));

      const axis = (field) =>
        `<td><input class="num num--sm" type="number" step="1" data-field="${field}" data-id="${p.id}" value="${n(p[field])}" aria-label="${field} of point ${i + 1}" /></td>`;

      return `<tr data-id="${p.id}" class="${p.id === state.selectedId ? 'row--selected' : ''}">
        <td class="idx">${i + 1}</td>
        ${axis('x')}${axis('y')}${axis('z')}
        <td class="status">${statusTag(incoming)}${fixable ? `<button class="mini" data-act="fix" data-id="${p.id}" title="Pull onto the nearest plan or elevation cone">fix</button>` : ''}</td>
        <td class="actions">
          <button class="mini" data-act="up" data-id="${p.id}" title="Move up">↑</button>
          <button class="mini" data-act="down" data-id="${p.id}" title="Move down">↓</button>
          <button class="mini mini--danger" data-act="del" data-id="${p.id}" title="Delete">✕</button>
        </td>
      </tr>`;
    })
    .join('');
}

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
    const compound = solution.segments.filter((s) => s.reason === 'compound-bend').length;
    const flat = solution.segments.filter((s) => s.reason === 'off-slope').length;
    const split = solution.segments.filter((s) => s.legs?.length).length;
    if (compound > 0) parts.push(`${compound} turn in y and z`);
    if (flat > 0) parts.push(`${flat} too flat to drain`);
    if (split > 0) parts.push(`${split} split into plan/elev`);
    if (tight > 0) parts.push(`${tight} too tight to bend`);
    if (state.features.minBendRadius) parts.push(`min radius ${minRadiusFor(state).toFixed(0)} mm`);
    if (digest) parts.push(digest);
    el.textContent = parts.join(' · ');
  }

  el.classList.toggle('summary--bad', bad > 0);
  el.classList.toggle('summary--warn', bad === 0 && (tight > 0 || laid.errors.length > 0));
}
