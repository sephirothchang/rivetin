import { identifyResource } from '../resources.js';
import { nativeRetirement } from './retirement.js';

const text = node => (node?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300);
const popupSelector = '.ant-dropdown,.ant-dropdown-menu-submenu-popup';
const blocked = '[hidden],[aria-hidden="true"],[inert],.__hidden,.ant-dropdown-hidden,.ant-dropdown-menu-submenu-hidden,.ant-dropdown-menu-hidden';
const disabledSelector = '[disabled],[aria-disabled="true"],.is-disabled,.ant-btn-loading,.ant-dropdown-disabled,.ant-btn-disabled,.ant-dropdown-menu-item-disabled,.ant-dropdown-menu-submenu-disabled';
const moreLabels = new Set(['更多', '更多操作', '更多选项', 'more', 'more actions', 'more options', '⋯', '…', '...']);
const moreIconSelector = '[data-testid="MoreEllipsis316BoldBlueIcon"],[data-testid="MoreEllipsis316BoldSecondaryIcon"],img[alt="1-more-ellipsis-3-16-bold-blue"]';
const failureReasons = new Set(['plugin-disabled', 'source-changed', 'source-retired', 'trigger-missing', 'trigger-ambiguous', 'blocked-by-dialog', 'popup-unproven', 'popup-timeout', 'menu-empty', 'menu-ambiguous', 'menu-changed', 'entry-disabled', 'depth-limit', 'cancelled', 'unexpected']);
let nextSession = 0;

// Metadata is copied, never host handlers. prepare closes its native menu before
// returning; execute reopens and proves each unique path against fresh host DOM.
export function createNativeRowMenuAdapter({ win, identify = identifyResource, isEnabled = () => true, getLocale = () => 'zh-CN', timeoutMs = 3000, maxDepth = 4, maxItems = 200 } = {}) {
  if (!win?.document) throw new Error('NATIVE_ROW_WINDOW_REQUIRED');
  const doc = win.document;
  const retirement = nativeRetirement(win), trusted = retirement.trusted;
  let active = null, stopped = false;
  function visible(node) {
    if (!node?.isConnected || node.ownerDocument !== doc || node.closest(blocked)) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = win.getComputedStyle(current);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
    }
    return node.getClientRects().length > 0;
  }
  const available = node => visible(node) && trusted(node) && !node.closest(disabledSelector);
  function popups() { return [...doc.querySelectorAll(popupSelector)].filter(node => !node.parentElement?.closest(popupSelector)); }
  function rootMenu(popup) {
    const menus = [...popup.querySelectorAll('[role="menu"]')];
    if (popup.matches('[role="menu"]')) menus.unshift(popup);
    const roots = menus.filter(menu => !menus.some(other => other !== menu && other.contains(menu)));
    return roots.length === 1 ? roots[0] : null;
  }
  function items(popup) {
    const menu = rootMenu(popup); if (!menu) return [];
    return [...menu.querySelectorAll('[role="menuitem"]')].filter(node => visible(node) && node.closest('[role="menu"]') === menu && !node.parentElement?.closest('[role="menuitem"]'));
  }
  function label(node) {
    const copy = node.cloneNode(true);
    for (const child of copy.querySelectorAll('[role="menu"],svg,[aria-hidden="true"],.ant-dropdown-menu-submenu-arrow')) child.remove();
    return text(copy);
  }
  function submenu(node) {
    return node.getAttribute('aria-haspopup') === 'menu' || node.getAttribute('aria-haspopup') === 'true' || node.matches('li.ant-dropdown-menu-submenu[role="menuitem"]');
  }
  function opener(node) { return node.matches('.ant-dropdown-menu-submenu') ? node.querySelector(':scope > .ant-dropdown-menu-submenu-title') || node : node; }
  function hoverTitle(node) {
    return node?.matches('.ant-dropdown-menu-submenu-title[role="button"][aria-haspopup="true"]') && node.parentElement?.matches('li.ant-dropdown-menu-submenu[role="menuitem"]');
  }
  function opened(node, nested = false) {
    const item = node.matches('.ant-dropdown-menu-submenu-title') ? node.parentElement : node;
    return node.getAttribute('aria-expanded') === 'true' || (nested ? item?.matches('li.ant-dropdown-menu-submenu[role="menuitem"]') && item.classList.contains('ant-dropdown-menu-submenu-open') : node.classList.contains('ant-dropdown-open'));
  }
  function more(node, requireAvailable = true) {
    if (!visible(node) || requireAvailable && !available(node)) return false;
    const labels = [node.getAttribute('aria-label'), node.getAttribute('title'), text(node)].map(value => (value || '').trim().toLowerCase()).filter(Boolean);
    return labels.length ? labels.every(value => moreLabels.has(value)) : Boolean(node.querySelector(moreIconSelector));
  }
  function rowTrigger(node, row, requireAvailable = true) {
    const cell = node.closest('td[unique="_action_"],td.cell__action_');
    return cell?.closest('tr') === row && node.closest('tr') === row && (node.matches('.menu-button.ant-dropdown-trigger') || Boolean(node.querySelector(moreIconSelector))) && more(node, requireAvailable);
  }
  const dangerous = node => Boolean(node.closest('.ant-dropdown-menu-item-danger,.ant-btn-dangerous,[data-danger="true"]') || node.querySelector('[data-testid$="RedIcon"]'));
  function associated(trigger, popup) {
    const refs = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')].filter(Boolean).flatMap(value => value.split(/\s+/));
    if (refs.length) return refs.some(id => { const node = doc.getElementById(id); return node === popup || popup.contains(node); });
    if (trigger.contains(popup)) return true;
    const a = trigger.getBoundingClientRect(), b = popup.getBoundingClientRect();
    if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return false;
    const xGap = Math.max(0, a.left - b.right, b.left - a.right), yGap = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return xGap <= 24 && yGap <= 24;
  }
  async function prepare(resource, { signal, onFailure } = {}) {
    active?.close();
    let failureReason = null, reported = false;
    const safeReason = reason => failureReasons.has(reason) ? reason : 'unexpected';
    function report(reason) {
      const code = safeReason(reason);
      if (!reported) { reported = true; try { onFailure?.(code); } catch { /* Diagnostic callbacks cannot change host lifecycle. */ } }
      return code;
    }
    function remember(reason) { return failureReason ||= safeReason(reason); }
    function fail(reason) { remember(reason); throw new Error('NATIVE_ROW_REJECTED'); }
    function reject(reason) { report(reason); return null; }
    if (stopped || signal?.aborted) return reject('cancelled');
    if (!resource || typeof resource.type !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(resource.id || '')) return reject('source-changed');
    try { if (isEnabled(resource) !== true) return reject('plugin-disabled'); } catch { return reject('unexpected'); }
    const source = resource.element, row = source?.closest?.('tr[data-row-key]'), href = win.location.href;
    let state = 'preparing', closed = false, handedOff = false, wake = null, observer, guard;
    const owned = [], records = new Map(), hoverAttempts = new Map(), serial = ++nextSession;
    let count = 0, deadline = win.performance.now() + Math.max(50, Math.min(10000, timeoutMs));
    function identityValid() {
      if (!source?.isConnected || !row?.isConnected || !visible(source) || !visible(row) || win.location.href !== href || row.getAttribute('data-row-key') !== resource.id) return false;
      try { const fresh = identify(source, win); return fresh?.type === resource.type && fresh.id === resource.id && source.closest('tr[data-row-key]') === row; } catch { return false; }
    }
    function valid() {
      try { return !closed && !stopped && !signal?.aborted && identityValid() && isEnabled(resource) === true; } catch { return false; }
    }
    if (!identityValid()) return reject('source-changed');
    const triggers = [...row.querySelectorAll('.ant-dropdown-trigger')].filter(node => rowTrigger(node, row, false));
    if (triggers.length !== 1) return reject(triggers.length ? 'trigger-ambiguous' : 'trigger-missing');
    const trigger = triggers[0];
    if (!trusted(trigger)) return reject('source-retired');
    if (!available(trigger)) return reject('entry-disabled');
    function triggerCandidates() { return [...row.querySelectorAll('.ant-dropdown-trigger')].filter(node => rowTrigger(node, row, false)); }
    function validTrigger() { return valid() && trigger.isConnected && trigger.closest('tr[data-row-key]') === row && rowTrigger(trigger, row) && triggerCandidates().length === 1; }
    function invalidReason() {
      if (failureReason) return failureReason;
      if (closed || stopped || signal?.aborted) return 'cancelled';
      try { if (isEnabled(resource) !== true) return 'plugin-disabled'; } catch { return 'unexpected'; }
      if (!identityValid() || !trigger.isConnected || trigger.closest('tr[data-row-key]') !== row) return 'source-changed';
      if (!trusted(trigger)) return 'source-retired';
      const candidates = triggerCandidates();
      if (candidates.length !== 1) return candidates.length ? 'trigger-ambiguous' : 'trigger-missing';
      if (!available(trigger)) return 'entry-disabled';
      return 'menu-changed';
    }
    function hasModal() { return [...doc.querySelectorAll('.ant-modal,[role="dialog"],[role="alertdialog"]')].some(visible); }
    function noForeign() { return !hasModal() && popups().filter(visible).every(node => owned.some(entry => entry.popup === node)); }
    function ownedStable() { return owned.every(entry => available(entry.control) && trusted(entry.popup) && visible(entry.popup) && opened(entry.control, entry.nested) && associated(entry.control, entry.popup)); }
    function hoverBindingValid(attempt) {
      return hoverTitle(attempt.control) && available(attempt.control) && attempt.control.parentElement === attempt.item &&
        attempt.control.closest('[role="menu"]') === attempt.menu && owned.some(entry => entry.popup.contains(attempt.control));
    }
    function hover(attempt, enter, closing = false) {
      const check = () => (closing ? identityValid() && triggerCandidates().length === 1 : validTrigger()) && hoverBindingValid(attempt);
      // rc-menu hover mode ignores title click. Public mouse events let its own
      // listeners set state; no class, aria attribute or handler is copied here.
      for (const type of enter ? ['mouseover', 'mouseenter'] : ['mouseout', 'mouseleave']) {
        if (!check()) return false;
        attempt.control.dispatchEvent(new win.MouseEvent(type, { bubbles: type === 'mouseover' || type === 'mouseout', relatedTarget: enter ? null : attempt.menu, view: win }));
      }
      return true;
    }
    function cleanup() {
      observer?.disconnect(); win.clearInterval(guard); signal?.removeEventListener('abort', aborted);
      for (const event of ['pointerdown', 'mousedown', 'keydown', 'contextmenu']) doc.removeEventListener(event, interrupted, true);
      win.removeEventListener('hashchange', routed); win.removeEventListener('popstate', routed);
      wake?.(); if (active === session) active = null;
    }
    function close(reason = 'cancelled') {
      if (closed) return;
      remember(reason);
      const canHide = !handedOff && identityValid() && trigger.isConnected && rowTrigger(trigger, row) && triggerCandidates().length === 1 && owned[0] && trusted(owned[0].popup) && visible(owned[0].popup) && opened(trigger) && associated(trigger, owned[0].popup);
      if (!handedOff) for (const attempt of [...hoverAttempts.values()].reverse()) { try { hover(attempt, false, true); } catch { /* Never replace host cancellation with a business click. */ } }
      hoverAttempts.clear();
      closed = true;
      cleanup();
      if (canHide) { try { trigger.click(); } catch { /* Never compensate by clicking another host control. */ } }
      if (state !== 'idle' && !handedOff) report(failureReason);
    }
    function aborted() { close('cancelled'); }
    function routed() { if (win.location.href !== href) retirement.quarantine(); close('source-changed'); }
    function interrupted(event) { if (state !== 'idle' && event.isTrusted) close('cancelled'); }
    function wait(check, timeoutReason = 'popup-timeout') {
      return new Promise(resolve => {
        let timer, pulse, done = false;
        const finish = value => { if (done) return; done = true; win.clearTimeout(timer); win.clearInterval(pulse); if (wake === run) wake = null; resolve(value); };
        const run = () => {
          if (!validTrigger()) { remember(invalidReason()); return finish(null); }
          if (win.performance.now() >= deadline) { remember(typeof timeoutReason === 'function' ? timeoutReason() : timeoutReason); return finish(null); }
          try { const value = check(); if (value) finish(value); } catch { remember('unexpected'); finish(null); }
        };
        wake = run; timer = win.setTimeout(run, Math.max(0, deadline - win.performance.now())); pulse = win.setInterval(run, 25); run();
      });
    }
    async function openPopup(control, nested) {
      if (!validTrigger()) { remember(invalidReason()); return null; }
      if (!trusted(control)) { remember('source-retired'); return null; }
      if (!available(control)) { remember('entry-disabled'); return null; }
      if (!noForeign()) { remember('blocked-by-dialog'); return null; }
      if (opened(control, nested)) { remember('popup-unproven'); return null; }
      const before = new Map(popups().map(node => [node, visible(node)]));
      let record = null, observedFailure = null, attempt = null;
      if (nested && hoverTitle(control)) {
        attempt = { control, item: control.parentElement, menu: control.closest('[role="menu"]') };
        hoverAttempts.set(control, attempt);
        if (!hover(attempt, true)) { remember(validTrigger() ? 'menu-changed' : invalidReason()); return null; }
      } else control.click();
      const popup = await wait(() => {
        if (hasModal()) { observedFailure = 'blocked-by-dialog'; return null; }
        const added = popups().filter(node => visible(node) && !before.get(node));
        if (added.some(node => !trusted(node))) { observedFailure = 'source-retired'; remember('source-retired'); return null; }
        if (added.length) observedFailure = 'popup-unproven';
        if (!opened(control, nested) || added.length !== 1 || !associated(control, added[0])) return null;
        if (popups().filter(visible).some(node => !owned.some(entry => entry.popup === node) && node !== added[0])) return null;
        // Adopt before resolving: an abort between the wait result and its await
        // continuation must still close a proven popup, even if its menu is empty.
        if (record && record.popup !== added[0]) { observedFailure = 'menu-changed'; return null; }
        if (!record) { record = { control, popup: added[0], nested, hover: attempt }; owned.push(record); }
        if (!rootMenu(added[0])) { observedFailure = added[0].querySelectorAll('[role="menu"]').length ? 'menu-ambiguous' : 'menu-empty'; return null; }
        return added[0];
      }, () => observedFailure || 'popup-timeout');
      return popup && validTrigger() ? record : null;
    }
    async function hide(record) {
      if (!validTrigger() || !owned.includes(record) || !available(record.control) || !trusted(record.popup) || !visible(record.popup) || !opened(record.control, record.nested) || !associated(record.control, record.popup)) { remember(!validTrigger() ? invalidReason() : 'menu-changed'); return false; }
      if (record.hover) {
        if (!hover(record.hover, false)) { remember(validTrigger() ? 'menu-changed' : invalidReason()); return false; }
      } else record.control.click();
      const hidden = await wait(() => !visible(record.popup) && !opened(record.control, record.nested), 'menu-changed');
      if (hidden) { owned.splice(owned.indexOf(record), 1); if (record.hover) hoverAttempts.delete(record.control); }
      return Boolean(hidden);
    }
    async function collect(record, path = [], seen = new Set()) {
      if (!validTrigger()) fail(invalidReason());
      if (path.length > maxDepth) fail('depth-limit');
      if (!noForeign() || !ownedStable() || seen.has(record.popup)) fail(hasModal() ? 'blocked-by-dialog' : 'popup-unproven');
      const nextSeen = new Set(seen).add(record.popup), nodes = items(record.popup), labels = nodes.map(label), tree = [];
      for (const node of nodes) {
        if (!trusted(node)) fail('source-retired');
        if (!validTrigger()) fail(invalidReason());
        if (!noForeign() || !ownedStable()) fail(hasModal() ? 'blocked-by-dialog' : 'menu-changed');
        if (++count > maxItems) fail('depth-limit');
        const name = label(node); if (!name) continue;
        const kind = submenu(node) ? 'submenu' : 'leaf', ambiguous = labels.filter(value => value === name).length !== 1;
        const disabled = !available(node) || kind === 'submenu' && !available(opener(node)) || ambiguous, danger = dangerous(node);
        const id = `native-row-${serial}-${count}`, step = Object.freeze({ label: name, kind, danger }), steps = [...path, step];
        const item = { id, label: name, disabled, danger };
        if (disabled) item.reasonCode = ambiguous ? 'menu-ambiguous' : 'entry-disabled';
        if (ambiguous) item.reason = getLocale() === 'en-US' ? 'Ambiguous native menu entry.' : '原生菜单项不唯一。';
        if (kind === 'submenu') {
          item.children = [];
          if (!disabled && steps.length <= maxDepth) {
            const child = await openPopup(opener(node), true); if (!child) fail(failureReason || 'popup-unproven');
            item.children = await collect(child, steps, nextSeen);
            if (!await hide(child)) fail(failureReason || 'menu-changed');
          } else if (!disabled) { item.disabled = true; item.reasonCode = 'depth-limit'; item.reason = getLocale() === 'en-US' ? 'Native menu depth limit.' : '原生菜单层级超过限制。'; }
          records.set(id, { path: steps, disabled: item.disabled, reason: item.reasonCode, kind });
        } else records.set(id, { path: steps, disabled, reason: item.reasonCode, kind });
        tree.push(Object.freeze(item));
      }
      return Object.freeze(tree);
    }
    async function execute(id) {
      const record = records.get(id);
      const unsupported = reason => ({ status: 'unsupported', reason: report(reason) });
      if (closed || state !== 'idle') return unsupported(failureReason || 'cancelled');
      failureReason = null; reported = false;
      if (!record) return unsupported('menu-changed');
      if (record.disabled) return unsupported(record.reason || 'entry-disabled');
      if (record.kind !== 'leaf') return unsupported('menu-changed');
      if (!validTrigger()) { remember(invalidReason()); close(); return unsupported(failureReason); }
      state = 'executing'; deadline = win.performance.now() + Math.max(50, Math.min(10000, timeoutMs));
      try {
        let surface = await openPopup(trigger, false); if (!surface) fail(failureReason || 'popup-unproven');
        for (let index = 0; index < record.path.length; index++) {
          const step = record.path[index], matches = items(surface.popup).filter(node => label(node) === step.label);
          if (matches.length !== 1) fail(matches.length ? 'menu-ambiguous' : 'menu-changed');
          const node = matches[0], kind = submenu(node) ? 'submenu' : 'leaf';
          if (!trusted(node)) fail('source-retired');
          if (!validTrigger()) fail(invalidReason());
          if (!available(node)) fail('entry-disabled');
          if (kind !== step.kind || dangerous(node) !== step.danger || !noForeign() || !ownedStable()) fail(hasModal() ? 'blocked-by-dialog' : 'menu-changed');
          if (kind === 'submenu') { surface = await openPopup(opener(node), true); if (!surface) fail(failureReason || 'popup-unproven'); }
          else {
            if (index !== record.path.length - 1) fail('menu-changed');
            handedOff = true; closed = true; cleanup(); node.click();
            return { status: 'handed-off', surface: 'native-action' };
          }
        }
      } catch { remember('unexpected'); close(); }
      return unsupported(failureReason || 'unexpected');
    }
    const session = { tree: [], execute, close };
    if (!validTrigger()) return reject(invalidReason());
    if (!noForeign()) return reject('blocked-by-dialog');
    active = session;
    observer = new win.MutationObserver(() => { if (!validTrigger()) close(invalidReason()); else wake?.(); });
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true });
    guard = win.setInterval(() => { if (!validTrigger()) close(invalidReason()); }, 100);
    signal?.addEventListener('abort', aborted, { once: true });
    for (const event of ['pointerdown', 'mousedown', 'keydown', 'contextmenu']) doc.addEventListener(event, interrupted, true);
    win.addEventListener('hashchange', routed); win.addEventListener('popstate', routed);
    try {
      const root = await openPopup(trigger, false); if (!root) fail(failureReason || 'popup-unproven');
      session.tree = await collect(root);
      if (!session.tree.length) fail('menu-empty');
      if (!await hide(root) || !validTrigger()) fail(failureReason || (!validTrigger() ? invalidReason() : 'menu-changed'));
      state = 'idle'; return Object.freeze(session);
    } catch { remember('unexpected'); close(); report(failureReason); return null; }
  }
  return { prepare, stop() { stopped = true; active?.close(); } };
}
