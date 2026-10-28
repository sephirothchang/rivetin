const norm = value => String(value || '').trim().replace(/\s+/g, ' ');
const disabledSelector = '[disabled],[aria-disabled=true],.is-disabled,.ant-btn-loading,.ant-dropdown-disabled,.ant-btn-disabled,.ant-dropdown-menu-item-disabled,.ant-dropdown-menu-submenu-disabled';
export function visibleNative(node, win) {
  if (!node?.isConnected || node.ownerDocument !== win.document || !node.getClientRects().length) return false;
  for (let p = node; p; p = p.parentElement) {
    const s = win.getComputedStyle(p);
    if (p.matches('[hidden],[aria-hidden=true],[inert],.ant-dropdown-hidden,.__hidden') || s.display === 'none' || ['hidden', 'collapse'].includes(s.visibility)) return false;
  }
  return true;
}
export function nativePopups(win) {
  return [...win.document.querySelectorAll('.ant-dropdown,.ant-dropdown-menu-submenu-popup')].filter(n => visibleNative(n, win));
}
export function nativeMenuOpener(win, pane, kind, diagnostic = false) {
  const icon = kind === 'edit-item' ? 'EditPen16BlueIcon' : 'MoreEllipsis316BoldBlueIcon';
  const labels = kind === 'edit-item' ? ['编辑', 'Edit'] : ['更多', '更多操作', 'More', 'More actions', '⋯', '…'];
  const nodes = [...pane.querySelectorAll('.toolbar button.ant-dropdown-trigger,.toolbar .more-icon.ant-dropdown-trigger')].filter(n => {
    if (!visibleNative(n, win) || !diagnostic && n.closest(disabledSelector)) return false;
    if (!n.querySelector(`[data-testid="${icon}"]`)) return false;
    const text = norm(n.textContent); return !text || labels.includes(text);
  });
  if (diagnostic) return nodes.length > 1 ? 'entry-ambiguous' : nodes.length === 1 && nodes[0].closest(disabledSelector) ? 'entry-disabled' : 'entry-missing';
  return nodes.length === 1 ? nodes[0] : null;
}
// A portal belongs to this operation only with a fresh visibility transition,
// an opened exact trigger, and an explicit relation or adjacent geometry.
export function ownedNativePopup(win, trigger, before) {
  if (!visibleNative(trigger, win)) return null;
  const candidates = nativePopups(win).filter(n => !before.has(n));
  if (candidates.length !== 1) return null;
  const popup = candidates[0], controlled = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')].filter(Boolean).flatMap(x => x.split(/\s+/));
  if (!trigger.classList.contains('ant-dropdown-open') && trigger.getAttribute('aria-expanded') !== 'true') return null;
  if (controlled.length) return popup.id && controlled.includes(popup.id) ? popup : null;
  const a = trigger.getBoundingClientRect(), b = popup.getBoundingClientRect();
  if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return null;
  const x = Math.max(0, a.left - b.right, b.left - a.right), y = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return x <= 24 && y <= 24 ? popup : null;
}
