import { buildActionTree } from './catalog.js';
import { identifyResource, sameResource } from '../resources.js';
import { resolveHostBoundary } from '../host-boundary.js';
import { nativeErrorMessage } from '../native/errors.js';

const selector = '[data-rivetin-object-menu]';
const css = `${selector}{position:fixed;left:0;top:0;right:auto;bottom:auto;margin:0;border:0;padding:0;background:transparent;z-index:2147483000;width:310px;max-width:calc(100vw - 16px);box-sizing:border-box;color:#142640;font:inherit;line-height:1.5;overflow:visible}
${selector}::backdrop{background:transparent;pointer-events:none}
${selector} .rvm-main,${selector} .rvm-submenu{box-sizing:border-box;background:#fff;border:1px solid #dde5ef;border-radius:8px;box-shadow:0 8px 30px #182b4c30;padding:6px;max-height:calc(100vh - 16px);overflow:auto}
${selector} .rvm-submenu{position:fixed;left:0;top:0;width:310px;max-width:calc(100vw - 16px);z-index:1}
${selector} .rvm-heading{padding:9px 10px;font-weight:600;overflow-wrap:anywhere;border-bottom:1px solid #e9edf3}
${selector} .rvm-status{padding:8px 10px;color:#74839a;font-size:12px;overflow-wrap:anywhere}
${selector} button{display:block;width:100%;box-sizing:border-box;padding:8px 10px;border:0;border-radius:4px;background:none;color:inherit;text-align:left;font:inherit;cursor:pointer}
${selector} button:hover,${selector} button:focus-visible{background:#eaf4ff;outline:2px solid transparent;color:#066cdb}
${selector} button:disabled{color:#68788f;cursor:default;background:none;opacity:1}
${selector} .rvm-danger:not(:disabled){color:#d62c43}
${selector} .rvm-reason{display:block;white-space:normal;font-size:12px;font-weight:400;color:#74839a;overflow-wrap:anywhere}
${selector} .rvm-group{display:flex;align-items:center;justify-content:space-between;gap:16px}
${selector} .rvm-group[aria-expanded="true"]{background:#eaf4ff;color:#066cdb}
${selector} .rvm-group-arrow{font-size:20px;line-height:1;color:#8795a8}
${selector} .rvm-shortcuts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;padding:5px 0 8px;border-bottom:1px solid #e9edf3}
${selector} .rvm-shortcut{padding:8px 2px;text-align:center;font-weight:600;font-size:12px;background:var(--rvm-tint);color:var(--rvm-color)}
${selector} .rvm-shortcut:hover,${selector} .rvm-shortcut:focus-visible{background:var(--rvm-tint);color:var(--rvm-color);outline:2px solid var(--rvm-color);outline-offset:-2px}
${selector} .rvm-shortcut:disabled{background:#f3f5f8;color:#68788f;outline:0;opacity:1}
${selector} .rvm-copy{border-top:1px solid #e9edf3;margin-top:5px;border-radius:0;color:#086fd6;font-size:12px}
[data-rivetin-native-feedback]{position:fixed;z-index:2147483001;left:16px;bottom:16px;max-width:min(520px,calc(100vw - 32px));box-sizing:border-box;padding:14px 42px 14px 16px;border:1px solid #e7c98e;border-radius:8px;background:#fff9ed;color:#684600;box-shadow:0 6px 24px #182b4c24;font:14px/1.5 sans-serif;overflow-wrap:anywhere}
[data-rivetin-native-feedback] button{position:absolute;right:8px;top:8px;border:0;background:transparent;color:inherit;font:20px sans-serif;cursor:pointer}
`;
const plainResource = resource => Object.freeze({ type: 'vm', id: resource.id, name: String(resource.name || '').slice(0, 200) });
const clone = value => JSON.parse(JSON.stringify(value));
export function calculateSubmenuPosition({ anchor, width, height, viewportWidth, viewportHeight }) {
  const margin = 8, right = anchor.right, left = anchor.left - width;
  const side = right + width <= viewportWidth - margin ? 'right' : left >= margin ? 'left' :
    viewportWidth - anchor.right >= anchor.left ? 'right' : 'left';
  return { side, left: Math.max(margin, Math.min(side === 'right' ? right : left, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(anchor.top, viewportHeight - height - margin)) };
}

// This provider is a plugin-local form-opening contract, not a CloudTower SDK.
// It must honor cancellation and must never submit a resource mutation itself.
export function installObjectActionMenu({ win, provider, getLocale = () => 'zh-CN', isEnabled = () => true, onError = () => {} }) {
  const doc = win.document, style = doc.createElement('style');
  style.textContent = css; doc.head.append(style);
  const connected = typeof provider?.read === 'function' && typeof provider?.open === 'function';
  let session = null, disposed = false, sequence = 0, feedback = null, feedbackTimer = null;
  const t = (zh, en) => getLocale() === 'en-US' ? en : zh;
  const unavailable = () => nativeErrorMessage('provider-unavailable', getLocale());
  function clearFeedback() { win.clearTimeout(feedbackTimer); feedbackTimer = null; feedback?.remove(); feedback = null; }
  function showFeedback(message) {
    if (disposed) return;
    clearFeedback(); feedback = doc.createElement('div'); feedback.dataset.rivetinNativeFeedback = '';
    feedback.setAttribute('role', 'alert'); feedback.append(doc.createTextNode(message));
    const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', t('关闭提示', 'Dismiss notice'));
    dismiss.onclick = event => { event.preventDefault(); event.stopPropagation(); clearFeedback(); };
    feedback.append(dismiss); doc.body.append(feedback); feedbackTimer = win.setTimeout(clearFeedback, 30000);
  }
  function valid(value) {
    return !disposed && isEnabled(value.resource) && value.source.isConnected &&
      (!value.mounted || value.menu.isConnected && resolveHostBoundary(win, value.source) === value.container) &&
      sameResource(identifyResource(value.source, win), value.resource) && win.location.href === value.href;
  }
  function close() {
    const value = session; if (!value) return; session = null;
    value.observer?.disconnect(); win.clearInterval(value.guard);
    cancelSubmenuClose(value);
    if (value.copy) { win.clearTimeout(value.copy.timer); value.copy = null; }
    if (value.work) { win.clearTimeout(value.work.timer); value.work.controller.abort(); value.work = null; }
    if (value.topLayer) { try { value.menu.hidePopover(); } catch { /* Removing our node still dismisses its own surface. */ } }
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
    const message = t('操作确认超时，已取消。请重新打开菜单。', 'Action verification timed out and was cancelled. Open the menu again.');
    close(); if (provider?.kind === 'native-ui') showFeedback(message); onError(message);
  }
  function tree(value) {
    if (typeof provider?.tree === 'function') return provider.tree({ resource: value.resource, data: value.nativeData || value.data, locale: getLocale() });
    return buildActionTree({ resource: value.resource, snapshot: value.data?.snapshot, capabilities: value.data?.capabilities, locale: getLocale() });
  }
  function accept(value, result) {
    // Keep provider-owned mutable objects out of later authorization decisions.
    value.nativeProof = provider?.kind === 'native-ui' ? result?.snapshot : null;
    value.nativeData = provider?.kind === 'native-ui' ? result : null;
    value.data = clone({ snapshot: result?.snapshot || null, capabilities: result?.capabilities || {}, native: result?.native || null });
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
          value.notice = nativeErrorMessage('unexpected', getLocale());
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
    value.busy = true; value.notice = provider?.kind === 'native-ui' ? t('正在定位官方操作入口…', 'Locating the official action entry…') : t('正在重新确认状态与权限…', 'Rechecking current state and authorization…'); render(value);
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
      if (provider.handoffBeforeOpen === true) {
        // Native navigation owns the next route change. Unmount our menu first.
        value.work = null; win.clearTimeout(work.timer); close();
        let resultOpen;
        try { resultOpen = await provider.open({ resource: value.resource, actionId, action: clone(action), snapshot: value.nativeProof }, { signal: work.controller.signal }); }
        catch { const message = nativeErrorMessage('unexpected', getLocale()); showFeedback(message); onError(message); return; }
        if (!['opened', 'handed-off', 'cancelled'].includes(resultOpen?.status)) {
          const message = nativeErrorMessage(resultOpen?.reason, getLocale()); showFeedback(message);
          if (!resultOpen?.reported) onError(message);
        }
        return;
      }
      const resultOpen = await provider.open({ resource: value.resource, actionId, action: clone(action), snapshot: clone(value.data.snapshot) }, { signal: work.controller.signal });
      if (!live(value, work)) return;
      if (resultOpen?.status === 'opened' || resultOpen?.status === 'cancelled') {
        value.work = null; win.clearTimeout(work.timer); close();
      } else value.notice = nativeErrorMessage(resultOpen?.reason, getLocale());
    });
  }
  function copyId(value) {
    if (session !== value || !valid(value) || value.copy) return;
    const failed = () => t('无法复制虚拟机 ID，请检查浏览器剪贴板权限。', 'The VM ID could not be copied. Check browser clipboard permissions.');
    if (typeof win.navigator.clipboard?.writeText !== 'function') { value.notice = failed(); render(value); return; }
    const copy = { timer: null }; value.copy = copy;
    const current = () => session === value && value.copy === copy && valid(value);
    function finish(message) {
      if (!current()) return;
      win.clearTimeout(copy.timer); value.copy = null; value.notice = message; render(value);
    }
    copy.timer = win.setTimeout(() => finish(failed()), 8000);
    render(value);
    try {
      // Clipboard calls retain the user's click gesture; their late results never reopen a closed menu.
      Promise.resolve(win.navigator.clipboard.writeText(value.resource.id)).then(
        () => finish(t('虚拟机 ID 已复制。', 'VM ID copied.')), () => finish(failed()),
      );
    } catch { finish(failed()); }
  }
  function position(value) {
    value.menu.style.left = '0px'; value.menu.style.top = '0px';
    // A translated drawer changes the viewport origin of its fixed descendants.
    const origin = value.menu.getBoundingClientRect();
    const x = Math.max(8, Math.min(value.x, win.innerWidth - origin.width - 8));
    const y = Math.max(8, Math.min(value.y, win.innerHeight - origin.height - 8));
    value.menu.style.left = `${x - origin.left}px`; value.menu.style.top = `${y - origin.top}px`;
    positionSubmenu(value);
  }
  function positionSubmenu(value) {
    if (!value.submenu || !value.group) return;
    const anchor = [...value.menu.querySelectorAll('[data-group-id]')].find(node => node.dataset.groupId === value.group);
    if (!anchor) { closeGroup(value); return; }
    value.submenu.style.left = '0px'; value.submenu.style.top = '0px';
    const origin = value.submenu.getBoundingClientRect();
    const placement = calculateSubmenuPosition({ anchor: anchor.getBoundingClientRect(), width: origin.width, height: origin.height,
      viewportWidth: win.innerWidth, viewportHeight: win.innerHeight });
    value.submenu.style.left = `${placement.left - origin.left}px`; value.submenu.style.top = `${placement.top - origin.top}px`;
    value.submenu.dataset.side = placement.side;
  }
  function cancelSubmenuClose(value) {
    if (value.submenuTimer !== null) win.clearTimeout(value.submenuTimer);
    value.submenuTimer = null;
  }
  function scheduleSubmenuClose(value, event) {
    if (session !== value || !value.group) return;
    if (event.relatedTarget && value.menu.contains(event.relatedTarget)) return;
    cancelSubmenuClose(value);
    value.submenuTimer = win.setTimeout(() => { value.submenuTimer = null; if (session === value) closeGroup(value); }, 200);
  }
  function closeGroup(value, restoreFocus = false) {
    cancelSubmenuClose(value);
    const parent = [...value.menu.querySelectorAll('[data-group-id]')].find(node => node.dataset.groupId === value.group);
    value.submenu?.remove(); value.submenu = null; value.group = null;
    for (const node of value.menu.querySelectorAll('[data-group-id]')) node.setAttribute('aria-expanded', 'false');
    if (restoreFocus) parent?.focus();
  }
  function menuButton(value, label, action, parent) {
    const node = doc.createElement('button'); node.type = 'button'; node.setAttribute('role', 'menuitem'); node.textContent = label;
    node.addEventListener('click', event => {
      event.stopPropagation(); if (session !== value || !node.isConnected || !value.menu.contains(node)) return;
      if (valid(value) && !node.disabled) action(); else if (!valid(value)) close();
    });
    parent.append(node); return node;
  }
  function openGroup(value, id, focus = false) {
    if (session !== value || !valid(value)) { if (session === value) close(); return; }
    cancelSubmenuClose(value);
    const group = value.groups?.find(entry => entry.id === id);
    const parent = [...value.menu.querySelectorAll('[data-group-id]')].find(node => node.dataset.groupId === id);
    if (!group || !parent) return;
    if (value.group !== id || !value.submenu?.isConnected) {
      closeGroup(value); value.group = id;
      const submenu = doc.createElement('div'); submenu.className = 'rvm-submenu'; submenu.setAttribute('data-rivetin-submenu', '');
      submenu.id = parent.getAttribute('aria-controls'); submenu.setAttribute('role', 'menu'); submenu.setAttribute('aria-label', group.label);
      submenu.setAttribute('aria-labelledby', parent.id); submenu.dataset.menuRegion = 'submenu'; value.submenu = submenu;
      for (const entry of group.items) {
        const node = menuButton(value, entry.label, () => execute(value, entry.id), submenu);
        node.dataset.actionId = entry.id; node.dataset.menuKey = entry.id;
        node.disabled = !connected || value.loading || value.busy || !entry.enabled;
        if (entry.danger === 'danger') node.className = 'rvm-danger';
        const reason = !connected ? unavailable() : entry.reason;
        if (entry.guide) node.title = entry.guide;
        if (reason) { const small = doc.createElement('span'); small.className = 'rvm-reason'; small.textContent = reason; node.append(small); node.title = reason; }
      }
      submenu.addEventListener('pointerenter', () => cancelSubmenuClose(value));
      submenu.addEventListener('mouseenter', () => cancelSubmenuClose(value));
      value.menu.append(submenu); parent.setAttribute('aria-expanded', 'true');
    }
    positionSubmenu(value);
    if (focus) value.submenu.querySelector('button:not(:disabled)')?.focus();
  }
  function render(value) {
    if (session !== value) return;
    const hadFocus = value.menu.contains(doc.activeElement), focused = doc.activeElement?.dataset.menuKey;
    const activeGroup = value.group; cancelSubmenuClose(value); value.submenu = null;
    value.menu.replaceChildren();
    const main = doc.createElement('div'); main.className = 'rvm-main'; value.menu.append(main);
    main.addEventListener('scroll', () => {
      const anchor = [...directory.querySelectorAll('[data-group-id]')].find(node => node.dataset.groupId === value.group);
      if (!anchor) return;
      const item = anchor.getBoundingClientRect(), bounds = main.getBoundingClientRect();
      if (item.bottom <= bounds.top || item.top >= bounds.bottom) closeGroup(value); else positionSubmenu(value);
    });
    const heading = doc.createElement('div'); heading.className = 'rvm-heading'; heading.textContent = value.resource.name || value.resource.id; main.append(heading);
    const status = doc.createElement('div'); status.className = 'rvm-status'; status.setAttribute('role', 'status');
    status.textContent = value.notice || (!connected ? unavailable() : provider?.kind === 'native-ui' ? t('配置和确认将在 CloudTower 官方原生界面完成。', 'Configuration and confirmation take place in CloudTower’s native UI.') : value.loading ? t('正在读取状态与权限…', 'Reading current state and authorization…') : t('打开表单前会再次确认状态与权限。', 'State and authorization are checked again before opening a form.'));
    main.append(status);
    const button = (label, action, parent = main) => menuButton(value, label, action, parent);
    const groups = tree(value); value.groups = groups;
    const actions = groups.flatMap(entry => entry.items), powerState = value.data?.snapshot?.status;
    const powerId = provider?.kind === 'native-ui' ? 'vm.power.menu' : powerState === 'RUNNING' ? 'vm.power.shutdown' : powerState === 'STOPPED' ? 'vm.power.start' : null;
    const shortcuts = doc.createElement('div'); shortcuts.className = 'rvm-shortcuts'; shortcuts.dataset.menuRegion = 'shortcuts';
    shortcuts.setAttribute('aria-label', t('常用操作', 'Quick actions')); main.append(shortcuts);
    const powerLabel = provider?.kind === 'native-ui' ? t('电源', 'Power') : powerState === 'RUNNING' ? t('关机', 'Off') : powerState === 'STOPPED' ? t('开机', 'On') : t('电源', 'Power');
    const specs = [
      ['console', 'vm.console.open', t('终端', 'Console'), t('打开虚拟机控制台', 'Open virtual machine console'), '#086fd6', '#eaf4ff'],
      ['power', powerId, powerLabel, provider?.kind === 'native-ui' ? t('打开官方电源操作入口', 'Open official power actions') : powerState === 'RUNNING' ? t('正常关闭客户机操作系统', 'Shut down the guest operating system gracefully') : powerState === 'STOPPED' ? t('启动虚拟机', 'Power on virtual machine') : t('当前电源状态不支持快捷开关机', 'The current power state does not support a quick power action'), powerState === 'STOPPED' ? '#16804a' : '#c63146', powerState === 'STOPPED' ? '#e9f7ef' : '#fff0f2'],
      ['migration', 'vm.migration.withinCluster', t('迁移', 'Move'), provider?.kind === 'native-ui' ? t('打开官方迁移向导入口', 'Open the official migration wizard entry') : t('在当前集群内迁移虚拟机', 'Migrate virtual machine within the current cluster'), '#087d86', '#e7f6f7'],
      ['clone', 'vm.clone', t('克隆', 'Clone'), t('克隆虚拟机', 'Clone virtual machine'), '#7950b5', '#f2edfa'],
      ['isolation', 'vm.isolation.configure', t('隔离', 'Isolate'), t('配置虚拟机隔离', 'Configure virtual machine isolation'), '#a45f0d', '#fff4e5'],
    ];
    for (const [id, actionId, label, description, color, tint] of specs) {
      const action = actions.find(entry => entry.id === actionId);
      const reason = !connected ? unavailable() : value.loading ? t('正在读取状态与权限', 'Reading state and authorization') : value.busy ? t('正在确认其他操作', 'Another action is being verified') : !action ? id === 'power' ? description : nativeErrorMessage('entry-missing', getLocale()) : action.reason;
      const node = button(label, () => execute(value, actionId), shortcuts); node.className = 'rvm-shortcut';
      node.dataset.shortcutId = id; node.dataset.shortcutActionId = actionId || ''; node.dataset.menuKey = `shortcut:${id}`;
      node.style.setProperty('--rvm-color', color); node.style.setProperty('--rvm-tint', tint);
      node.disabled = !connected || value.loading || value.busy || !action?.enabled;
      node.title = `${description}${node.disabled && reason ? ` — ${reason}` : ''}`;
      node.setAttribute('aria-label', node.title);
    }
    const directory = doc.createElement('div'); directory.dataset.menuRegion = 'directory'; main.append(directory);
    for (const entry of groups) {
      const node = button(entry.label, () => openGroup(value, entry.id, true), directory); node.className = 'rvm-group';
      const arrow = doc.createElement('span'); arrow.className = 'rvm-group-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '›'; node.append(arrow);
      node.id = `${value.menuId}-${entry.id}`; node.dataset.groupId = entry.id; node.dataset.menuKey = entry.id;
      node.setAttribute('aria-haspopup', 'menu'); node.setAttribute('aria-expanded', 'false'); node.setAttribute('aria-controls', `${node.id}-submenu`);
      node.addEventListener('pointerenter', () => openGroup(value, entry.id));
      node.addEventListener('mouseenter', () => openGroup(value, entry.id));
    }
    const footer = doc.createElement('div'); footer.dataset.menuRegion = 'footer'; main.append(footer);
    const copy = button(t('复制虚拟机 ID', 'Copy VM ID'), () => copyId(value), footer); copy.className = 'rvm-copy'; copy.dataset.copyVmId = ''; copy.dataset.menuKey = 'copy'; copy.disabled = !!value.copy;
    copy.title = t('复制当前虚拟机的唯一 ID', 'Copy the unique ID of this virtual machine'); copy.setAttribute('aria-label', copy.title);
    position(value);
    if (activeGroup) openGroup(value, activeGroup);
    if (hadFocus) ([...value.menu.querySelectorAll('button:not(:disabled)')].find(node => node.dataset.menuKey === focused) || value.menu.querySelector('button:not(:disabled)'))?.focus();
  }
  function focusDirectory(value) { value.menu.querySelector('[data-menu-region="directory"] button:not(:disabled)')?.focus(); }
  function open(resource, x, y) {
    if (disposed || resource?.type !== 'vm' || resource.internal || !/^[A-Za-z0-9_-]{1,128}$/.test(resource.id || '') || !resource.element?.isConnected || !isEnabled(resource)) return false;
    close(); clearFeedback();
    try { provider?.bindSource?.(resource); } catch { return false; }
    const container = resolveHostBoundary(win, resource.element);
    if (!container) return false;
    const menu = doc.createElement('div'); menu.setAttribute('data-rivetin-object-menu', ''); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('虚拟机对象操作', 'Virtual machine actions'));
    const value = { resource: plainResource(resource), source: resource.element, menu, container, menuId: `rvm-menu-${++sequence}`, submenu: null, submenuTimer: null, mounted: false, href: win.location.href, x: Number.isFinite(x) ? x : 8, y: Number.isFinite(y) ? y : 8, group: null, data: null, notice: '', loading: connected, busy: false, work: null };
    if (!valid(value)) return false;
    session = value;
    menu.addEventListener('click', event => event.stopPropagation()); menu.addEventListener('pointerdown', event => event.stopPropagation());
    menu.addEventListener('pointerleave', event => scheduleSubmenuClose(value, event));
    menu.addEventListener('mouseleave', event => scheduleSubmenuClose(value, event));
    menu.addEventListener('pointerenter', () => cancelSubmenuClose(value)); menu.addEventListener('mouseenter', () => cancelSubmenuClose(value));
    container.append(menu); value.mounted = true;
    // Top-layer painting escapes transformed drawer clipping while DOM ancestry
    // and host outside-click containment stay unchanged. Older browsers fall back.
    if (typeof menu.showPopover === 'function' && typeof menu.hidePopover === 'function') {
      try {
        menu.setAttribute('popover', 'manual'); menu.showPopover();
        if (menu.matches(':popover-open')) value.topLayer = true; else menu.removeAttribute('popover');
      }
      catch { menu.removeAttribute('popover'); }
    }
    if (!menu.isConnected) { close(); return false; }
    menu.addEventListener('toggle', event => { if (event.newState === 'closed' && value.topLayer && session === value) close(); });
    value.observer = new win.MutationObserver(() => { if (session === value && !valid(value)) close(); });
    value.observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key', 'href', 'hidden', 'aria-hidden', 'style', 'class'] });
    value.guard = win.setInterval(() => { if (session === value && !valid(value)) close(); }, 100);
    render(value); focusDirectory(value);
    if (connected) launch(value, async work => {
      const result = await provider.read(value.resource, { signal: work.controller.signal });
      if (live(value, work)) accept(value, result);
    });
    return true;
  }
  function outside(event) { if (session && !session.menu.contains(event.target)) close(); }
  function key(event) {
    const value = session; if (!value) return;
    if (event.key === 'Escape') {
      if (value.menu.contains(event.target)) { event.preventDefault(); event.stopPropagation(); }
      if (value.submenu?.contains(event.target)) closeGroup(value, true); else close(); return;
    }
    if (!value.menu.contains(event.target)) return;
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const all = [...value.menu.querySelectorAll('button:not(:disabled)')], index = all.indexOf(doc.activeElement);
      all[(index + (event.shiftKey ? -1 : 1) + all.length) % all.length]?.focus(); return;
    }
    if (['ArrowLeft', 'Backspace'].includes(event.key) && value.group) { event.preventDefault(); event.stopPropagation(); closeGroup(value, true); return; }
    const region = doc.activeElement?.closest('[data-menu-region]') || value.menu;
    const items = [...region.querySelectorAll('button:not(:disabled)')];
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
    if (disposed) return; close(); clearFeedback(); disposed = true; style.remove();
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', key, true);
    win.removeEventListener('hashchange', close); win.removeEventListener('popstate', close); win.removeEventListener('blur', close);
  } };
}
