import { identifyResource, resourceUrl, sameResource, currentResource, isVisible } from '../resources.js';
import { buildNativeActionTree, getNativeAction } from './catalog.js';
import { nativeIntent, nativeEntry, findNativeControl, findNativeSurface } from './controls.js';
import { nativePopups, nativeMenuOpener, ownedNativePopup } from './popup.js';
import { nativeRowMenuTrigger, nativeRowMenuReason } from '../native-menu.js';
import { nativeErrorMessage } from './errors.js';
import { nativeRetirement } from './retirement.js';

const ids = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const types = new Set(['organization', 'datacenter', 'cluster', 'host', 'vm', 'vmVolume', 'disk']);
const blockedSelector = 'button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[disabled],[aria-disabled="true"],[inert],.toolbar,.operation-button-content,.actions-wrapper,.ant-dropdown-trigger,[data-rivetin-context-menu],[data-rivetin-object-menu],[data-rivetin-action-form]';
const menuSelector = '[data-rivetin-context-menu],[data-rivetin-object-menu],[data-rivetin-action-form]';
function plain(value) {
  if (!types.has(value?.type) || !ids(value?.id)) return null;
  return { type: value.type, id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 200) : '' };
}

// Only observed native entry controls are clicked. Configuration fields and
// final confirmation remain entirely under the host's control.
// Caller must unmount the context menu before open(); a read snapshot must retain
// its identity (do not JSON-clone it) so a new bind cannot replay an older menu.
export function createNativeActionProvider({ win, history, getLocale = () => 'zh-CN', isEnabled = () => true, onError = () => {}, timeoutMs = 5000 } = {}) {
  if (!win?.document) throw new Error('NATIVE_UI_WINDOW_REQUIRED');
  const doc = win.document, proofs = new WeakMap();
  const { snapshot: nativeSnapshot, quarantine, trusted: trustedControl } = nativeRetirement(win);
  const contextKey = () => { const value = currentResource(win); return value ? `${value.type}:${value.id}` : ''; };
  let observedContext = contextKey();
  let rejection = null;
  let binding = null, serial = 0, generation = 0, pending = null, stopped = false;
  function fail(reason, notify = false) {
    const result = { status: 'unsupported', reason };
    if (notify) { try { onError(nativeErrorMessage(reason, getLocale())); result.reported = true; } catch { /* The caller can still present the fixed diagnostic. */ } }
    return result;
  }
  function enabled(resource) { try { return !stopped && isEnabled(resource) === true; } catch { return false; } }
  function visible(node) {
    if (!node || node.ownerDocument !== doc || !node.isConnected || !isVisible(node, win)) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = win.getComputedStyle(current);
      if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert') || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
    }
    return true;
  }
  function observeContext(owned = false) {
    const next = contextKey();
    if (next !== observedContext) { if (!owned) quarantine(); observedContext = next; }
  }
  const trustedPane = ({ pane, title }) => trustedControl(pane) && trustedControl(title);
  const initialResource = currentResource(win);
  const initial = nativeSnapshot({ includeRows: false });
  const unknownPanes = initial.panes.filter(pane => initialResource?.type !== 'vm' || pane.getAttribute('data-resource-id') !== initialResource.id);
  // A retained hidden popup is still usable after a proven opener transition;
  // only observed loss of object ownership retires those external menu nodes.
  quarantine({ panes: unknownPanes, controls: initial.controls.filter(control => unknownPanes.includes(control.closest('.drawer-content-inner'))) });
  const retiredReason = resource => (rejection && sameResource(rejection.resource, resource) || binding && sameResource(binding.resource, resource) && !trustedControl(binding.source)) ? 'source-retired' : null;
  function atResource(resource) {
    if (resource.type === 'organization') return resource.id === 'current' && /^#\/overview\/?$/.test(win.location.hash);
    return sameResource(resource, currentResource(win));
  }
  function navigationHref(value, resource) {
    const parsed = value && resourceUrl(value, win.location.origin);
    if (!parsed || !sameResource(parsed, resource)) return null;
    const url = new URL(parsed.href), [, search = ''] = url.hash.slice(1).split('?'), params = new URLSearchParams(search);
    // Never navigate an action-shaped or unknown query string just because its
    // path contains the right resource ID. Only observed read-only views remain.
    if ([...params.keys()].some(key => !['view', 'sidebar'].includes(key)) || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return null;
    try {
      if (params.has('view') && !['detail', 'overview', 'vms', 'hosts', 'disks', 'vmVolumes'].includes(JSON.parse(params.get('view')))) return null;
      if (params.has('sidebar')) {
        const side = JSON.parse(params.get('sidebar'));
        if (!side || Object.keys(side).some(key => !['type', 'id', 'view'].includes(key)) || side.view !== 'detail' || !sameResource(side, resource)) return null;
      }
    } catch { return null; }
    return url.href;
  }
  function sidebarListHref(resource) {
    if (resource.type !== 'vm') return null;
    const url = new URL(win.location.href), [route, query = ''] = url.hash.slice(1).split('?');
    const params = new URLSearchParams(query);
    if ([...params.keys()].some(key => !['view', 'sidebar'].includes(key)) ||
        [...new Set(params.keys())].some(key => params.getAll(key).length !== 1) || !params.has('sidebar')) return null;
    try {
      const side = JSON.parse(params.get('sidebar')), view = params.has('view') ? JSON.parse(params.get('view')) : null;
      if (!side || Object.keys(side).some(key => !['type', 'id', 'view'].includes(key)) || side.view !== 'detail' || !sameResource(side, resource)) return null;
      const list = /^\/vms\/?$/.test(route) && (view === null || view === 'vms') ||
        /^\/(?:clusters|hosts|datacenters)\/[A-Za-z0-9_-]{1,128}\/?$/.test(route) && view === 'vms';
      if (!list) return null;
      params.delete('sidebar'); url.hash = route + (params.size ? `?${params}` : '');
      return url.href;
    } catch { return null; }
  }
  function safeSelect(resource, node) {
    if (!visible(node) || node.closest(blockedSelector) || !resource.element?.contains(node)) return null;
    if (!sameResource(identifyResource(node, win), resource)) return null;
    const enclosingLink = node.closest('a[href]');
    if (enclosingLink && (enclosingLink.hasAttribute('download') || enclosingLink.target && enclosingLink.target !== '_self' || !navigationHref(enclosingLink.href, resource))) return null;
    if (node.tagName === 'A') return !node.hasAttribute('download') && (!node.target || node.target === '_self') && navigationHref(node.href, resource) ? node : null;
    if (node.matches('td[unique="name"],td[unique="path"],td.cell_name,td.cell_path') && node.closest('tr[data-row-key]')?.getAttribute('data-row-key') === resource.id) return node;
    if (node.matches('.name') && node.closest('.host-info,.cluster-info,.datacenter-info')) return node;
    return null;
  }
  function currentBinding(resource) {
    observeContext();
    if (!binding || !resource || !sameResource(binding.resource, resource) || !enabled(resource) || win.location.href !== binding.href || !visible(binding.source)) return null;
    if (!trustedControl(binding.source)) return null;
    const fresh = identifyResource(binding.source, win);
    if (!fresh || !sameResource(fresh, resource) || fresh.internal !== binding.internal || fresh.select !== binding.select || fresh.href !== binding.navigationHref) return null;
    return fresh;
  }
  function canNavigate(resource, fresh) {
    return Boolean(fresh && (atResource(resource) || safeSelect(fresh, binding.select) || navigationHref(binding.navigationHref, resource)));
  }
  function close() {
    if (pending) { const operation = pending; pending = null; operation.cancelled = true; operation.wake?.(); operation.dispose?.(); }
  }
  function invalidate() { generation++; binding = null; close(); }
  function routeChanged(event) {
    const operation = pending;
    const hashEdge = event?.type === 'hashchange' && typeof event.oldURL === 'string' && typeof event.newURL === 'string';
    // The reset owns exactly one native edge, while still at its reset URL.
    // A current-URL match cannot erase queued evidence of an external trip.
    if (operation?.resetHref && hashEdge && event.oldURL !== event.newURL) {
      if (!operation.resetObserved && event.oldURL === operation.resetEdge.from && event.newURL === operation.resetEdge.to && win.location.href === operation.resetHref) {
        observeContext(true); operation.resetObserved = true;
        operation.resetTimer = win.setTimeout(() => {
          if (current(operation) && win.location.href === operation.resetHref) { operation.resetSettled = true; operation.wake?.(); }
        }, 0);
        return;
      }
      quarantine(); observeContext(); invalidate(); return;
    }
    // Hash events are queued: reading only location can conceal an A-B-A trip.
    // A superseded cross-resource event is evidence that existing DOM retired.
    if (hashEdge && event.newURL !== win.location.href) {
      const oldResource = resourceUrl(event.oldURL, win.location.origin);
      const newResource = resourceUrl(event.newURL, win.location.origin);
      const key = resource => resource ? `${resource.type}:${resource.id}` : '';
      if (key(oldResource) !== key(newResource)) { quarantine(); observeContext(); invalidate(); return; }
    }
    // URL-less history notifications are not reset proof. The operation must
    // still receive the exact native edge and settle before selecting a row.
    if (operation?.resetHref === win.location.href && !hashEdge) return;
    if (operation?.ownedHref === win.location.href) { observeContext(true); return; }
    if (operation?.expectedView && !operation.ownedHref && expectedRoute(operation)) {
      observeContext(true);
      operation.ownedHref = win.location.href;
      generation++; binding = null;
      return;
    }
    observeContext();
    invalidate();
  }
  let unlisten = null;
  if (typeof history?.listen === 'function') {
    try { const result = history.listen(routeChanged); if (typeof result === 'function') unlisten = result; }
    catch { /* Hash/pop events and exact href checks still guard navigation. */ }
  }
  win.addEventListener('hashchange', routeChanged); win.addEventListener('popstate', routeChanged);
  function bindSource(resourceDOM) {
    observeContext();
    invalidate(); serial++; rejection = null;
    if (stopped) return false;
    const source = resourceDOM?.nodeType === 1 ? resourceDOM : resourceDOM?.element;
    if (!visible(source)) return false;
    if (!trustedControl(source)) { rejection = { resource: plain(identifyResource(source, win)) }; return false; }
    const identified = identifyResource(source, win), resource = plain(identified);
    if (!resource || !enabled(resource) || resourceDOM?.type && !sameResource(resourceDOM, resource)) return false;
    binding = { source, resource, select: identified.select, navigationHref: identified.href, internal: identified.internal,
      href: win.location.href, serial, generation };
    return true;
  }
  function read(input) {
    const resource = plain(input), fresh = currentBinding(resource);
    const snapshot = Object.freeze({ type: resource?.type || input?.type || '', id: resource?.id || '', name: fresh?.name || '', status: 'UNKNOWN' });
    const data = Object.freeze({ snapshot, capabilities: Object.freeze({}), native: Object.freeze({ canNavigate: Boolean(resource && canNavigate(resource, fresh)), ...(retiredReason(resource) ? { reason: retiredReason(resource) } : {}) }) });
    const proof = { serial: binding?.serial, generation, href: win.location.href, resource, used: false };
    proofs.set(data, proof); proofs.set(snapshot, proof);
    return data;
  }
  function proofFor(resource, data) {
    const proof = data && proofs.get(data);
    return proof && !proof.used && binding && proof.serial === binding.serial && proof.generation === generation && proof.href === win.location.href && sameResource(proof.resource, resource) ? proof : null;
  }
  function tree({ resource: input, data, locale = getLocale() } = {}) {
    const resource = plain(input), valid = resource && proofFor(resource, data) && currentBinding(resource);
    const safeData = valid ? data : { snapshot: { type: resource?.type, id: resource?.id, status: 'UNKNOWN' }, capabilities: {}, native: { canNavigate: false, reason: retiredReason(resource) || 'navigation-unavailable' } };
    return buildNativeActionTree({ resource: resource || input, data: safeData, locale });
  }
  function expectedRoute(operation) {
    if (!atResource(operation.resource)) return false;
    try {
      const params = new URLSearchParams(win.location.hash.split('?')[1]);
      if ([...params.keys()].some(key => !['view', 'sidebar'].includes(key)) || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return false;
      const side = params.has('sidebar') ? JSON.parse(params.get('sidebar')) : null;
      if (side && Object.keys(side).some(key => !['type', 'view', 'id'].includes(key))) return false;
      const view = side ? side.view : JSON.parse(params.get('view') || '"detail"');
      return view === operation.expectedView;
    } catch { return false; }
  }
  function panes() {
    return [...doc.querySelectorAll('.drawer-content-inner')].filter(visible).flatMap(pane => {
      const titles = [...pane.querySelectorAll('.title-wrapper .header-title')].filter(visible);
      return titles.length === 1 ? [{ pane, title: titles[0] }] : [];
    });
  }
  function obstructed() {
    return [...doc.querySelectorAll('.ant-modal,[role="dialog"],[role="alertdialog"],.ant-dropdown')].some(visible);
  }
  function current(operation) {
    return pending === operation && !operation.cancelled && !operation.signal?.aborted && enabled(operation.resource);
  }
  function wait(operation, check) {
    return new Promise(resolve => {
      let observer, timer, pulse, ended = false;
      const finish = value => {
        if (ended) return; ended = true; observer?.disconnect(); win.clearTimeout(timer); win.clearInterval(pulse);
        operation.signal?.removeEventListener('abort', run); if (operation.wake === run) operation.wake = null; resolve(value);
      };
      const run = () => {
        if (!current(operation) || win.performance.now() >= operation.deadline) return finish(null);
        try { const result = check(); if (result) finish(result); } catch { finish(null); }
      };
      operation.wake = run;
      observer = new win.MutationObserver(run); observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = win.setTimeout(() => finish(null), Math.max(0, operation.deadline - win.performance.now()));
      pulse = win.setInterval(run, 50); operation.signal?.addEventListener('abort', run, { once: true }); run();
    });
  }
  async function open(request = {}, { signal } = {}) {
    const resource = plain(request.resource);
    const action = resource && getNativeAction(request.actionId, resource);
    const attested = resource && proofFor(resource, request.data) ? request.data : request.snapshot;
    const proof = resource && proofFor(resource, attested);
    const intent = nativeIntent(request.actionId);
    if (!action || !intent) return fail('action-unknown');
    if (!enabled(resource)) return fail('plugin-disabled');
    if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
    if (!proof) return fail(retiredReason(resource) || 'proof-expired');
    if (!currentBinding(resource)) return fail(retiredReason(resource) || 'source-changed');
    close();
    const operation = { resource, proof, signal, cancelled: false,
      deadline: win.performance.now() + Math.min(8000, Math.max(50, timeoutMs)), expectedView: null };
    pending = operation;
    const interrupted = event => { if (event.isTrusted && current(operation)) close(); };
    const events = ['pointerdown', 'mousedown', 'keydown', 'contextmenu'];
    for (const event of events) doc.addEventListener(event, interrupted, true);
    operation.dispose = () => { win.clearTimeout(operation.resetTimer); for (const event of events) doc.removeEventListener(event, interrupted, true); };
    try {
      // The menu's event target must be gone before the official UI gets a click.
      await Promise.resolve();
      if (pending !== operation || operation.cancelled || signal?.aborted || !enabled(resource) || !proofFor(resource, attested)) {
        if (pending === operation) pending = null;
        return { status: 'cancelled' };
      }
      let fresh = currentBinding(resource);
      if (!fresh) return fail(retiredReason(resource) || 'source-changed');
      if (doc.querySelector(menuSelector) || obstructed()) return fail('blocked-by-dialog');
      if (!canNavigate(resource, fresh)) return fail('navigation-unavailable');
      proof.used = true;
      let before = panes(), alreadyAtTarget = atResource(resource);
      const source = binding.source;
      const sourceName = fresh.name, sourceRow = source.closest('tr[data-row-key]');
      if (alreadyAtTarget && before.length === 1 && !trustedPane(before[0])) {
        const resetHref = sidebarListHref(resource), select = safeSelect(fresh, binding.select);
        // Never rehabilitate a retired pane or click its close/editor controls.
        // A fresh exact list selection can rebuild the official sidebar after
        // its read-only route has removed every old pane from the document.
        if (resetHref && select && !before[0].pane.contains(source)) {
          const oldPanes = [...doc.querySelectorAll('.drawer-content-inner')];
          quarantine(nativeSnapshot({ includeRows: false }));
          operation.resetEdge = { from: win.location.href, to: resetHref };
          operation.resetHref = resetHref; operation.resetObserved = false; operation.resetSettled = false;
          win.location.hash = new URL(resetHref).hash;
          const removed = await wait(operation, () => operation.resetObserved && operation.resetSettled && win.location.href === resetHref &&
            !obstructed() && oldPanes.every(pane => !pane.isConnected) &&
            sameResource(identifyResource(source, win), resource) && safeSelect(identifyResource(source, win), select));
          if (!current(operation)) return { status: 'cancelled' };
          if (!removed) { pending = null; return fail('source-retired', true); }
          fresh = identifyResource(source, win); before = panes(); alreadyAtTarget = false;
          operation.resetHref = null;
        }
      }
      if (!atResource(resource)) {
        const select = safeSelect(fresh, binding.select), href = navigationHref(binding.navigationHref, resource);
        operation.expectedView = 'detail';
        // Navigation can reuse React handlers. Only the panes and controls that
        // existed before our selector click lose their ownership proof. The
        // exact source row stays eligible during this owned selection.
        quarantine(nativeSnapshot({ includeRows: false }));
        if (select) select.click();
        else if (href) win.location.hash = new URL(href).hash;
        else { pending = null; return fail('navigation-unavailable'); }
      }
      const target = await wait(operation, () => {
        if (!atResource(resource) || obstructed()) return null;
        const candidates = panes(); if (candidates.length !== 1) return null;
        const candidate = candidates[0], { pane, title } = candidate;
        if (!trustedPane(candidate)) return null;
        if (title.textContent.trim().replace(/\s+/g, ' ') !== sourceName) return null;
        const explicitId = pane.getAttribute('data-resource-id');
        if (explicitId && explicitId !== resource.id) return null;
        if (!alreadyAtTarget && !explicitId && before.some(old => old.pane === pane && old.title === title)) return null;
        if (alreadyAtTarget && !pane.contains(source) && !explicitId) {
          const row = source.closest('tr[data-row-key]');
          if (!row || row.getAttribute('data-row-key') !== resource.id || !row.classList.contains('active-row')) return null;
        }
        return candidate;
      });
      if (!current(operation)) return { status: 'cancelled' };
      if (!target) { pending = null; return fail(obstructed() ? 'blocked-by-dialog' : panes().some(pane => !trustedPane(pane)) ? 'source-retired' : panes().length ? 'target-mismatch' : 'target-timeout', true); }
      operation.ownedHref = win.location.href;
      const identityStable = () => {
        const candidates = panes();
        return atResource(resource) && visible(target.pane) && trustedControl(source) && candidates.length === 1 &&
          trustedPane(target) &&
          candidates[0].pane === target.pane && candidates[0].title === target.title &&
          (!sourceRow || sourceRow.isConnected && sourceRow.getAttribute('data-row-key') === resource.id) &&
          target.title.textContent.trim().replace(/\s+/g, ' ') === sourceName &&
          (!target.pane.hasAttribute('data-resource-id') || target.pane.getAttribute('data-resource-id') === resource.id);
      };
      const stable = () => current(operation) && identityStable();
      const registerPopupCleanup = (opener, popup, href, ownsOpener) => {
        operation.popupCleanup = () => {
          if (identityStable() && trustedControl(opener) && trustedControl(popup) && visible(opener) && ownsOpener() && !opener.closest('[disabled],[aria-disabled="true"],[inert],.is-disabled,.ant-btn-loading,.ant-dropdown-disabled,.ant-btn-disabled,.ant-dropdown-menu-item-disabled,.ant-dropdown-menu-submenu-disabled') && win.location.href === href && visible(popup) && nativePopups(win).every(p => p === popup) &&
              ![...doc.querySelectorAll('.ant-modal,[role="dialog"]')].some(visible) &&
              (opener.classList.contains('ant-dropdown-open') || opener.getAttribute('aria-expanded') === 'true')) opener.click();
        };
      };
      // Non-snapshot editors are on the official Details tab. Selecting the tab
      // only navigates; a second identity check precedes the editor click.
      const entry = nativeEntry(intent);
      if (entry?.kind !== 'tab' && !entry?.tabView && intent !== 'snapshots') {
        const tabs = [...target.pane.querySelectorAll('.detail-tabs .tab-item')].filter(visible);
        const details = tabs.filter(tab => ['详情', 'Details'].includes(tab.textContent.trim()));
        if (details.length === 1 && !details[0].classList.contains('active') && details[0].getAttribute('aria-selected') !== 'true') {
          if (!stable()) return fail('source-changed');
          if (obstructed()) return fail('blocked-by-dialog');
          if (!trustedControl(details[0])) return fail('source-retired', true);
          if (details[0].closest('[disabled],[aria-disabled="true"],[inert],.is-disabled,.ant-btn-loading,.ant-dropdown-disabled,.ant-btn-disabled,.ant-dropdown-menu-item-disabled,.ant-dropdown-menu-submenu-disabled')) return fail('entry-disabled');
          operation.expectedView = 'detail'; operation.ownedHref = null; details[0].click();
        }
      }
      if (entry?.kind === 'row-menu') {
        const before = new Set(nativePopups(win));
        if (!stable()) return fail('source-changed');
        if (obstructed()) return fail('blocked-by-dialog');
        const rowResource = { ...fresh, element: sourceRow || source };
        const trigger = nativeRowMenuTrigger(rowResource, win);
        if (!trigger) return fail(nativeRowMenuReason(rowResource, win));
        if (!trustedControl(trigger)) return fail('source-retired', true);
        trigger.click();
        const ownsOpener = () => nativeRowMenuTrigger(rowResource, win) === trigger;
        const popup = await wait(operation, () => {
          const candidate = stable() && trustedControl(trigger) && ownsOpener() && ownedNativePopup(win, trigger, before);
          return trustedControl(candidate) ? candidate : null;
        });
        if (popup) registerPopupCleanup(trigger, popup, win.location.href, ownsOpener);
        if (!current(operation)) return { status: 'cancelled' };
        if (popup) operation.handedOff = true;
        pending = null;
        return popup ? { status: 'handed-off', surface: 'native-menu' } : fail(nativePopups(win).some(p => !before.has(p)) ? 'popup-unproven' : 'popup-timeout');
      }
      if (entry?.tabView && entry.kind !== 'tab') {
        const tabIntent = entry.tabView === 'snapshot' ? 'snapshots' : entry.tabView;
        const tab = findNativeControl({ win, pane: target.pane, intent: tabIntent });
        if (!stable()) return fail('source-changed');
        if (obstructed()) return fail('blocked-by-dialog');
        if (!tab) return fail(findNativeControl({ win, pane: target.pane, intent: tabIntent, diagnostic: true }));
        if (!trustedControl(tab)) return fail('source-retired', true);
        operation.expectedView = entry.tabView; operation.ownedHref = null; tab.click();
        const activeTab = await wait(operation, () => stable() && expectedRoute(operation));
        if (!current(operation)) return { status: 'cancelled' };
        if (!activeTab) return fail('surface-timeout');
      }
      let ownedMenu = null;
      if (['edit-item', 'more-item'].includes(entry?.kind)) {
        const opener = nativeMenuOpener(win, target.pane, entry.kind), before = new Set(nativePopups(win));
        if (!stable()) return fail('source-changed');
        if (obstructed()) return fail('blocked-by-dialog');
        if (!opener) return fail(nativeMenuOpener(win, target.pane, entry.kind, true));
        if (!trustedControl(opener)) return fail('source-retired', true);
        const popupHref = win.location.href;
        opener.click();
        ownedMenu = await wait(operation, () => {
          const candidate = stable() && ownedNativePopup(win, opener, before);
          return trustedControl(candidate) ? candidate : null;
        });
        if (ownedMenu) registerPopupCleanup(opener, ownedMenu, popupHref, () => target.pane.contains(opener) && nativeMenuOpener(win, target.pane, entry.kind) === opener);
        if (!current(operation)) return { status: 'cancelled' };
        if (!ownedMenu) return fail(nativePopups(win).some(p => !before.has(p)) ? 'popup-unproven' : 'popup-timeout');
      }
      const unobstructed = () => ownedMenu ? visible(ownedMenu) && nativePopups(win).every(p => p === ownedMenu) && ![...doc.querySelectorAll('.ant-modal,[role="dialog"]')].some(visible) : !obstructed();
      const control = await wait(operation, () => stable() && unobstructed() && findNativeControl({ win, pane: target.pane, intent, menu: ownedMenu }));
      if (!current(operation)) return { status: 'cancelled' };
      if (!control || !trustedControl(control) || !stable() || !unobstructed() || findNativeControl({ win, pane: target.pane, intent, menu: ownedMenu }) !== control) {
        pending = null; return fail(control && !trustedControl(control) ? 'source-retired' : !identityStable() ? 'source-changed' : !unobstructed() ? 'blocked-by-dialog' : findNativeControl({win, pane: target.pane, intent, menu: ownedMenu, diagnostic: true}), true);
      }
      const beforeModals = new Set(doc.querySelectorAll('.ant-modal'));
      // No final submit, device-specific action or field modification is allowed.
      operation.expectedView = entry?.kind === 'tab' ? entry.tabView : intent === 'snapshots' ? 'snapshot' : null;
      if (operation.expectedView) operation.ownedHref = null;
      const lockedHref = win.location.href;
      if (intent === 'console' && win.navigator.userActivation && !win.navigator.userActivation.isActive) return fail('activation-expired');
      control.click();
      if (entry?.result === 'handoff') {
        operation.handedOff = true;
        pending = null;
        return { status: 'handed-off', surface: 'native-action' };
      }
      const surface = await wait(operation, () => {
        if (!stable() || !operation.expectedView && win.location.href !== lockedHref) return null;
        if (operation.expectedView) return control.isConnected && (control.classList.contains('active') || control.getAttribute('aria-selected') === 'true') && expectedRoute(operation) ? control : null;
        return findNativeSurface({ win, intent, before: beforeModals });
      });
      if (!current(operation)) return { status: 'cancelled' };
      pending = null;
      if (!surface) return fail('surface-timeout', true);
      return { status: 'opened', surface: operation.expectedView ? 'tab' : 'dialog' };
    } catch { pending = null; return fail('unexpected', true); }
    finally {
      if (!operation.handedOff) operation.popupCleanup?.();
      if (pending === operation) pending = null;
      operation.dispose();
    }
  }
  function stop() {
    if (stopped) return;
    quarantine();
    stopped = true; invalidate();
    win.removeEventListener('hashchange', routeChanged); win.removeEventListener('popstate', routeChanged);
    if (unlisten) { const dispose = unlisten; unlisten = null; try { dispose(); } catch { /* Do not patch host history to compensate. */ } }
  }
  return { kind: 'native-ui', handoffBeforeOpen: true, bindSource, read, tree, open, close, stop };
}
