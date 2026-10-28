import defaultReact from 'react';
import defaultReactDOM from 'react-dom';
import { CSS } from './style.js';
import { createPreferenceStore } from './personal.js';
import { createClient, loadPlugin } from './client.js';
import { createManagement } from './management.js';
import { translator, towerLocale, watchTowerLocale } from './i18n.js';
import { installMenuEntry } from './menu-bridge.js';
import { createAbout } from './about.js';
import { createFloatingButton } from './floating.js';
import { createSshSettings } from './ssh-settings.js';
import { createMarketplace } from './marketplace.js';
import { installUpgradeNotice } from './upgrade-notice.js';
import { validId } from '../shared/identity.js';
import { createDataProviders } from './data-providers.js';
import { createSshConnectionsStore } from './ssh-connection-settings.js';
import { createComponentsStatus } from './components-status.js';

const extraCss = `
.pk-badge-suspended{color:#946000;background:#fff8e6;border-color:#f0d28d}
.c89-content .pk-upload{margin-left:auto;display:inline-flex;position:relative;align-items:center;min-height:34px}.c89-content .pk-upload input{position:absolute;width:1px;max-width:1px;height:1px;margin:0;padding:0;opacity:0;clip-path:inset(50%)}.pk-upload:focus-within{outline:2px solid #1385ee;outline-offset:3px}
.pk-toolbar,.pk-framework,.pk-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pk-toolbar{justify-content:space-between;margin:0 0 12px}.pk-framework{justify-content:space-between;padding:14px 0 22px;border-bottom:1px solid #e7edf5;margin-bottom:22px}.pk-plugin-card,.pk-package-card{border:1px solid #dfe8f2;border-radius:8px;padding:16px;margin-top:14px}.pk-actions{margin-top:14px}.pk-muted{color:#71849b;font-size:12px;overflow-wrap:anywhere}.pk-danger-text{color:#cf1322!important}.pk-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:16px}.pk-table th,.pk-table td{text-align:left;padding:10px 6px;border-bottom:1px solid #e8eef6;vertical-align:top;overflow-wrap:anywhere}.pk-table td:first-child{white-space:nowrap}.pk-upload{cursor:pointer;background:#0784f5;color:white;padding:6px 10px;border-radius:6px;font-size:12px}.pk-upload input{display:block;max-width:190px;font-size:11px;margin-top:4px}.pk-disabled{opacity:.5;cursor:default}.c89-content button:not(.c89-remove-rule){border:1px solid #d7e3f0;border-radius:6px;padding:6px 10px;background:white;cursor:pointer}.pk-nav-group{font-size:11px;color:#8491a3;margin:18px 12px 8px}.pk-warning{color:#9a4810;background:#fff7ed;padding:10px;border-radius:7px;margin:12px 0}.pk-plugin-error{color:#bd2834}.pk-confirm-description{overflow-wrap:anywhere}
.c89-plugin-root .c89-content button.pk-emergency{background:#e1192d;border-color:#e1192d;color:white;font-weight:700;padding:9px 16px}.c89-plugin-root .c89-content button.pk-emergency:hover{background:#bd1022;border-color:#bd1022}
`;
export function createFrameworkHub(options = {}) {
  const React = options.React || defaultReact, ReactDOM = options.ReactDOM || defaultReactDOM;
  const { useEffect, useRef, useState } = React, h = React.createElement, Management = createManagement(React), About = createAbout(React), FloatingButton = createFloatingButton(React), SshSettings = createSshSettings(React), Marketplace = createMarketplace(React), ComponentsStatus = createComponentsStatus(React);
  return function RivetinHub({ history, apolloClient, locale: suppliedLocale } = {}) {
    const [locale, setLocale] = useState(towerLocale(window, suppliedLocale));
    const t = translator(locale), localeRef = useRef(locale); localeRef.current = locale;
    const [personal] = useState(() => createPreferenceStore(window)), [prefs, setPrefs] = useState(personal.get);
    const [open, setOpen] = useState(false), [tab, setTab] = useState(options.initialTab || 'center');
    const [records, setRecords] = useState([]), [packages, setPackages] = useState([]), [runtime, setRuntime] = useState({ enabled: false });
    const upgradeNotice = useRef(null), currentState = useRef(null); currentState.current = { enabled: runtime.enabled, plugins: records };
    const [logs, setLogs] = useState({ items: [], next: null }), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [confirmation, setConfirmation] = useState(null), [unsaved, setUnsaved] = useState(false), [menuUnsupported, setMenuUnsupported] = useState(false);
    const [loaded, setLoaded] = useState({}), [, render] = useState(0);
    const [updates, setUpdates] = useState({}), [updateChecked, setUpdateChecked] = useState(false);
    const [updateSourceStatus, setUpdateSourceStatus] = useState({ checking: true, reachable: false }), [updateProbeEpoch, setUpdateProbeEpoch] = useState(0);
    const updateProbeRequest = useRef(null);
    const alive = useRef(true), sessions = useRef(new Map()), loading = useRef(false), generation = useRef(0);
    const dialog = useRef(null), confirmDialog = useRef(null), lastFocus = useRef(null), openRef = useRef(false);
    const [api] = useState(() => options.client || createClient(window));
    const [connectionStore] = useState(() => createSshConnectionsStore({ client: api, crypto: window.crypto }));
    const stores = () => [connectionStore, ...[...sessions.current.values()].map(session => session.store)];
    const dirty = () => stores().some(store => store.status().dirty);
    function finish() { setOpen(false); setUnsaved(false); lastFocus.current?.focus?.(); }
    function close() { if (busy || stores().some(store => store.status().saving)) return; if (dirty()) setUnsaved(true); else finish(); }
    async function show() { lastFocus.current = document.activeElement; setOpen(true); setError(''); await refresh(); for (const session of sessions.current.values()) session.store.load(); }
    function stopSession(session) { session.stop?.(); session.stop = null; }
    async function refreshLogs(append = false) {
      const current = await api(`/logs?limit=30${append && logs.next ? '&before=' + encodeURIComponent(logs.next) : ''}`);
      if (alive.current) setLogs(previous => ({ items: append ? [...previous.items, ...current.items] : current.items, next: current.next }));
    }
    async function refresh() {
      if (loading.current) return; loading.current = true; const currentGeneration = generation.current;
      try {
        const state = await api('/runtime');
        if (!alive.current) return;
        setRuntime({ ...state, connected: true });
        // Stop immediately after runtime read, before package/config parsing.
        if (!state.enabled) for (const session of sessions.current.values()) stopSession(session);
        const listing = await api('/plugins');
        if (!Array.isArray(listing.items) || listing.items.some(record => !validId(record.id)) || new Set(listing.items.map(record => record.id)).size !== listing.items.length) throw new Error('INVALID_PLUGIN_LIST');
        if (!alive.current || currentGeneration !== generation.current) return;
        setRecords(listing.items); setPackages(listing.packages);
        const active = new Set();
        for (const record of listing.items.filter(record => state.enabled && record.active)) {
          active.add(record.id); let session = sessions.current.get(record.id);
          if (session && session.version !== record.packageId) {
            if (session.store.status().dirty) { stopSession(session); continue; }
            stopSession(session); session.unsubscribe(); session.store.dispose(); sessions.current.delete(record.id); session = null;
          }
          if (!session) {
            try {
              window.RivetinSDK = { React };
              const factory = options.definitions?.[record.id] || await loadPlugin(window, record, api);
              if (!alive.current || generation.current !== currentGeneration) return;
              const providers = createDataProviders(api, record.id);
              const scopedOptions = { ...options, diskSmartInfo: { ...options.diskSmartInfo, provider: providers.diskSmart }, resourceActions: requestedId => { if (requestedId !== record.id) throw new Error('PLUGIN_ID_MISMATCH'); return providers.resourceActions; } };
              const definition = factory({ React, win: window, history, apolloClient, options: scopedOptions, getLocale: () => localeRef.current });
              if (definition.id !== record.id || !definition.store || typeof definition.Settings !== 'function' || typeof definition.activate !== 'function') throw new Error('PLUGIN_DEFINITION_INVALID');
              session = { ...definition, id: record.id, version: record.packageId };
              session.unsubscribe = session.store.subscribe(() => { if (alive.current) render(value => value + 1); });
              sessions.current.set(record.id, session); await session.store.load();
            } catch { if (alive.current) setError(`${record.id}: PLUGIN_LOAD_FAILED`); continue; }
          }
          if (!session.stop) session.stop = session.activate(message => setError(message));
        }
        for (const [id, session] of sessions.current) if (!active.has(id)) stopSession(session);
        setLoaded(Object.fromEntries(sessions.current));
        if (openRef.current) await refreshLogs();
      } catch {
        for (const session of sessions.current.values()) stopSession(session);
        if (alive.current) { setRuntime(previous => ({ ...previous, enabled: false, connected: false })); setError('请求失败，请刷新后重试。'); }
      } finally { loading.current = false; }
    }
    useEffect(() => { openRef.current = open; }, [open]);
    useEffect(() => {
      const unsubscribe = connectionStore.subscribe(() => { if (alive.current) render(value => value + 1); });
      return () => { unsubscribe(); connectionStore.dispose(); };
    }, []);
    useEffect(() => { if (open && tab === 'rivetin-ssh-channel') connectionStore.load(); }, [open, tab]);
    useEffect(() => {
      if (!open || tab !== 'center') return;
      let current = true;
      async function probe() {
        if (!current || !alive.current) return;
        setUpdateSourceStatus(previous => ({ ...previous, checking: true }));
        if (!updateProbeRequest.current) updateProbeRequest.current = Promise.resolve().then(() => api('/updates/status')).finally(() => { updateProbeRequest.current = null; });
        try {
          const status = await updateProbeRequest.current;
          if (current && alive.current) setUpdateSourceStatus({ checking: false, reachable: status?.reachable === true });
        } catch {
          if (current && alive.current) setUpdateSourceStatus({ checking: false, reachable: false });
        }
      }
      probe(); const timer = window.setInterval(probe, 30000);
      return () => { current = false; window.clearInterval(timer); };
    }, [open, tab, updateProbeEpoch]);
    useEffect(() => watchTowerLocale(window, setLocale, suppliedLocale), [suppliedLocale]);
    useEffect(() => {
      const notice = installUpgradeNotice({ win: window, getState: () => currentState.current, getLocale: () => localeRef.current, onOpen: show });
      upgradeNotice.current = notice;
      return () => { upgradeNotice.current = null; notice(); };
    }, []);
    useEffect(() => { upgradeNotice.current?.update?.(); }, [runtime, records, locale]);
    useEffect(() => {
      alive.current = true;
      const unsubscribe = personal.subscribe(setPrefs);
      const stopMenu = installMenuEntry({ win: window, onOpen: show, getLabel: () => translator(localeRef.current)('插件配置'), onStatus: state => setMenuUnsupported(state === 'unsupported') });
      refresh(); const timer = setInterval(refresh, 3000);
      window.addEventListener('focus', refresh);
      return () => {
        alive.current = false; generation.current++; clearInterval(timer); window.removeEventListener('focus', refresh); stopMenu(); unsubscribe(); personal.dispose();
        for (const session of sessions.current.values()) { stopSession(session); session.unsubscribe(); session.store.dispose(); }
        sessions.current.clear();
      };
    }, []);
    useEffect(() => {
      if (!open) return;
      const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
      const active = confirmation || unsaved ? confirmDialog.current : dialog.current; active?.querySelector('button')?.focus();
      function keys(event) {
        if (event.key === 'Escape') { event.preventDefault(); if (!busy && (confirmation || unsaved)) { setConfirmation(null); setUnsaved(false); } else close(); }
        if (event.key === 'Tab') {
          const nodes = [...active.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')], first = nodes[0], last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }
      document.addEventListener('keydown', keys);
      return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', keys); };
    }, [open, confirmation, unsaved, busy]);
    async function perform(action, item, packageId) {
      if (action !== 'framework.disable' && dirty()) { setError('请先保存或丢弃配置修改。'); return; }
      setConfirmation({ action, item, packageId });
    }
    async function checkUpdates() {
      setBusy(true); setError('');
      try { const result = await api('/updates', 'POST', { action: 'check' }); const found = Object.fromEntries(result.items.map(item => [item.id, item])); setUpdates(found); setUpdateChecked(true); return found; }
      catch (failure) { setUpdates({}); setUpdateChecked(false); setError(failure.message); return null; }
      finally { setBusy(false); }
    }
    async function onlineUpgrade(item) {
      setBusy(true); setError('');
      setConfirmation(previous => previous?.action === 'upgrade' ? { ...previous, error: '' } : previous);
      try {
        const result = await api('/updates', 'POST', { action: 'check' });
        setUpdates(Object.fromEntries(result.items.map(entry => [entry.id, entry]))); setUpdateChecked(true);
        const candidate = result.items.find(entry => entry.id === item.id && entry.available);
        if (!candidate) throw new Error('UPDATE_NOT_AVAILABLE');
        if (!candidate.downloadable) throw new Error('UPDATE_PACKAGE_UNPUBLISHED');
        const uploaded = await api('/updates', 'POST', { action: 'download', pluginId: item.id, version: candidate.version });
        setConfirmation({ action: 'update', item, packageId: uploaded.packageId });
      } catch (failure) {
        if (alive.current) setConfirmation(previous => previous?.action === 'upgrade' && previous.item.id === item.id ? { ...previous, error: failure.message } : previous);
      } finally { if (alive.current) setBusy(false); }
    }
    async function execute() {
      if (!confirmation) return; setBusy(true); setError('');
      try {
        const { action, item, packageId } = confirmation;
        if (action.startsWith('framework.')) { generation.current++; await api(action === 'framework.disable' ? '/disable' : '/enable', 'POST'); }
        else await api('/plugins', 'POST', { action, pluginId: item.id, ...(packageId ? { packageId } : {}) });
        if (confirmation.action === 'reset') {
          const store = sessions.current.get(confirmation.item.id)?.store; store?.discard(); await store?.load();
        }
        setConfirmation(null); await refresh();
      } catch (failure) { setError(failure.message); } finally { setBusy(false); }
    }
    async function upload(file, expectedId) {
      if (file.size > 16 * 1024 * 1024) { setError('PACKAGE_TOO_LARGE'); return; }
      setBusy(true); setError('');
      try {
        const bytes = await file.text();
        if (expectedId) {
          let value; try { value = JSON.parse(bytes); } catch { throw new Error('INVALID_PACKAGE'); }
          if (!validId(value?.manifest?.id) || value.manifest.id !== expectedId) throw new Error('PLUGIN_ID_MISMATCH');
        }
        const uploaded = await api('/packages', 'POST', bytes); await refresh();
        if (expectedId) setConfirmation({ action: 'update', item: { id: expectedId }, packageId: uploaded.packageId });
      }
      catch (failure) { setError(failure.message); } finally { setBusy(false); }
    }
    async function save(exit = false) {
      setBusy(true);
      try {
        for (const store of stores()) if (store.status().dirty && !await store.save()) return;
        if (exit) finish(); else render(value => value + 1);
      } finally { setBusy(false); }
    }
    const session = loaded[tab], modal = Boolean(confirmation || unsaved);
    const floatingState = runtime.connected === undefined ? 'checking' : runtime.connected === false ? 'unavailable' : runtime.enabled && records.some(record => record.active) ? 'enabled' : 'disabled';
    const floatingLabels = { checking: '正在检查插件状态', unavailable: '插件状态不可用', enabled: '插件已启用', disabled: '插件已停用' };
    const descriptions = { enable: '确认启用此插件？', disable: '确认禁用此插件？', 'framework.enable': '确认恢复已启用插件的运行？', reset: '重置将恢复默认配置，并备份当前配置。', uninstall: '卸载将停用并移除插件注册，保留配置与安装包。', update: '更新或回滚后插件保持禁用，请核对后重新启用。', rollback: '更新或回滚后插件保持禁用，请核对后重新启用。', install: '安装后默认禁用，请核对后启用。', 'framework.disable': '全部插件将停止运行，插件中心仍可用于恢复。' };
    return ReactDOM.createPortal(h('div', { className: 'c89-plugin-root', 'data-c89-plugin-ui': '', lang: locale },
      h('style', null, CSS + extraCss),
      (prefs.showFloatingButton || menuUnsupported) && h(FloatingButton, { win: window, state: floatingState, label: t(floatingLabels[floatingState]), settingsLabel: t('插件设置'),
        position: prefs.floatingPosition, onPosition: point => personal.update({ floatingPosition: point }), onOpen: show }),
      open && h('div', { className: 'c89-backdrop', onClick: event => { if (event.target === event.currentTarget) close(); } },
        h('section', { className: 'c89-panel', role: 'dialog', 'aria-modal': true, 'aria-hidden': modal || undefined, 'aria-labelledby': 'pk-title', ref: dialog },
          h('header', null, h('h2', { id: 'pk-title' }, t('插件中心')), h('button', { className: 'c89-close', onClick: close, 'aria-label': t('关闭插件配置') }, '×')),
          h('div', { className: 'c89-panel-body' },
            h('nav', { className: 'c89-nav' }, ...[['global', '全局偏好'], ['center', '插件管理'], ['market', '插件市场'], ['logs', '操作日志'], ['components', '组件状态']].map(([key, label]) => h('button', { role: 'tab', key, 'data-pk-tab': key, 'aria-selected': tab === key, onClick: () => setTab(key) }, t(label))),
              h('div', { className: 'pk-nav-group' }, t('插件配置')),
              ...records.filter(record => record.installed).map(record => h('button', { role: 'tab', key: record.id, 'aria-selected': tab === record.id, onClick: () => setTab(record.id) }, record.manifest?.name?.[locale] || record.id)),
              h('button', { className: 'pk-about-tab', role: 'tab', 'aria-selected': tab === 'about', onClick: () => setTab('about') }, t('关于'))),
            h('div', { className: 'c89-content' },
              tab === 'global' ? h(React.Fragment, null,
                h('div', { className: 'c89-preference-intro' }, h('p', null, t('个人偏好设置仅在当前浏览器生效。'))),
                h('div', { className: 'c89-setting' }, h('div', { className: 'c89-setting-row' }, h('label', { htmlFor: 'pk-floating' }, t('显示右下角插件按钮')),
                  h('input', { id: 'pk-floating', type: 'checkbox', checked: prefs.showFloatingButton, onChange: event => personal.update({ showFloatingButton: event.target.checked }) })), h('small', null, t('关闭后，仍可通过主菜单 → 插件配置打开本面板。')))) :
              tab === 'about' ? h(About, { locale }) : tab === 'components' ? h(ComponentsStatus, { client: api, locale, t, onRefresh: refresh }) : tab === 'market' ? h(Marketplace, { client: api, locale, onInstalled: () => refresh(), onError: message => setError(message) }) : tab === 'rivetin-ssh-channel' ? h(React.Fragment, null,
                session && h('fieldset', { className: 'c89-functional', disabled: !session.store.status().loaded || busy || !runtime.enabled || !records.some(record => record.id === tab && record.active) }, h(session.Settings, { preferences: session.store.getDraft(), store: session.store, t, locale })),
                h(SshSettings, { client: api, locale, connectionStore, preflightEnabled: runtime.enabled === true && records.some(record => record.id === 'rivetin-ssh-channel' && record.active), onError: message => setError(message) })) : tab === 'center' || tab === 'logs' ? h(Management, { tab, records, packages, runtime, logs, onAction: perform, onUpload: upload,
                onRefresh: () => { refresh(); setUpdateProbeEpoch(value => value + 1); }, onMore: () => refreshLogs(true).catch(() => setError('请求失败，请刷新后重试。')), onCheck: checkUpdates, onMarket: () => setTab('market'), updates, updateChecked, updateSourceStatus, busy, t, locale }) :
              session ? h('fieldset', { className: 'c89-functional', disabled: !session.store.status().loaded || busy || !runtime.enabled || !records.some(record => record.id === tab && record.active) },
                h(session.Settings, { preferences: session.store.getDraft(), store: session.store, t, locale })) : h('p', null, t('已禁用')),
              session?.store.status().error && h('p', { role: 'alert', className: 'pk-plugin-error' }, t(session.store.status().error))),
          ),
          error && h('div', { className: 'c89-config-error', role: 'alert' }, t(error)),
          h('footer', null,
            h('span', { className: 'c89-disclaimer' }, h('button', { className: 'c89-disclaimer-icon', 'aria-label': t('免责声明'), 'aria-describedby': 'pk-disclaimer' },
              h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 11v6M12 7v1' }))),
              h('span', { className: 'c89-disclaimer-popup', id: 'pk-disclaimer', role: 'tooltip' }, locale === 'en-US' ? 'An independent, free and open-source project; not an official SmartX product.' : '本插件为独立开发的免费开源项目，非 SmartX 官方产品；', h('br'),
                locale === 'en-US' ? 'Provided “as is”, without warranties of any kind. Users assume all risks of use.' : '按“现状”提供，不对任何功能做出任何形式的保证，使用风险由用户自行承担。')),
            h('div', { className: 'c89-footer-actions' }, h('button', { className: 'c89-done', disabled: busy || !dirty(), onClick: () => save() }, t(busy ? '保存中…' : '保存')), h('button', { className: 'c89-finish', disabled: busy, onClick: close }, t('完成')))))),
      open && modal && h('div', { className: 'c89-confirm-backdrop' }, h('section', { role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'pk-confirm-title', className: 'c89-confirm', ref: confirmDialog },
        h('h3', { id: 'pk-confirm-title' }, t(unsaved ? '存在未保存的更改' : confirmation.action === 'upgrade' ? '选择升级方式' : '确认操作')),
        h('p', { className: 'pk-confirm-description' }, confirmation?.action === 'upgrade' ? confirmation.item.id : t(unsaved ? '是否保存当前修改后退出？' : descriptions[confirmation.action] || confirmation.action, confirmation?.action), confirmation?.item?.id && confirmation.action !== 'upgrade' ? ` (${confirmation.item.id})` : ''),
        confirmation?.error && h('p', { className: 'pk-upgrade-error', role: 'alert' }, t(confirmation.error)),
        error && h('p', { role: 'alert' }, t(error)),
        unsaved && stores().map((store, index) => store.status().error && h('p', { key: index, role: 'alert' }, t(store.status().error))),
        h('div', { className: 'c89-confirm-actions' }, h('button', { className: 'c89-cancel-exit', disabled: busy, onClick: () => { setConfirmation(null); setUnsaved(false); } }, t('取消')),
          confirmation?.action === 'upgrade' ? h(React.Fragment, null,
            h('button', { className: 'c89-save-exit', disabled: busy, onClick: () => onlineUpgrade(confirmation.item) }, t(busy ? '处理中…' : '自动联网升级')),
            h('label', { className: `pk-manual-upgrade ${busy ? 'pk-disabled' : ''}` }, t('手动上传升级'), h('input', { type: 'file', accept: '.json,application/json', disabled: busy, 'aria-label': t('手动上传升级'), onChange: async event => { const file = event.target.files[0]; event.target.value = ''; if (file) await upload(file, confirmation.item.id); } }))) : unsaved ? h(React.Fragment, null,
            h('button', { className: 'c89-discard-exit', disabled: busy, onClick: () => { for (const store of stores()) store.discard(); finish(); } }, t('丢弃并退出')),
            h('button', { className: 'c89-save-exit', disabled: busy, onClick: () => save(true) }, t('保存并退出'))) :
            h('button', { className: confirmation.action.includes('disable') || confirmation.action === 'uninstall' ? 'c89-discard-exit' : 'c89-save-exit', disabled: busy, onClick: execute }, t(busy ? '处理中…' : '确认')))))), document.body);
  };
}
