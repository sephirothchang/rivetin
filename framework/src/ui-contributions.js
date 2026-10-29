import { validId } from '../shared/identity.js';
import { readUiContributions, contributionVisible, orderContributions, UI_LIMITS } from '../shared/ui-contributions.js';

const queryKey = 'rivetinPage';
const pageId = location => { const values = new URLSearchParams(location?.search || ''); return values.getAll(queryKey).length === 1 ? values.get(queryKey) : null; };
const target = (location, id) => { const values = new URLSearchParams(location.search || ''); if (id) values.set(queryKey, id); else values.delete(queryKey); return { ...location, search: values.size ? '?' + values : '' }; };
const icons = Object.freeze({ tool: '⚙', convert: '⇄', edit: '✎', network: '⋈', 'arrow-right': '→' });
const contextKey = context => JSON.stringify([context.section, context.clusterId]);

export function installUiContributions({ win, history, resolveHost, renderPage, onStatus = () => {} }) {
  let plugins = new Map(), pages = new Map(), contributions = [], current = null, pending = null, locale = 'zh-CN', disposed = false, generation = 0;
  const links = new Map(), inflight = new Map(), supported = history && ['listen', 'block', 'push', 'replace'].every(key => typeof history[key] === 'function');
  let guard = null, guardFocus = null;
  const t = (zh, en) => locale === 'en-US' ? en : zh;
  function removeGuard() { guard?.remove(); guard = null; pending = null; guardFocus?.focus?.(); guardFocus = null; }
  function showGuard(next, action) {
    pending = { next, action }; if (guard) return;
    guardFocus = win.document.activeElement;
    guard = win.document.createElement('div'); guard.className = 'rv-workpage-guard'; guard.setAttribute('data-c89-plugin-ui', '');
    const panel = win.document.createElement('section'); panel.setAttribute('role', 'alertdialog'); panel.setAttribute('aria-modal', 'true');
    const title = win.document.createElement('h2'); title.id = 'rv-workpage-exit-title'; title.textContent = t('存在未保存的工作页数据', 'Unsaved page data'); panel.setAttribute('aria-labelledby', title.id);
    const message = win.document.createElement('p'); message.textContent = t('取消以保留当前页面，或丢弃页面数据并离开。', 'Keep this page, or discard its data and leave.');
    const cancel = win.document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('取消', 'Cancel'); cancel.dataset.rvWorkpageCancel = '';
    const discard = win.document.createElement('button'); discard.type = 'button'; discard.textContent = t('丢弃并退出', 'Discard and leave'); discard.dataset.rvWorkpageDiscard = '';
    cancel.onclick = removeGuard;
    discard.onclick = () => { const go = pending; if (current) current.dirty = false; removeGuard(); if (go) history[go.action === 'PUSH' ? 'push' : 'replace'](go.next); };
    guard.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); removeGuard(); } if (event.key === 'Tab') { event.preventDefault(); (win.document.activeElement === cancel ? discard : cancel).focus(); } };
    panel.append(title, message, cancel, discard); guard.append(panel); win.document.body.append(guard); cancel.focus();
  }
  function close() {
    removeGuard(); if (!current) return;
    const old = current; current = null; generation++;
    const restoreFocus = old.root.contains(win.document.activeElement);
    old.abort.abort(); try { old.view.dispose(); } catch { onStatus('UI_PAGE_CLEANUP_FAILED', old.entry.pluginId); } old.root.remove();
    for (const [name, value] of old.attributes) { if (value === null) old.host.content.removeAttribute(name); else old.host.content.setAttribute(name, value); }
    if (history.location.pathname === old.pathname) for (const [node, values] of old.selection) for (const [name, value] of values) { if (value === null) node.removeAttribute(name); else node.setAttribute(name, value); }
    for (const link of links.values()) link.button.removeAttribute('aria-current');
    if (restoreFocus && old.returnFocus?.isConnected && pages.has(old.entry.id)) old.returnFocus.focus?.();
  }
  function props(signal, epoch) { return { active: true, locale, signal, context: current.host.context, onDirtyChange(value) { if (current?.epoch === epoch && !signal.aborted && typeof value === 'boolean') current.dirty = value; } }; }
  function hostFor(slot) { try { return resolveHost(slot); } catch { return null; } }
  function usable(host) { return host && host.content?.isConnected && host.before?.isConnected && host.navigation?.isConnected; }
  function route() {
    const requested = pageId(history.location), entry = pages.get(requested);
    const host = entry && hostFor(entry.page.slot);
    if (!entry || !usable(host) || !entry.references.some(row => contributionVisible(row, host.context))) { close(); if (requested) onStatus('UI_PAGE_TARGET_UNAVAILABLE'); return; }
    if (current?.entry.id === entry.id && current.entry.packageId === entry.packageId && current.host.content === host.content && contextKey(current.host.context) === contextKey(host.context)) {
      try { current.view.update(props(current.abort.signal, current.epoch)); } catch { close(); onStatus('UI_PAGE_RENDER_FAILED', entry.pluginId); } return;
    }
    close();
    const root = win.document.createElement('section'); root.className = 'rv-workpage-root'; root.tabIndex = -1; root.setAttribute('data-c89-plugin-ui', ''); root.setAttribute('data-rivetin-workpage', entry.id);
    const attributes = ['hidden', 'aria-hidden', 'inert', 'data-rivetin-workpage-native'].map(name => [name, host.content.getAttribute(name)]);
    const selection = [...(host.selectionRoot || host.navigation).querySelectorAll('[aria-current],[aria-selected="true"],.ant-menu-item-selected')].filter(node => !node.hasAttribute('data-rivetin-ui-contribution')).map(node => [node, ['aria-current', 'aria-selected', 'class'].map(name => [name, node.getAttribute(name)])]);
    for (const [node] of selection) { node.removeAttribute('aria-current'); if (node.hasAttribute('aria-selected')) node.setAttribute('aria-selected', 'false'); node.classList.remove('ant-menu-item-selected'); }
    host.content.setAttribute('data-rivetin-workpage-native', ''); host.content.setAttribute('hidden', ''); host.content.setAttribute('aria-hidden', 'true'); host.content.setAttribute('inert', ''); host.content.after(root);
    const abort = new win.AbortController(), epoch = ++generation;
    current = { entry, pathname: history.location.pathname, returnFocus: win.document.activeElement, host, root, attributes, selection, abort, epoch, dirty: false, view: { update() {}, dispose() {} } };
    try { current.view = renderPage(entry, root, props(abort.signal, epoch), { close: () => history.push(target(history.location, null)) }); }
    catch { close(); onStatus('UI_PAGE_RENDER_FAILED', entry.pluginId); }
  }
  function actionKey(entry, context) { return JSON.stringify([entry.packageId, entry.pluginId, entry.contribution.target.id, contextKey(context)]); }
  function reconcileActions() {
    for (const [key, job] of inflight) {
      const plugin = plugins.get(job.pluginId), host = hostFor(job.slot);
      if (disposed || !plugin || plugin.packageId !== job.packageId || !usable(host) || contextKey(host.context) !== job.contextKey) { job.abort.abort(); inflight.delete(key); }
    }
  }
  function runAction(entry, host) {
    const key = actionKey(entry, host.context); if (inflight.has(key)) return;
    const action = plugins.get(entry.pluginId)?.ui.actions.find(row => row.id === entry.contribution.target.id); if (!action) return;
    const abort = new win.AbortController(), job = { abort, pluginId: entry.pluginId, packageId: entry.packageId, slot: entry.contribution.slot, contextKey: contextKey(host.context) };
    inflight.set(key, job); scan();
    Promise.resolve().then(() => { if (!abort.signal.aborted) return action.run({ context: host.context, locale, signal: abort.signal }); })
      .catch(() => { if (!abort.signal.aborted && inflight.get(key) === job) onStatus('UI_ACTION_FAILED', entry.pluginId); })
      .finally(() => { if (inflight.get(key) === job) { inflight.delete(key); if (!disposed) scan(); } });
  }
  function activate(key) {
    const entry = contributions.find(row => row.key === key), host = entry && hostFor(entry.contribution.slot);
    if (!entry || !usable(host) || !contributionVisible(entry.contribution, host.context)) return;
    if (entry.contribution.target.type === 'action') runAction(entry, host);
    else { const id = entry.pluginId + ':' + entry.contribution.target.id; if (current?.entry.id === id) current.root.focus(); else history.push(target(history.location, id)); }
  }
  function scan() {
    if (disposed || !supported) return;
    reconcileActions();
    const visible = contributions.map(entry => ({ entry, host: hostFor(entry.contribution.slot) })).filter(({ entry, host }) => usable(host) && contributionVisible(entry.contribution, host.context));
    const wanted = new Set(visible.map(({ entry }) => entry.key));
    for (const [key, link] of links) if (!wanted.has(key) || !link.button.isConnected) { link.wrapper.remove(); links.delete(key); }
    const groups = new Map();
    for (const { entry, host } of visible) {
      let link = links.get(entry.key);
      if (link && link.wrapper.parentElement !== host.navigation) { link.wrapper.remove(); links.delete(entry.key); link = null; }
      if (!link) {
        const button = win.document.createElement('button'); button.type = 'button'; button.className = 'rv-workpage-link'; button.setAttribute('data-c89-plugin-ui', ''); button.setAttribute('data-rivetin-ui-contribution', entry.key);
        button.onclick = event => { event.preventDefault(); event.stopPropagation(); activate(entry.key); };
        const wrapper = host.listItem ? win.document.createElement('li') : button;
        if (wrapper !== button) { wrapper.className = 'rv-workpage-nav-item ant-menu-item'; wrapper.setAttribute('role', 'menuitem'); wrapper.setAttribute('data-c89-plugin-ui', ''); wrapper.append(button); }
        link = { button, wrapper, labelKey: null }; links.set(entry.key, link);
      }
      const label = entry.contribution.label[locale], labelKey = entry.contribution.icon + ':' + label;
      if (link.labelKey !== labelKey) {
        const text = win.document.createElement('span'); text.textContent = label; link.button.replaceChildren();
        if (icons[entry.contribution.icon]) { const icon = win.document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.className = 'rv-ui-icon'; icon.textContent = icons[entry.contribution.icon]; link.button.append(icon); }
        link.button.append(text); link.labelKey = labelKey;
      }
      link.button.disabled = entry.contribution.target.type === 'action' && inflight.has(actionKey(entry, host.context));
      if (!groups.has(host.navigation)) groups.set(host.navigation, { host, links: [] }); groups.get(host.navigation).links.push(link);
    }
    for (const { host, links: ordered } of groups.values()) { let before = host.before; for (const link of [...ordered].reverse()) { if (link.wrapper.nextSibling !== before) host.navigation.insertBefore(link.wrapper, before); before = link.wrapper; } }
    route();
    for (const { entry } of visible) { const button = links.get(entry.key)?.button; if (!button) continue; if (entry.contribution.target.type === 'page' && current?.entry.id === entry.pluginId + ':' + entry.contribution.target.id) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
  }
  const unlisten = supported ? history.listen(scan) : () => {};
  const unblock = supported ? history.block((next, action) => { if (current?.dirty) { showGuard(next, action); return false; } }) : () => {};
  const beforeUnload = event => { if (current?.dirty) { event.preventDefault(); event.returnValue = ''; } };
  win.addEventListener('beforeunload', beforeUnload);
  let scheduled = false;
  const observer = new win.MutationObserver(records => { if (scheduled || records.every(record => record.target.closest?.('[data-c89-plugin-ui]'))) return; scheduled = true; win.queueMicrotask(() => { scheduled = false; scan(); }); });
  observer.observe(win.document.body, { childList: true, subtree: true });
  return {
    sync(values, nextLocale) {
      if (disposed) return; locale = nextLocale === 'en-US' ? 'en-US' : 'zh-CN';
      const next = new Map(), nextPages = new Map(), rows = [];
      for (const entry of values) {
        if (!validId(entry.id) || next.has(entry.id)) continue;
        const state = entry.uiRegistration || readUiContributions(entry, entry.manifest); if (state.code) onStatus(state.code, entry.id); if (!state.ui) continue;
        next.set(entry.id, { ...entry, ui: state.ui });
        for (const page of state.ui.pages) { const id = entry.id + ':' + page.id; nextPages.set(id, { id, pluginId: entry.id, packageId: entry.packageId, manifest: entry.manifest, page, references: state.ui.contributions.filter(row => row.target.type === 'page' && row.target.id === page.id) }); }
        for (const contribution of state.ui.contributions) rows.push({ key: entry.id + ':' + contribution.id, pluginId: entry.id, packageId: entry.packageId, contribution });
      }
      plugins = next; pages = nextPages; contributions = rows.sort(orderContributions).slice(0, UI_LIMITS.globalContributions);
      if (rows.length > UI_LIMITS.globalContributions) onStatus('UI_CONTRIBUTION_LIMIT');
      if (!supported && rows.length) onStatus('UI_ROUTER_UNSUPPORTED');
      if (current && (!pages.has(current.entry.id) || pages.get(current.entry.id).packageId !== current.entry.packageId)) close();
      reconcileActions(); scan();
    },
    dispose() { if (disposed) return; disposed = true; observer.disconnect(); unlisten(); unblock(); win.removeEventListener('beforeunload', beforeUnload); close(); reconcileActions(); for (const link of links.values()) link.wrapper.remove(); links.clear(); plugins.clear(); pages.clear(); contributions = []; },
  };
}
