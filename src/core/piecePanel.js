import { pieceWidths, suggestedSplitCuts } from './flange.js';

export function pieceLabel(piece, index) {
  const kind = piece.kind === 'elbow' ? 'Elbow' : 'Straight';
  const flag = piece.ok ? '' : (piece.reason === 'short-stub' ? ' · short stub' : ' · too long');
  return `${index + 1}. ${kind} · ${Math.round(piece.length)} mm${flag}`;
}

/** Pure model for the piece dropdown card, so tests do not need a DOM. */
export function pieceDetailModel(piece, state) {
  if (!piece) return { empty: true, canSplit: false, splitCuts: 0 };

  const max = state.maxPieceLengthMm ?? 1050;
  const { ductWidth, jacketWidth } = pieceWidths(piece, state);
  const kind = piece.kind === 'elbow' ? 'Elbow' : 'Straight';
  const over = state.pieceOverrides?.[piece.id];
  const hasOverride = Number.isFinite(over?.ductWidth) || Number.isFinite(over?.jacketWidth);

  let warn = null;
  let canSplit = false;
  let splitCuts = 0;

  if (piece.kind === 'elbow' && !piece.ok) {
    warn = piece.reason === 'short-stub'
      ? `This elbow needs ${state.flangeBendOffsetMm ?? 60} mm of straight each side of the arc.`
      : `This elbow is ${Math.round(piece.length)} mm even as a compact fitting, longer than the ${max} mm maximum. An elbow cannot be split along the bend.`;
  } else if (piece.kind === 'straight') {
    canSplit = Boolean(piece.gapKey) && piece.length > 1;
    splitCuts = canSplit ? suggestedSplitCuts(piece.length, max) : 0;
    if (!piece.ok) {
      warn = `This piece is ${Math.round(piece.length)} mm, longer than the ${max} mm maximum. Split it into ${splitCuts} duct segments.`;
    }
  }

  return {
    empty: false,
    id: piece.id,
    kind,
    lengthMm: piece.length,
    ductWidth,
    jacketWidth,
    hasOverride,
    warn,
    canSplit,
    splitCuts,
    gapKey: piece.gapKey ?? null,
  };
}

function detailHtml(piece, state) {
  const model = pieceDetailModel(piece, state);
  if (model.empty) return '<p class="piece-empty">No duct pieces on this path yet.</p>';

  const showJacket = Boolean(state.features?.jacket);
  const warn = model.warn
    ? `<p class="piece-warn">${model.warn}</p>`
    : '';
  const splitBtn = model.canSplit
    ? `<button type="button" class="btn" data-piece-act="split" data-gap-key="${model.gapKey}" data-cuts="${model.splitCuts}">Split into ${model.splitCuts}</button>`
    : '';

  const jacketField = showJacket
    ? `<label class="ctl">
        <span>Jacket Ø <em>${model.jacketWidth} mm</em></span>
        <input class="num" type="number" min="20" max="2000" step="1" data-piece-field="jacketWidth" data-piece-id="${model.id}" value="${model.jacketWidth}" aria-label="jacket diameter of this piece" />
      </label>`
    : '';

  const foot = model.hasOverride
    ? `<button type="button" class="btn" data-piece-act="reset" data-piece-id="${model.id}">Use global diameters</button>`
    : '<p class="ctl-note">Global sliders set the default. Changing these values applies only to this piece.</p>';

  return `<dl class="piece-meta">
      <div><dt>Kind</dt><dd>${model.kind}</dd></div>
      <div><dt>Length</dt><dd>${Math.round(model.lengthMm)} mm</dd></div>
    </dl>
    ${warn}
    ${splitBtn}
    <label class="ctl">
      <span>Duct Ø <em>${model.ductWidth} mm</em></span>
      <input class="num" type="number" min="20" max="1200" step="1" data-piece-field="ductWidth" data-piece-id="${model.id}" value="${model.ductWidth}" aria-label="duct diameter of this piece" />
    </label>
    ${jacketField}
    ${foot}`;
}

/** Fill the shared piece dropdown and detail card without stealing focus from an open control. */
export function renderPiecePanel(selectEl, detailEl, digestEl, state, pieces) {
  if (!selectEl || !detailEl) return;

  const html = pieces.length
    ? pieces.map((p, i) => `<option value="${p.id}">${pieceLabel(p, i)}</option>`).join('')
    : '<option value="">No pieces yet</option>';

  const sig = pieces.map((p) => `${p.id}:${p.length.toFixed(1)}:${p.ok ? 1 : 0}`).join('|');
  if (selectEl.dataset.sig !== sig && document.activeElement !== selectEl) {
    selectEl.innerHTML = html;
    selectEl.dataset.sig = sig;
  }

  const selected = pieces.find((p) => p.id === state.selectedPieceId);
  const piece = selected || pieces[0] || null;
  if (piece && selectEl.value !== piece.id && document.activeElement !== selectEl) {
    selectEl.value = piece.id;
  }

  const typing = detailEl.contains(document.activeElement)
    && document.activeElement.matches('input');
  if (!typing) detailEl.innerHTML = detailHtml(piece, state);

  if (digestEl) {
    const i = piece ? pieces.findIndex((p) => p.id === piece.id) : -1;
    digestEl.textContent = piece ? pieceLabel(piece, Math.max(0, i)) : 'no pieces';
  }
}

export function bindPiecePanel(selectEl, detailEl, { selectPiece, setPieceOverride, splitPiece }) {
  selectEl?.addEventListener('change', (e) => {
    selectPiece(e.target.value || null);
  });

  detailEl?.addEventListener('change', (e) => {
    const input = e.target.closest('[data-piece-field]');
    if (!input) return;
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value)) return;
    setPieceOverride(input.dataset.pieceId, { [input.dataset.pieceField]: value });
  });

  detailEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-piece-act]');
    if (!btn) return;
    if (btn.dataset.pieceAct === 'split') {
      splitPiece(btn.dataset.gapKey, Number(btn.dataset.cuts) || 2);
    } else if (btn.dataset.pieceAct === 'reset') {
      setPieceOverride(btn.dataset.pieceId, { ductWidth: null, jacketWidth: null });
    }
  });
}
