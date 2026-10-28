import React from 'react';
import ReactDOM from 'react-dom';
import createPlugin from '../src/definition.js';
import { defaults } from '../src/configuration.js';
import { disks, createMockProvider } from './fixtures.js';
import { createMockBatchProvider } from './global-fixture.js';
let locale = 'zh-CN', scope = 'clusters', selected = disks[0], scenario = 'ok', active = true;
let stored = { revision: 0, updatedAt: null, settings: defaults() };
const copy = value => JSON.parse(JSON.stringify(value));
const backend = { load: async () => copy(stored), save: async settings => { stored = { revision: stored.revision + 1, updatedAt: new Date().toISOString(), settings: copy(settings) }; return copy(stored); } };
const plugin = createPlugin({ React, win: window, getLocale: () => locale, options: { configurationBackend: () => backend, diskSmartInfo: { provider: { ...createMockProvider({ state: () => scenario }), ...createMockBatchProvider({ state: () => scenario }) } } } });
const $ = id => document.getElementById(id), t = (zh, en) => locale === 'en-US' ? en : zh;
function node(tag, value, cls) { const el = document.createElement(tag); if (value !== undefined) el.textContent = value; if (cls) el.className = cls; return el; }
function route() {
  const query = new URLSearchParams({ view: JSON.stringify('disks') });
  if (selected) query.set('sidebar', JSON.stringify({ type: 'disk', id: selected.diskId, view: 'detail' }));
  window.location.hash = `/${scope}/${scope === 'hosts' ? 'host-demo' : 'cluster-demo'}?${query}`;
}
function draw() {
  $('scope-title').textContent = scope === 'hosts' ? 'Example host' : 'Example cluster';
  $('disk-title').textContent = t('物理盘', 'Physical disks');
  $('disk-list').replaceChildren();
  for (const disk of disks) {
    const row = node('tr', undefined, disk === selected ? 'selected' : ''); row.dataset.rowKey = disk.diskId;
    const cell = node('td'), button = node('button', disk.path); cell.setAttribute('unique', 'path');
    button.onclick = () => { selected = disk; route(); draw(); }; cell.append(button); row.append(cell, node('td', disk.model), node('td', 'Example host')); $('disk-list').append(row);
  }
  $('drawer').replaceChildren(); if (!selected) return;
  const root = node('aside', undefined, 'drawer-content-inner'), title = node('div', undefined, 'title-wrapper');
  title.append(node('h2', selected.path, 'header-title'));
  const close = node('button', '×'); close.setAttribute('aria-label', t('关闭详情', 'Close details')); close.onclick = () => { selected = null; route(); draw(); }; title.append(close);
  const tabs = node('div', undefined, 'detail-tabs'); tabs.setAttribute('role', 'tablist');
  const content = node('div', undefined, 'detail-tab-content');
  for (const [zh, en] of [['详情', 'Details'], ['监控', 'Monitor'], ['标签', 'Labels']]) {
    const tab = node('button', t(zh, en), 'tab-item'); tab.setAttribute('role', 'tab'); tab.onclick = () => { content.querySelector('h3').textContent = t(zh, en); }; tabs.append(tab);
  }
  const card = node('div', undefined, 'basic-card'); card.append(node('h3', t('基本信息', 'Basic information')));
  const list = node('dl'); for (const [key, value] of [[t('型号', 'Model'), selected.model], [t('所属主机', 'Host'), 'Example host'], [t('设备路径', 'Device path'), selected.path], [t('身份', 'Identity'), selected.diskId]]) list.append(node('dt', key), node('dd', value)); card.append(list); content.append(card);
  const frame = node('div', undefined, 'frame'), header = node('div', undefined, 'detail-sidebar-header');
  frame.append(title, node('div', t('只读模拟详情 · 原生操作未接入', 'Read-only mock details · Native actions inactive'), 'toolbar'));
  header.append(frame, tabs); root.append(header, node('div', undefined, 'tab-border-bottom'), content);
  content.className = 'tab-content'; $('drawer').append(root);
}
function settings() {
  ReactDOM.render(React.createElement(plugin.Settings, { preferences: plugin.store.getDraft(), locale }), $('settings'));
  $('saved-status').textContent = plugin.store.status().dirty ? t('未保存', 'Unsaved') : t('已保存', 'Saved');
}
$('language').onchange = event => { locale = event.target.value; document.documentElement.lang = locale; draw(); settings(); window.dispatchEvent(new Event('languagechange')); };
$('cluster-view').onclick = () => { scope = 'clusters'; route(); draw(); };
$('host-view').onclick = () => { scope = 'hosts'; route(); draw(); };
$('scenario').onchange = event => { scenario = event.target.value; draw(); };
$('save').onclick = () => plugin.store.save(); $('discard').onclick = () => plugin.store.discard();
let stop;
$('lifecycle').onclick = () => { active = !active; if (active) stop = plugin.activate(); else { stop?.(); stop = null; } $('lifecycle').textContent = active ? '禁用插件 / Disable' : '启用插件 / Enable'; };
plugin.store.subscribe(settings);
await plugin.store.load(); route(); draw(); settings(); stop = plugin.activate();
window.addEventListener('pagehide', () => { stop?.(); plugin.store.dispose(); ReactDOM.unmountComponentAtNode($('settings')); });
