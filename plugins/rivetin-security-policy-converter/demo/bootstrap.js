import React from 'react';
import ReactDOM from 'react-dom';
import factory from '../src/definition.js';
import { configuration } from '../src/configuration.js';
import metadata from '../package.json';
const h = React.createElement;
let stored = { revision: 0, updatedAt: null, settings: configuration.defaults() };
const backend = { load: async () => structuredClone(stored), save: async settings => {
  stored = { revision: stored.revision + 1, updatedAt: new Date().toISOString(), settings: configuration.validate(settings) }; return structuredClone(stored);
} };
const plugin = factory({ React, win: window, options: { configurationBackend: () => backend } });
let stop = plugin.activate();
function Demo() {
  const [locale, setLocale] = React.useState('zh-CN'), [enabled, setEnabled] = React.useState(true), [, render] = React.useState(0);
  React.useEffect(() => plugin.store.subscribe(() => render(value => value + 1)), []);
  const t = (zh, en) => locale === 'en-US' ? en : zh;
  return h('div', null, h('header', { className: 'demo-toolbar' }, h('strong', null, `Rivetin · ${metadata.version}`),
    h('span', null, t('本地演示，配置只存内存', 'Local demo; configuration is in memory')),
    h('label', null, t('模拟宿主语言 ', 'Mock host language '), h('select', { value: locale, onChange: event => { setLocale(event.target.value); document.documentElement.lang = event.target.value; } }, h('option', { value: 'zh-CN' }, '中文'), h('option', { value: 'en-US' }, 'English'))),
    h('button', { 'data-action': 'toggle', onClick: () => { if (enabled) { stop(); setEnabled(false); } else { stop = plugin.activate(); setEnabled(true); } } }, enabled ? t('模拟停用', 'Simulate disable') : t('模拟启用', 'Simulate enable'))),
    enabled ? h(React.Fragment, null,
      h('section', { className: 'demo-settings' }, h(plugin.Settings, { preferences: plugin.store.getDraft(), locale }),
        h('div', { className: 'demo-toolbar' }, h('button', { 'data-action': 'save', disabled: !plugin.store.status().dirty, onClick: () => plugin.store.save() }, t('模拟保存共享配置', 'Simulate saving shared settings')),
          h('button', { disabled: !plugin.store.status().dirty, onClick: () => plugin.store.discard() }, t('丢弃配置草稿', 'Discard settings draft')),
          h('span', { className: 'demo-status' }, plugin.store.status().dirty ? t('有未保存配置', 'Unsaved settings') : t('配置已同步（本地模拟）', 'Settings synchronized (local mock)'))))) :
      h('p', { role: 'status' }, t('插件已模拟停用；输入与审查稿已清除。', 'Plugin disabled in mock; inputs and review draft cleared.')));
}
await plugin.store.load();
ReactDOM.render(h(Demo), document.querySelector('#demo'));
window.addEventListener('pagehide', () => { stop(); ReactDOM.unmountComponentAtNode(document.querySelector('#demo')); plugin.store.dispose(); }, { once: true });
