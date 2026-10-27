import { createMenuIcon } from './menu-icon.js';
const LABELS = new Set(['标签管理', 'Label management', 'Labels']);
export function installMenuEntry({ win, onOpen, onStatus = () => {}, getLabel = () => '插件配置' }) {
  const doc = win.document, owned = new Set();
  let pending = false, disposed = false;
  function scan() {
    pending = false;
    if (disposed) return;
    for (const entry of owned) if (!entry.isConnected) owned.delete(entry);
    const labels = [...doc.querySelectorAll('body *')].filter(node =>
      !node.closest('[data-c89-plugin-ui]') && node.childElementCount === 0 && LABELS.has(node.textContent.trim()));
    let supported = false;
    for (const label of labels) {
      const reference = label.closest('.menu-group-item,a,button,[role="menuitem"],li');
      const group = reference?.parentElement;
      // Require a settings group, not an unrelated page containing a matching label.
      if (!reference || !group || !/系统配置|System configuration|System settings/.test(group.textContent)) continue;
      supported = true;
      const existing = group.querySelector('[data-c89-menu-entry]');
      if (existing) {
        const text = existing.querySelector('.c89-menu-label');
        if (text && text.textContent !== getLabel()) text.textContent = getLabel();
        continue;
      }
      const entry = doc.createElement('button');
      entry.type = 'button'; entry.className = 'c89-menu-entry';
      if (reference.classList.contains('menu-group-item')) entry.classList.add('menu-group-item');
      entry.setAttribute('data-c89-menu-entry', '');
      entry.setAttribute('data-c89-plugin-ui', ''); entry.setAttribute('role', 'menuitem');
      const text = doc.createElement('span'), nativeStyle = win.getComputedStyle(label);
      text.className = 'c89-menu-label'; text.textContent = getLabel();
      for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color']) text.style[key] = nativeStyle[key];
      entry.append(createMenuIcon(doc), text);
      entry.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        // Let the host's outside-click handler close its own popup before opening ours.
        for (const type of ['mousedown', 'mouseup', 'click']) doc.body.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true }));
        onOpen();
      });
      reference.after(entry); owned.add(entry);
    }
    if (labels.length) onStatus(supported ? 'ready' : 'unsupported');
  }
  function schedule() {
    if (!pending && !disposed) { pending = true; win.queueMicrotask(scan); }
  }
  const observer = new win.MutationObserver(records => {
    if (records.some(record => !record.target.parentElement?.closest('[data-c89-plugin-ui]'))) schedule();
  });
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
  observer.observe(doc.body, { childList: true, characterData: true, subtree: true }); scan();
  return () => { disposed = true; observer.disconnect(); for (const entry of owned) entry.remove(); owned.clear(); };
}
