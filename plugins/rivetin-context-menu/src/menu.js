import { identifyResource, currentResource, sameResource, nativeActions, isVisible } from './resources.js';
import { openNativeRowMenu } from './native-menu.js';
import { resolveHostBoundary } from './host-boundary.js';

const names = { organization: ['CloudTower 实例', 'CloudTower instance'], datacenter: ['数据中心', 'Datacenter'], cluster: ['集群', 'Cluster'], host: ['主机', 'Host'], vm: ['虚拟机', 'Virtual machine'], vmVolume: ['虚拟卷', 'Virtual volume'], disk: ['硬盘', 'Disk'] };
export const CSS = `
[data-rivetin-context-menu]{position:fixed;z-index:2147483000;box-sizing:border-box;width:280px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;background:#fff;color:#142640;border:1px solid #dde5ef;border-radius:8px;box-shadow:0 8px 30px #182b4c30;padding:6px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
[data-rivetin-context-menu] .rvcm-heading{padding:9px 10px 10px;border-bottom:1px solid #e9edf3;margin-bottom:5px;overflow-wrap:anywhere;font-weight:600}
[data-rivetin-context-menu] .rvcm-kind{display:block;font-size:12px;color:#74839a;font-weight:400;margin-bottom:2px}
[data-rivetin-context-menu] button{font:inherit;display:flex;align-items:center;gap:10px;text-align:left;width:100%;padding:8px 10px;background:none;border:0;color:inherit;border-radius:4px;cursor:pointer}
[data-rivetin-context-menu] button:hover,[data-rivetin-context-menu] button:focus-visible{background:#eaf4ff;color:#066cdb;outline:none}
[data-rivetin-context-menu] button:disabled{color:#a4afbf;cursor:default;background:none}
[data-rivetin-context-menu] button.rvcm-danger{color:#d62c43}
[data-rivetin-context-menu] .rvcm-glyph{width:18px;text-align:center;color:#6a84a3;font-size:16px}
[data-rivetin-context-menu] .rvcm-separator{height:1px;background:#e9edf3;margin:5px 4px}
[data-rivetin-context-menu] .rvcm-hint{font-size:12px;color:#74839a;padding:8px 10px}
`;
export function clampPosition(x, y, width, height, viewportWidth, viewportHeight) {
  return { x: Math.max(8, Math.min(x, viewportWidth - width - 8)), y: Math.max(8, Math.min(y, viewportHeight - height - 8)) };
}
export function installContextMenu({ win, store, history, getLocale = () => 'zh-CN', onError = () => {}, onResourceMenu = () => false, onDismiss = () => {} }) {
  const doc = win.document, style = doc.createElement('style'); style.textContent = CSS; doc.head.append(style);
  let menu = null, active = null, disposed = false, lastFocus = null, pending = null, timer = null;
  const quarantined = new WeakSet();
  let navigationEpoch = 0;
  const contextKey = () => { const value = currentResource(win); return value ? `${value.type}:${value.id}` : ''; };
  let observedContext = contextKey();
  let historyConnected = false;
  const t = (zh, en) => getLocale() === 'en-US' ? en : zh;
  function close(restore = false) {
    onDismiss();
    pending = null; if (timer !== null) win.clearTimeout(timer); timer = null;
    menu?.remove(); menu = null; active = null;
    if (restore && lastFocus?.isConnected) lastFocus.focus?.();
  }
  function error() { onError(t('右键菜单操作未完成，请从 CloudTower 原生界面重试。', 'The action could not be completed. Retry in the native CloudTower interface.')); }
  function enabled(resource) { const settings = store.get(); return store.status().loaded && settings.enabled && settings.resourceTypes.includes(resource.type); }
  function valid(resource) { return !disposed && enabled(resource) && resource.element.isConnected; }
  async function copy(value) {
    try { if (!win.navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE'); await win.navigator.clipboard.writeText(value); }
    catch { error(); }
  }
  function navigate(resource) {
    if (sameResource(resource, currentResource(win))) return;
    quarantineControls();
    if (resource.select?.isConnected && isVisible(resource.select, win)) resource.select.click();
    else if (resource.type === 'organization') win.location.hash = '/overview';
    else if (resource.href) win.location.hash = new URL(resource.href).hash;
    // The old controls were quarantined before our explicit navigation.
    observedContext = contextKey();
  }
  function quarantineControls() {
    navigationEpoch++;
    // A changed URL does not prove that a reused React button now belongs to the new object.
    for (const node of doc.querySelectorAll('.frame .toolbar button,.frame .toolbar .more-icon,.drawer-content-inner .detail-tabs .tab-item,.frame .detail-tabs .tab-item,.actions-wrapper button,.actions-wrapper .more-icon,.drawer-content-inner .ant-collapse-header,.drawer-content-inner button.edit-icon,.frame .ant-collapse-header,.frame button.edit-icon')) quarantined.add(node);
  }
  function observeRoute() {
    const next = contextKey();
    if (next !== observedContext) { quarantineControls(); observedContext = next; }
  }
  const availableActions = resource => {
    observeRoute();
    // Pure card expansion is revalidated at the click boundary. It does not
    // inherit the privilege to invoke quarantined editors or toolbar handlers.
    return nativeActions(resource, win).filter(entry => entry.kind === 'internal-toggle' || historyConnected && !quarantined.has(entry.button));
  };
  function rebind(resource) {
    if (resource.element.isConnected) return resource;
    if (!sameResource(resource, currentResource(win))) return null;
    const titles = [...doc.querySelectorAll('.frame .title-wrapper .header-title,.title-wrapper .title-content,.title-wrapper .title-text')]
      .filter(node => (node.textContent || '').trim() === resource.name && isVisible(node, win));
    return titles.length === 1 ? { ...resource, element: titles[0], select: null } : null;
  }
  function loadActions(resource, x, y) {
    const request = { resource, x, y, initialHref: win.location.href, deadline: Date.now() + 5000 };
    pending = request;
    try { navigate(resource); } catch { close(); error(); return; }
    paint(resource, x, y, { loading: true });
    function tick() {
      timer = null;
      if (disposed || pending !== request) return;
      if (!enabled(resource) || (win.location.href !== request.initialHref && !sameResource(resource, currentResource(win)))) { close(); return; }
      const target = rebind(resource);
      if (target && sameResource(target, currentResource(win)) && availableActions(target).length) {
        pending = null; paint(target, x, y); return;
      }
      if (Date.now() >= request.deadline) {
        pending = null;
        if (target) paint(target, x, y, { unavailable: true }); else close();
        return;
      }
      timer = win.setTimeout(tick, 100);
    }
    timer = win.setTimeout(tick, 0);
  }
  function paint(resource, x, y, state = {}) {
    if (!valid(resource) && !(state.loading && !disposed && enabled(resource) && pending)) { close(); return; }
    menu?.remove(); menu = doc.createElement('div'); menu.setAttribute('data-rivetin-context-menu', ''); menu.setAttribute('role', 'menu');
    const paintedMenu = menu, paintedHref = win.location.href, paintedEpoch = navigationEpoch;
    // Keep plugin menu events inside their owning UI boundary. The separate native
    // control click still follows CloudTower's own permission and confirmation flow.
    menu.addEventListener('click', event => event.stopPropagation());
    menu.addEventListener('keydown', event => { event.stopPropagation(); key(event); });
    menu.setAttribute('aria-label', t('资源右键菜单', 'Resource context menu')); menu.dataset.contextHref = win.location.href; active = resource;
    const heading = doc.createElement('div'); heading.className = 'rvcm-heading';
    const kind = doc.createElement('span'); kind.className = 'rvcm-kind'; kind.textContent = resource.internal ? t(resource.internal === 'vmDisk' ? '虚拟磁盘' : '网卡', resource.internal === 'vmDisk' ? 'Virtual disk' : 'Network adapter') : t(...(names[resource.type] || ['资源', 'Resource'])); heading.append(kind, doc.createTextNode(resource.name)); menu.append(heading);
    function item(title, glyph, action, disabled = false, danger = false) {
      const button = doc.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = disabled;
      if (danger) button.className = 'rvcm-danger';
      const icon = doc.createElement('span'); icon.className = 'rvcm-glyph'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = glyph;
      button.append(icon, doc.createTextNode(title)); button.addEventListener('click', () => {
        if (menu !== paintedMenu) return;
        if (!valid(resource)) { close(); return; }
        close(); try { const promise = action(); promise?.catch?.(error); } catch { error(); }
      }); menu.append(button);
    }
    item(t('打开详情', 'Open details'), '↗', () => navigate(resource), !resource.select && !resource.href && resource.type !== 'organization' && !sameResource(resource, currentResource(win)));
    item(t('复制名称', 'Copy name'), '⧉', () => copy(resource.name));
    if (!resource.internal) item(t('复制对象 ID', 'Copy resource ID'), '#', () => copy(resource.id), resource.type === 'organization' || !resource.id);
    const href = sameResource(resource, currentResource(win)) ? win.location.href : resource.href;
    if (href) {
      item(t('在新标签页打开', 'Open in new tab'), '↗', () => win.open(href, '_blank', 'noopener,noreferrer'));
      item(t('复制链接', 'Copy link'), '↗', () => copy(href));
    }
    const actions = store.get().nativeActions ? availableActions(resource) : [];
    if (actions.length) {
      const separator = doc.createElement('div'); separator.className = 'rvcm-separator'; separator.setAttribute('role', 'separator'); menu.append(separator);
      for (const entry of actions) item(getLocale() === 'en-US' && entry.english ? entry.english : entry.label, '›', () => {
        // Identity, visibility and current disabled state are checked again at action time.
        const fresh = availableActions(resource).find(value => value.button === entry.button && value.label === entry.label);
        if (!fresh || fresh.disabled) { error(); return; }
        if (entry.kind === 'internal-toggle') {
          const source = identifyResource(resource.element, win);
          if (win.location.href !== paintedHref || navigationEpoch !== paintedEpoch ||
              !sameResource(source, resource) || source.element !== resource.element || source.internal !== resource.internal ||
              source.name !== resource.name || source.parentName !== resource.parentName || fresh.ownerFrame !== entry.ownerFrame) { error(); return; }
        }
        fresh.button.click();
      }, entry.disabled, entry.danger);
    } else if (store.get().nativeActions) {
      if (historyConnected && resource.id && resource.type !== 'organization' && !resource.internal && (resource.select || resource.href))
        item(t('显示可用操作…', 'Load available actions…'), '›', () => loadActions(resource, x, y), Boolean(state.loading));
      const hint = doc.createElement('div'); hint.className = 'rvcm-hint';
      hint.setAttribute('role', 'status');
      hint.textContent = !historyConnected ? t('无法确认宿主导航状态，请使用原生详情页面操作。', 'Host navigation cannot be verified. Use the native detail page for actions.') : state.loading ? t('正在读取此对象的可用操作…', 'Loading available actions for this resource…') :
        state.unavailable ? t('当前没有可确认的操作入口，请使用原生详情页面。', 'No verified actions are available. Use the native detail page.') :
        t('选择“显示可用操作”会定位此对象，再读取原生操作。', 'Load available actions opens this resource’s details and reads its native controls.');
      menu.append(hint);
    }
    const container = resolveHostBoundary(win, resource.element);
    if (!container) { close(); return; }
    if (container !== doc.body) { menu.style.left = '0px'; menu.style.top = '0px'; }
    container.append(menu);
    const rect = menu.getBoundingClientRect(), point = clampPosition(x, y, rect.width, rect.height, win.innerWidth, win.innerHeight);
    menu.style.left = `${point.x - (container === doc.body ? 0 : rect.left)}px`;
    menu.style.top = `${point.y - (container === doc.body ? 0 : rect.top)}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  function open(event, keyboard = false) {
    if (event.defaultPrevented || (!keyboard && event.shiftKey)) return;
    observeRoute();
    const resource = identifyResource(event.target, win);
    if (!resource || !enabled(resource)) { close(); return; }
    event.preventDefault(); close(); lastFocus = doc.activeElement;
    const rect = resource.element.getBoundingClientRect();
    const x = keyboard ? rect.left + 16 : event.clientX, y = keyboard ? rect.bottom : event.clientY;
    if (onResourceMenu(resource, x, y)) return;
    if (store.get().nativeActions && openNativeRowMenu(resource, win)) return;
    paint(resource, x, y);
  }
  function outside(event) {
    if (menu?.contains(event.target)) return;
    observeRoute();
    const target = identifyResource(event.target, win);
    if (target?.id && !target.internal && !sameResource(target, currentResource(win))) quarantineControls();
    if (menu) close();
  }
  function key(event) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { open(event, true); return; }
    if (!menu) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(doc.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }
  function scroll(event) { if (menu && !menu.contains(event.target)) close(); }
  const context = event => open(event);
  const stop = () => close();
  const routeChanged = () => {
    // Queued A -> B -> A events can arrive after the URL has already returned to A.
    quarantineControls(); observedContext = contextKey();
    if (pending && sameResource(pending.resource, currentResource(win))) return;
    close();
  };
  doc.addEventListener('contextmenu', context); doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', key);
  doc.addEventListener('scroll', scroll, true); win.addEventListener('resize', stop); win.addEventListener('blur', stop); win.addEventListener('hashchange', routeChanged); win.addEventListener('popstate', routeChanged);
  const unsubscribe = store.subscribe(() => { if (menu && (!valid(active) || !store.get().nativeActions)) close(); });
  // DOM replacement and host-history pushState can happen without a hashchange event.
  const observer = new win.MutationObserver(() => {
    observeRoute();
    if (pending) {
      if (!enabled(pending.resource) || (win.location.href !== pending.initialHref && !sameResource(pending.resource, currentResource(win)))) close();
    } else if (menu && (!valid(active) || (menu.dataset.contextHref && menu.dataset.contextHref !== win.location.href))) close();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  // Activation may occur mid-navigation, before this plugin has observed any history.
  quarantineControls();
  const unlisten = typeof history?.listen === 'function' ? history.listen(routeChanged) : null;
  historyConnected = typeof unlisten === 'function';
  return () => {
    if (disposed) return; disposed = true; close(); observer.disconnect(); unsubscribe(); if (typeof unlisten === 'function') unlisten(); style.remove();
    doc.removeEventListener('contextmenu', context); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key);
    doc.removeEventListener('scroll', scroll, true); win.removeEventListener('resize', stop); win.removeEventListener('blur', stop); win.removeEventListener('hashchange', routeChanged); win.removeEventListener('popstate', routeChanged);
  };
}
