// Side-panel DOM for the 3D builder. Mirrors the 2D table, with z exposed.

import { minRadiusFor } from '../core/solve.js';

const n = (v) => Math.round(v * 1000) / 1000;

function statusTag(incoming) {
  if (!incoming) return '<span class="tag tag--start">start</span>';

  if (incoming.ok && incoming.tooTight) {
    return `<span class="tag tag--warn" title="radius ${incoming.arc.radius.toFixed(0)}, needs ${incoming.minRadius.toFixed(0)}">${incoming.arc.theta}° too tight</span>`;
  }
  if (incoming.ok) {
    return `<span class="tag tag--ok">${incoming.arc.straight ? 'straight' : `${incoming.arc.theta}° cone`}</span>`;
  }
  if (incoming.reason === 'degenerate') return '<span class="tag tag--err">duplicate</span>';
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
        <td class="status">${statusTag(incoming)}${fixable ? `<button class="mini" data-act="fix" data-id="${p.id}" title="Pull onto the nearest cone, at least the minimum bend distance out">fix</button>` : ''}</td>
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

  if (total === 0) {
    el.textContent = 'Add at least two points to form a segment.';
  } else {
    const parts = [`${total - bad}/${total} segments valid`];
    if (tight > 0) parts.push(`${tight} too tight to bend`);
    if (state.features.minBendRadius) parts.push(`min radius ${minRadiusFor(state).toFixed(0)}`);
    el.textContent = parts.join(' · ');
  }

  el.classList.toggle('summary--bad', bad > 0);
  el.classList.toggle('summary--warn', bad === 0 && tight > 0);
}
