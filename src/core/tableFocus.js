// Rebuilding the point table wholesale is simple and cheap, but it replaces the very input the
// user is typing into — which is why clicking a coordinate field used to leave you editing
// nothing. These two calls carry the edit across the rebuild.

/** The in-progress edit, or null when focus is elsewhere. */
export function captureEdit(root) {
  const active = root?.ownerDocument?.activeElement;
  if (!active || !root.contains(active) || active.tagName !== 'INPUT') return null;

  return {
    id: active.dataset.id,
    field: active.dataset.field,
    value: active.value,
    // A number input reports no selection, so the caret can only be restored for text ones.
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

export function restoreEdit(root, saved) {
  if (!saved?.id || !saved.field) return;

  const el = root.querySelector(`input[data-id="${CSS.escape(saved.id)}"][data-field="${CSS.escape(saved.field)}"]`);
  if (!el) return;

  el.value = saved.value;
  el.focus({ preventScroll: true });
  if (saved.start !== null) el.setSelectionRange(saved.start, saved.end);
}
