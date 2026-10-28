import React from 'react';
import { PLUGIN_ID } from './identity.js';
import { createConfigurationStore, createHttpConfigurationBackend } from './config-store.js';
import { installIpmiEnhancer } from './dom-enhancer.js';
import { loadTowerInventory } from './inventory.js';
import { BmcSettings } from './bmc-settings.js';

const h = React.createElement;
export default function createIpmiPlugin({ win, history, apolloClient, options = {}, getLocale = () => 'zh-CN' }) {
  const store = createConfigurationStore(win, options.configurationBackend?.() || createHttpConfigurationBackend(win));
  let inventory = { loaded: false, loading: false, error: '', hosts: [], clusters: [] }, disposed = false, inventoryRequest = 0;
  async function refreshInventory() {
    if (inventory.loading) return;
    const request = ++inventoryRequest;
    inventory = { ...inventory, loading: true, error: '' };
    try {
      const result = await (options.inventoryProvider ? options.inventoryProvider() : loadTowerInventory(apolloClient));
      if (disposed || request !== inventoryRequest) return;
      inventory = { ...result, loaded: true, loading: false, error: '' }; store.setClusters(result.clusters);
      win.dispatchEvent(new win.Event('c89:inventory-updated'));
    } catch {
      if (!disposed && request === inventoryRequest) { inventory = { ...inventory, loaded: false, loading: false, error: '资产清单暂不可用，请检查读取权限后重试。' }; store.setClusters([]); }
    }
  }
  function Settings({ preferences, t, locale }) {
    function checkbox(key, title) {
      return h('div', { className: 'c89-setting' }, h('div', { className: 'c89-setting-row' },
        h('label', { htmlFor: `c89-${key}` }, t(title)), h('input', { id: `c89-${key}`, type: 'checkbox', checked: preferences[key], onChange: event => store.update({ [key]: event.target.checked }) })));
    }
    return h(React.Fragment, null,
      h('h3', null, t('IPMI 跳转'), h('span', { className: `c89-badge ${preferences.ipmiEnabled ? 'c89-badge-enabled' : 'c89-badge-disabled'}` }, t(preferences.ipmiEnabled ? '已启用' : '已禁用'))),
      h('p', null, t('点击主机概览中的 IPMI 地址，打开对应 BMC。')),
      checkbox('ipmiEnabled', '启用 IPMI 地址跳转'), checkbox('openInNewTab', '在新标签页打开'),
      h('div', { className: 'c89-setting' }, h('div', { className: 'c89-setting-row' }, h('label', { htmlFor: 'c89-login-mode' }, t('登录方式')),
        h('select', { id: 'c89-login-mode', value: preferences.loginMode, onChange: event => store.update({ loginMode: event.target.value }) },
          h('option', { value: 'direct' }, t('打开 BMC 登录页')),
          h('option', { value: 'megarac', disabled: !options.requestLaunch }, t(options.demo ? '厂商自动登录 · 模拟' : '厂商自动登录 · 待接入'))))),
      h(BmcSettings, { preferences, store, inventory, onReload: refreshInventory, t, locale }));
  }
  return {
    id: PLUGIN_ID, store, Settings,
    activate(onError) {
      disposed = false; inventory = { ...inventory, loaded: false, loading: false }; refreshInventory();
      const stop = installIpmiEnhancer({ win, store, history, ...options, getLocale,
        getHostContext: id => {
          const host = inventory.hosts.find(value => value.id === id);
          return { clusterId: inventory.loaded ? host?.cluster?.id : undefined, contextKnown: inventory.loaded && Boolean(host) };
        }, onError });
      const poll = win.setInterval(() => { if (!store.status().dirty && win.document.visibilityState === 'visible') store.load(); }, 15000);
      return () => { disposed = true; inventoryRequest++; inventory = { ...inventory, loaded: false, loading: false }; stop(); win.clearInterval(poll); };
    },
  };
}
