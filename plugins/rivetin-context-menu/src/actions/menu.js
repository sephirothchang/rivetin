import { buildActionTree } from './catalog.js';
import { identifyResource, sameResource } from '../resources.js';
import { resolveHostBoundary } from '../host-boundary.js';

const selector = '[data-rivetin-object-menu]';
const css = `${selector}{position:fixed;left:0;top:0;z-index:2147483000;width:310px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;background:#fff;color:#142640;border:1px solid #dde5ef;border-radius:8px;box-shadow:0 8px 30px #182b4c30;padding:6px;font:inherit;line-height:1.5}
${selector} .rvm-heading{padding:9px 10px;font-weight:600;overflow-wrap:anywhere;border-bottom:1px solid #e9edf3}
${selector} .rvm-status{padding:8px 10px;color:#74839a;font-size:12px;overflow-wrap:anywhere}
${selector} button{display:block;width:100%;box-sizing:border-box;padding:8px 10px;border:0;border-radius:4px;background:none;color:inherit;text-align:left;font:inherit;cursor:pointer}
${selector} button:hover,${selector} button:focus-visible{background:#eaf4ff;outline:2px solid transparent;color:#066cdb}
${selector} button:disabled{color:#68788f;cursor:default;background:none;opacity:1}
${selector} .rvm-danger:not(:disabled){color:#d62c43}
${selector} .rvm-reason{display:block;white-space:normal;font-size:12px;font-weight:400;color:#74839a;overflow-wrap:anywhere}
${selector} .rvm-back{border-bottom:1px solid #e9edf3;border-radius:0}
`;
const plainResource = resource => Object.freeze({ type: 'vm', id: resource.id, name: String(resource.name || '').slice(0, 200) });
const clone = value => JSON.parse(JSON.stringify(value));

// This provider is a plugin-local form-opening contract, not a CloudTower SDK.
// It must honor cancellation and must never submit a resource mutation itself.
export function installObjectActionMenu({ win, provider, getLocale = () => 'zh-CN', isEnabled = () => true, onError = () => {} }) {
  const doc = win.document, style = doc.createElement('style');
  style.textContent = css; doc.head.append(style);
  const connected = typeof provider?.read === 'function' && typeof provider?.open === 'function';
  let session = null, disposed = false;
  const t = (zh, en) => getLocale() === 'en-US' ? en : zh;
  const unavailable = () => t('操作适配器尚未接入', 'The action adapter is not connected');
  function valid(value) {
    return !disposed && isEnabled(value.resource) && value.source.isConnected &&
      (!value.mounted || value.menu.isConnected && resolveHostBoundary(win, value.source) === value.container) &&
      sameResource(identifyResource(value.source, win), value.resource) && win.location.href === value.href;
  }
  function close() {
    const value = session; if (!value) return; session = null;
    value.observer.disconnect(); win.clearInterval(value.guard);
    if (value.work) { win.clearTimeout(value.work.timer); value.work.controller.abort(); value.work = null; }
    value.menu.remove();
  }
  function live(value, work) {
    if (session !== value || value.work !== work || work.controller.signal.aborted) return false;
    if (!valid(value)) { close(); return false; }
    if (win.performance.now() >= work.deadline) { expire(value, work); return false; }
    return true;
  }
  function expire(value, work) {
    if (session !== value || value.work !== work) return;
    close(); onError(t('操作确认超时，已取消。请重新打开菜单。', 'Action verification timed out and was cancelled. Open the menu again.'));
  }
  function tree(value) {
    return buildActionTree({ resource: value.resource, snapshot: value.data?.snapshot, capabilities: value.data?.capabilities, locale: getLocale() });
  }
  function accept(value, result) {
    // Keep provider-owned mutable objects out of later authorization decisions.
    value.data = clone({ snapshot: result?.snapshot || null, capabilities: result?.capabilities || {} });
    if (value.data.snapshot?.id !== value.resource.id) value.notice = t('对象 ID 与状态快照不一致，请重新读取。', 'The resource ID does not match the snapshot.');
  }
  function launch(value, task) {
    if (session !== value) return;
    if (!valid(value)) { close(); return; }
    if (value.work) { win.clearTimeout(value.work.timer); value.work.controller.abort(); }
    const work = { controller: new win.AbortController(), timer: null, deadline: win.performance.now() + 8000 };
    value.work = work;
    work.timer = win.setTimeout(() => {
      if (session === value && value.work === work) expire(value, work);
    }, 8000);
    void (async () => {
      try { if (live(value, work)) await task(work); }
      catch {
        if (live(value, work)) {
          value.notice = t('无法确认此对象的操作状态，请重新打开菜单。', 'The resource action state could not be verified. Open the menu again.');
          onError(value.notice);
        }
      } finally {
        win.clearTimeout(work.timer);
        if (session === value && value.work === work) {
          value.work = null; value.loading = false; value.busy = false;
          if (valid(value)) render(value); else close();
        }
      }
    })();
  }
  function execute(value, actionId) {
    if (session !== value || !connected || value.work || !valid(value)) return;
    value.busy = true; value.notice = t('正在重新确认状态与权限…', 'Rechecking current state and authorization…'); render(value);
    launch(value, async work => {
      const result = await provider.read(value.resource, { signal: work.controller.signal });
      if (!live(value, work)) return;
      accept(value, result);
      const action = tree(value).flatMap(group => group.items).find(entry => entry.id === actionId);
      if (!action?.enabled || value.data.snapshot?.id !== value.resource.id) {
        value.notice = action?.reason || t('对象状态已变化，操作已取消。', 'The resource state changed; the action was cancelled.'); return;
      }
      // No row selection, native click or REST mutation is performed here.
      if (!live(value, work)) return;
      const resultOpen = await provider.open({ resource: value.resource, actionId, action: clone(action), snapshot: clone(value.data.snapshot) }, { signal: work.controller.signal });
      if (!live(value, work)) return;
      if (resultOpen?.status === 'opened' || resultOpen?.status === 'cancelled') {
        value.work = null; win.clearTimeout(work.timer); close();
      } else value.notice = t('此操作尚无已验证的表单适配。', 'No verified form adapter is available for this action.');
    });
  }
  function position(value) {
    value.menu.style.left = '0px'; value.menu.style.top = '0px';
    // A translated drawer changes the viewport origin of its fixed descendants.
    const origin = value.menu.getBoundingClientRect();
    const x = Math.max(8, Math.min(value.x, win.innerWidth - origin.width - 8));
    const y = Math.max(8, Math.min(value.y, win.innerHeight - origin.height - 8));
    value.menu.style.left = `${x - origin.left}px`; value.menu.style.top = `${y - origin.top}px`;
  }
  function render(value) {
    if (session !== value) return;
    const hadFocus = value.menu.contains(doc.activeElement), focused = doc.activeElement?.dataset.menuKey;
    value.menu.replaceChildren();
    const heading = doc.createElement('div'); heading.className = 'rvm-heading'; heading.textContent = value.resource.name || value.resource.id; value.menu.append(heading);
    const status = doc.createElement('div'); status.className = 'rvm-status'; status.setAttribute('role', 'status');
    status.textContent = !connected ? unavailable() : value.notice || (value.loading ? t('正在读取状态与权限…', 'Reading current state and authorization…') : t('打开表单前会再次确认状态与权限。', 'State and authorization are checked again before opening a form.'));
    value.menu.append(status);
    function button(label, action) {
      const node = doc.createElement('button'); node.type = 'button'; node.setAttribute('role', 'menuitem'); node.textContent = label;
      node.addEventListener('click', event => {
        event.stopPropagation(); if (session !== value) return;
        if (valid(value) && !node.disabled) action(); else if (!valid(value)) close();
      });
      value.menu.append(node); return node;
    }
    const groups = tree(value), group = groups.find(entry => entry.id === value.group);
    if (!group) {
      for (const entry of groups) {
        const node = button(`${entry.label}  ›`, () => { value.group = entry.id; render(value); value.menu.querySelector('button:not(:disabled)')?.focus(); });
        node.dataset.groupId = entry.id; node.dataset.menuKey = entry.id; node.setAttribute('aria-haspopup', 'menu');
      }
    } else {
      const back = button(t('‹ 返回全部操作', '‹ All actions'), () => { value.group = null; render(value); value.menu.querySelector('button:not(:disabled)')?.focus(); }); back.className = 'rvm-back'; back.dataset.menuKey = 'back';
      const title = doc.createElement('div'); title.className = 'rvm-heading'; title.textContent = group.label; value.menu.append(title);
      for (const entry of group.items) {
        const node = button(entry.label, () => execute(value, entry.id)); node.dataset.actionId = entry.id; node.dataset.menuKey = entry.id;
        node.disabled = !connected || value.loading || value.busy || !entry.enabled;
        if (entry.danger === 'danger') node.className = 'rvm-danger';
        const reason = !connected ? unavailable() : entry.reason;
        if (reason) { const small = doc.createElement('span'); small.className = 'rvm-reason'; small.textContent = reason; node.append(small); node.title = reason; }
      }
    }
    position(value);
    if (hadFocus) ([...value.menu.querySelectorAll('button:not(:disabled)')].find(node => node.dataset.menuKey === focused) || value.menu.querySelector('button:not(:disabled)'))?.focus();
  }
  function open(resource, x, y) {
    if (disposed || resource?.type !== 'vm' || resource.internal || !/^[A-Za-z0-9_-]{1,128}$/.test(resource.id || '') || !resource.element?.isConnected || !isEnabled(resource)) return false;
    close();
    const container = resolveHostBoundary(win, resource.element);
    if (!container) return false;
    const menu = doc.createElement('div'); menu.setAttribute('data-rivetin-object-menu', ''); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('虚拟机对象操作', 'Virtual machine actions'));
    const value = { resource: plainResource(resource), source: resource.element, menu, container, mounted: false, href: win.location.href, x: Number.isFinite(x) ? x : 8, y: Number.isFinite(y) ? y : 8, group: null, data: null, notice: '', loading: connected, busy: false, work: null };
    if (!valid(value)) return false;
    session = value;
    menu.addEventListener('click', event => event.stopPropagation()); menu.addEventListener('pointerdown', event => event.stopPropagation());
    container.append(menu); value.mounted = true;
    value.observer = new win.MutationObserver(() => { if (session === value && !valid(value)) close(); });
    value.observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key', 'href', 'hidden', 'aria-hidden', 'style', 'class'] });
    value.guard = win.setInterval(() => { if (session === value && !valid(value)) close(); }, 100);
    render(value); menu.querySelector('button:not(:disabled)')?.focus();
    if (connected) launch(value, async work => {
      const result = await provider.read(value.resource, { signal: work.controller.signal });
      if (live(value, work)) accept(value, result);
    });
    return true;
  }
  function outside(event) { if (session && !session.menu.contains(event.target)) close(); }
  function key(event) {
    const value = session; if (!value) return;
    if (event.key === 'Escape') { if (value.menu.contains(event.target)) { event.preventDefault(); event.stopPropagation(); } close(); return; }
    if (!value.menu.contains(event.target)) return;
    if (event.key === 'Tab') { close(); return; }
    if (['ArrowLeft', 'Backspace'].includes(event.key) && value.group) { event.preventDefault(); event.stopPropagation(); value.group = null; render(value); value.menu.querySelector('button:not(:disabled)')?.focus(); return; }
    const items = [...value.menu.querySelectorAll('button:not(:disabled)')];
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const index = items.indexOf(doc.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus();
    } else if ((['Enter', ' '].includes(event.key) || (event.key === 'ArrowRight' && doc.activeElement?.dataset.groupId)) && doc.activeElement?.closest(selector) === value.menu) {
      event.preventDefault(); event.stopPropagation(); doc.activeElement.click();
    }
  }
  doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', key, true);
  win.addEventListener('hashchange', close); win.addEventListener('popstate', close); win.addEventListener('blur', close);
  return { open, close, stop() {
    if (disposed) return; close(); disposed = true; style.remove();
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true);
    win.removeEventListener('hashchange', close); win.removeEventListener('popstate', close); win.removeEventListener('blur', close);
  } };
}
