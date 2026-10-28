import { identifyResource, sameResource } from '../resources.js';
import { resolveHostBoundary } from '../host-boundary.js';
import { calculateSubmenuPosition } from '../actions/menu.js';
import { createNativeRowMenuAdapter } from './row-menu.js';
import { nativeErrorMessage } from './errors.js';

const marker = '[data-rivetin-resource-menu]';
const css = `${marker}{position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;overflow:visible;z-index:2147483000;color:#142640;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;width:280px;max-width:calc(100vw - 16px)}
${marker}::backdrop{background:transparent;pointer-events:none}
${marker} .rrm-panel{box-sizing:border-box;width:280px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:6px;background:#fff;border:1px solid #dde5ef;border-radius:8px;box-shadow:0 8px 30px #182b4c30}
${marker} .rrm-child{position:fixed}
${marker} .rrm-heading{padding:9px 10px;font-weight:600;border-bottom:1px solid #e9edf3;overflow-wrap:anywhere}
${marker} .rrm-notice{padding:8px 10px;color:#74839a;font-size:12px}
${marker} button{box-sizing:border-box;display:flex;justify-content:space-between;gap:12px;width:100%;border:0;border-radius:4px;padding:8px 10px;background:none;text-align:left;color:inherit;font:inherit;cursor:pointer}
${marker} button:hover,${marker} button:focus-visible,${marker} button[aria-expanded=true]{background:#eaf4ff;color:#066cdb;outline:0}
${marker} button:disabled{color:#8592a7;background:none;cursor:default}
${marker} button.rrm-danger:not(:disabled){color:#d62c43}
${marker} [role=separator]{height:1px;background:#e9edf3;margin:5px 4px}`;

// The host owns the action inventory and every business workflow. This renderer
// only presents the public native menu tree and delegates a chosen leaf back.
export function installNativeResourceMenu({ win, isEnabled = () => true, getLocale = () => 'zh-CN', onError = () => {}, adapter } = {}) {
  const doc = win.document, style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
  const native = adapter || createNativeRowMenuAdapter({ win, identify: identifyResource, isEnabled, getLocale });
  const t = (zh, en) => getLocale() === 'en-US' ? en : zh;
  let active = null, executing = null, stopped = false;
  function valid(s) {
    return !stopped && active === s && !s.controller.signal.aborted && s.href === win.location.href &&
      (!s.mounted || s.root.isConnected && resolveHostBoundary(win, s.resource.element) === s.container) &&
      s.resource.element.isConnected && isEnabled(s.resource) && sameResource(identifyResource(s.resource.element, win), s.resource);
  }
  function removeSurface(s) {
    s.observer?.disconnect(); win.clearInterval(s.guard); win.clearTimeout(s.leave);
    if (s.topLayer) { s.topLayer = false; try { s.root.hidePopover(); } catch { /* Our own node is removed below. */ } }
    s.root.remove();
  }
  function closeNative(s) {
    if (s.nativeClosed) return; s.nativeClosed = true; s.native?.close();
  }
  function cancel(s) { s.controller.abort(); removeSurface(s); closeNative(s); }
  function close() {
    const shown = active, pending = executing; active = null; executing = null;
    if (shown) cancel(shown);
    if (pending && pending !== shown) cancel(pending);
  }
  function error(reason) { onError(nativeErrorMessage(reason, getLocale())); }
  function place(panel, x, y) {
    panel.style.left = '0px'; panel.style.top = '0px';
    const r = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(x, win.innerWidth - r.width - 8)) - r.left}px`;
    panel.style.top = `${Math.max(8, Math.min(y, win.innerHeight - r.height - 8)) - r.top}px`;
  }
  function prune(s, depth, focus = false) {
    for (const child of s.levels.splice(depth + 1)) { child.anchor?.setAttribute('aria-expanded', 'false'); child.panel.remove(); }
    if (focus) s.levels[depth]?.anchor?.focus();
  }
  async function execute(s, id) {
    if (!valid(s) || s.busy) return;
    s.busy = true;
    // Removing the UI does not relinquish cancellation of the native handoff.
    active = null; executing = s; removeSurface(s);
    try {
      const result = await s.native.execute(id);
      if (executing === s && !s.controller.signal.aborted && !['handed-off', 'opened', 'cancelled'].includes(result?.status) && result?.reason !== 'cancelled') error(result?.reason);
    } catch { if (executing === s && !s.controller.signal.aborted) error('unexpected'); }
    finally { if (executing === s) executing = null; closeNative(s); s.controller.abort(); }
  }
  function fill(s, panel, entries, depth) {
    entries.forEach(entry => {
      if (entry.separator) { const line = doc.createElement('div'); line.setAttribute('role', 'separator'); panel.append(line); return; }
      const b = doc.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = entry.label;
      b.disabled = entry.disabled === true; b.dataset.nativeEntryId = entry.id;
      if (b.disabled) b.title = nativeErrorMessage(entry.reasonCode || 'entry-disabled', getLocale());
      if (entry.danger) b.classList.add('rrm-danger');
      const children = entry.children;
      if (children?.length) {
        b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
        const arrow = doc.createElement('span'); arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true'); b.append(arrow);
        const expand = focus => {
          if (!valid(s) || b.disabled) return;
          win.clearTimeout(s.leave);
          if (s.levels[depth + 1]?.anchor === b) { if (focus) s.levels[depth + 1].panel.querySelector('button:not(:disabled)')?.focus(); return; }
          prune(s, depth);
          const child = doc.createElement('div'); child.className = 'rrm-panel rrm-child'; child.setAttribute('role', 'menu'); child.setAttribute('aria-label', entry.label);
          s.root.append(child); s.levels.push({ panel: child, anchor: b }); b.setAttribute('aria-expanded', 'true');
          fill(s, child, children, depth + 1); child.style.left = '0px'; child.style.top = '0px';
          const r = child.getBoundingClientRect(), point = calculateSubmenuPosition({ anchor: b.getBoundingClientRect(), width: r.width, height: r.height, viewportWidth: win.innerWidth, viewportHeight: win.innerHeight });
          child.style.left = `${point.left - r.left}px`; child.style.top = `${point.top - r.top}px`; child.dataset.side = point.side;
          if (focus) child.querySelector('button:not(:disabled)')?.focus();
        };
        b.addEventListener('pointerenter', () => expand(false)); b.addEventListener('mouseenter', () => expand(false));
        b.addEventListener('click', () => expand(true));
      } else {
        b.addEventListener('pointerenter', () => prune(s, depth));
        b.addEventListener('click', () => { if (!b.disabled) void execute(s, entry.id); });
      }
      panel.append(b);
    });
    panel.addEventListener('scroll', () => prune(s, depth));
  }
  function open(resource, x, y) {
    if (stopped || resource.internal || !resource.element?.closest('tr[data-row-key]') || !isEnabled(resource)) return false;
    close();
    const container = resolveHostBoundary(win, resource.element); if (!container) return false;
    const root = doc.createElement('div'); root.setAttribute('data-rivetin-resource-menu', ''); root.setAttribute('role', 'menu');
    const panel = doc.createElement('div'); panel.className = 'rrm-panel'; root.append(panel);
    const heading = doc.createElement('div'); heading.className = 'rrm-heading'; heading.textContent = resource.name; panel.append(heading);
    const status = doc.createElement('div'); status.className = 'rrm-notice'; status.setAttribute('role', 'status'); status.textContent = t('正在读取官方可用操作…', 'Reading available native actions…'); panel.append(status);
    const s = { resource, root, container, mounted: false, controller: new win.AbortController(), href: win.location.href, levels: [{ panel }], native: null };
    active = s;
    // Native menu preparation precedes mounting ours so host popup detection
    // cannot mistake a plugin surface for a host popup.
    void (async () => {
      try {
        const result = await native.prepare(resource, { signal: s.controller.signal, onFailure: reason => { s.failure = reason; } });
        if (!valid(s)) { result?.close(); return; }
        s.native = result;
        if (!result?.tree?.length) { const reason = s.failure || 'menu-empty'; close(); if (reason !== 'cancelled') error(reason); return; }
        if (!container.isConnected || resolveHostBoundary(win, resource.element) !== container) { close(); return; }
        panel.replaceChildren(heading); fill(s, panel, result.tree, 0); container.append(root); s.mounted = true;
        root.style.left = '0px'; root.style.top = '0px';
        if (typeof root.showPopover === 'function') {
          try { root.setAttribute('popover', 'manual'); root.showPopover(); s.topLayer = root.matches(':popover-open'); if (!s.topLayer) root.removeAttribute('popover'); } catch { root.removeAttribute('popover'); }
        }
        place(root, x, y); panel.querySelector('button:not(:disabled)')?.focus();
        s.observer = new win.MutationObserver(() => { if (!valid(s)) close(); });
        s.observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key', 'class', 'style', 'hidden'] });
        s.guard = win.setInterval(() => { if (!valid(s)) close(); }, 100);
      } catch { if (active === s) { close(); error('unexpected'); } }
    })();
    root.addEventListener('pointerdown', e => e.stopPropagation()); root.addEventListener('click', e => e.stopPropagation());
    root.addEventListener('pointerenter', () => win.clearTimeout(s.leave));
    root.addEventListener('pointerleave', e => { if (!root.contains(e.relatedTarget)) s.leave = win.setTimeout(() => prune(s, 0), 220); });
    return true;
  }
  function outside(e) { if (active && !active.root.contains(e.target)) close(); }
  function key(e) {
    const s = active; if (!s || !s.root.contains(e.target)) return;
    e.stopPropagation();
    const depth = s.levels.findIndex(l => l.panel === e.target.closest('.rrm-panel'));
    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault(); if (depth > 0) { const a = s.levels[depth].anchor; prune(s, depth - 1); a.focus(); } else close(); return;
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); if (e.target.getAttribute('aria-haspopup') === 'menu') e.target.click(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(e.key)) {
      e.preventDefault(); const buttons = [...s.levels[Math.max(depth, 0)].panel.querySelectorAll('button:not(:disabled)')], i = buttons.indexOf(doc.activeElement);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowUp' || e.shiftKey ? -1 : 1) + buttons.length) % buttons.length; buttons[n]?.focus();
    }
  }
  doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', key, true);
  win.addEventListener('hashchange', close); win.addEventListener('popstate', close); win.addEventListener('blur', close);
  return { open, close, stop() { if (stopped) return; stopped = true; close(); native.stop?.(); style.remove(); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true); win.removeEventListener('hashchange', close); win.removeEventListener('popstate', close); win.removeEventListener('blur', close); } };
}
