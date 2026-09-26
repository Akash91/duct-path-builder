// The duct-pieces panel. Shared by both stages because the piece list is a read of the path,
// not a property of the view. Choosing a piece never adds a table point.

import { pieceLabel } from './pieces.js';

const mm = (v) => `${v.toFixed(0)} mm`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderPieces(els, pieces, selectedIndex = 0) {
  if (pieces.length === 0) {
    els.select.innerHTML = '<option>—</option>';
    els.detail.textContent = 'No buildable pieces yet.';
    if (els.split) els.split.disabled = true;
    return;
  }

  const index = Math.min(Math.max(selectedIndex, 0), pieces.length - 1);
  els.select.innerHTML = pieces
    .map((p, i) => `<option value="${i}"${i === index ? ' selected' : ''}>${i + 1}. ${esc(pieceLabel(p))}</option>`)
    .join('');

  const piece = pieces[index];
  const total = pieces.reduce((sum, p) => sum + p.length, 0);
  els.detail.textContent = `${pieces.length} pieces · ${mm(total)} total · this one spans ${mm(piece.start)} to ${mm(piece.end)} along its run.`;
  if (els.split) els.split.disabled = piece.kind !== 'straight';
}
