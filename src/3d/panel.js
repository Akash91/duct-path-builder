// Side-panel DOM for the 3D builder. Mirrors the 2D table, with z exposed.

import { minRadiusFor } from '../core/solve.js';
import { captureEdit, restoreEdit } from '../core/tableFocus.js';

const n = (v) => Math.round(v * 1000) / 1000;
const mm = (v) => `${v.toFixed(0)} mm`;

const ROUTE_LABEL = {
  straight: 'straight',
  plan: 'plan elbow',
  elev: 'elev elbow',
  rolled: 'rolled elbow',
  angled: 'angled straight',
  cardinal: 'cardinal 90s',
};

function statusTag(incoming) {
  if (!incoming) return '<span class="tag tag--start">start</span>';

  if (incoming.ok && incoming.tooTight) {
    return `<span class="tag tag--warn" title="radius ${mm(incoming.arc.radius)}, needs ${mm(incoming.minRadius)}">${incoming.arc.theta}\u00b0 too tight</span>`;
  }
  if (incoming.ok && incoming.reason === 'elbow-too-long') {
    return `<span class="tag tag--warn">${incoming.arc.theta}\u00b0 over piece length</span>`;
  }
  if (incoming.ok) {
    const route = ROUTE_LABEL[incoming.route] ?? incoming.route;
    const detail = incoming.route === 'angled' ? `${incoming.shop.kickDeg.toFixed(1)}\u00b0 kick`
      : incoming.route === 'rolled' ? `${incoming.arc.theta}\u00b0 rolled ${Math.abs(incoming.roll).toFixed(0)}\u00b0`
        : incoming.arc && !incoming.arc.straight ? `${incoming.arc.theta}\u00b0`
          : '';
    return `<span class="tag tag--ok">${route}${detail ? ` ${detail}` : ''}</span>`;
  }
  if (incoming.reason === 'degenerate') return '<span class="tag tag--err">duplicate</span>';
  if (incoming.reason === 'off-slope') return '<span class="tag tag--err" title="a horizontal run must fall or rise so it drains">off-slope</span>';
  if (incoming.reason === 'compound-bend') return '<span class="tag tag--err" title="moves in Y and Z, and cannot be aimed or split">compound bend</span>';
  return `<span class="tag tag--err" title="${incoming.reason}">off by ${incoming.error.toFixed(1)}\u00b0</span>`;
}

export function renderTable(tbody, state, solution) {
  const editing = captureEdit(tbody);

  if (state.points.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No points yet — use “Add point”.</td></tr>';
    return;
  }

  tbody.innerHTML = state.points
    .map((p, i) => {
      const incoming = solution.segments[i - 1];
      const fixable = incoming && (incoming.tooTight || (!incoming.ok && incoming.reason !== 'degenerate'));

      const axis = (field) =>
        `<td><input class="num num--sm" type="number" step="any" data-field="${field}" data-id="${p.id}" value="${n(p[field])}" aria-label="${field} of point ${i + 1}" /></td>`;

      return `<tr data-id="${p.id}" class="${p.id === state.selectedId ? 'row--selected' : ''}">
        <td class="idx">${i + 1}</td>
        ${axis('x')}${axis('y')}${axis('z')}
        <td class="status">${statusTag(incoming)}${fixable ? `<button class="mini" data-act="fix" data-id="${p.id}" title="Pull onto the nearest cone, at least the minimum bend distance out">fix</button>` : ''}</td>
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

export function renderSummary(el, solution, state) {
  const total = solution.segments.length;
  const bad = solution.errorCount;
  const tight = solution.tightCount;

  if (total === 0) {
    el.textContent = 'Add at least two points to form a segment.';
  } else {
    const parts = [`${total - bad} valid`, `${bad} invalid`, `${tight} too tight`];
    if (state.features.minBendRadius) parts.push(`min radius ${mm(minRadiusFor(state))}`);
    if (state.features.drainSlope) parts.push(`drain floor ${(state.slopeDeg - state.slopeToleranceDeg).toFixed(1)}\u00b0`);
    el.textContent = parts.join(' \u00b7 ');
  }

  el.classList.toggle('summary--bad', bad > 0);
  el.classList.toggle('summary--warn', bad === 0 && tight > 0);
}
