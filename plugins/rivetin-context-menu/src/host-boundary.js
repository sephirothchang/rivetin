function visible(node, win) {
  for (let current = node; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
    const style = win.getComputedStyle(current);
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
  }
  return true;
}

// This is only an event-containment boundary, never an object identity source.
// Geometry is intentionally excluded: jsdom has no layout, and a rendered pane
// may be translated while remaining the host's active outside-click boundary.
export function resolveHostBoundary(win, source) {
  const doc = win.document, own = source?.closest?.('.drawer-content-inner');
  if (own) return own.ownerDocument === doc && own.isConnected && visible(own, win) ? own : null;
  const drawers = [...doc.querySelectorAll('.drawer-content-inner')].filter(node => visible(node, win));
  return drawers.length > 1 ? null : drawers[0] || doc.body;
}
