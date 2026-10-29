import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createFrameworkHub } from '../src/hub.js';
import { createConfigurationStore } from '../src/config-store.js';
import { CSS } from '../src/style.js';
import { translator } from '../src/i18n.js';
import notices from '../src/notices.js';
import { RIVETIN_MARK_SVG } from '../src/brand.js';
const { act } = testUtils;

test('Rivetin uses its own SDK and factory identity without creating legacy globals', async () => {
  const dom = new JSDOM('<html lang="en-US"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  let active = 0; const id = 'rivetin-example';
  const definition = { id, defaults: value => ({ enabled: value?.enabled !== false }), validate: value => value, equal: (a, b) => a.enabled === b.enabled, seed: value => value };
  const factory = () => {
    assert.equal(window.RivetinSDK.React, React);
    return { id, store: createConfigurationStore(window, { load: async () => ({ revision: 0, updatedAt: null, settings: { enabled: true } }) }, definition), Settings: () => null, activate: () => { active++; return () => {}; } };
  };
  const item = { id, installed: true, enabled: true, active: true, version: '0.1.0', packageId: 'EXAMPLE_PACKAGE', manifest: { name: { 'en-US': 'Example plugin', 'zh-CN': '示例插件' }, description: { 'en-US': 'Example', 'zh-CN': '示例' }, permissions: [] } };
  const client = async route => route === '/runtime' ? { enabled: true, version: '0.1.0' } : route === '/plugins' ? { items: [item], packages: [] } : route === '/updates/status' ? { reachable: false } : { items: [], next: null };
  const Hub = createFrameworkHub({ client, definitions: { [id]: factory } }), root = document.getElementById('root');
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); });
    await act(async () => { document.querySelector('.c89-plugin-fab').click(); await new Promise(setImmediate); });
    assert.equal(active, 1); assert.equal(document.querySelectorAll('.pk-plugin-card').length, 1);
    assert.equal(document.querySelector('.pk-plugin-card .pk-muted').textContent, id);
    assert.equal(document.querySelector('.pk-framework').previousElementSibling.textContent.includes('Rivetin'), true);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; }
});

test('framework UI follows host locale, separates plugin drafts, confirms lifecycle actions and unmounts on emergency disable', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const id = 'rivetin-example'; let enabled = true, active = 0, stopped = 0, saves = 0;
  let saved = { revision: 0, updatedAt: null, settings: { enabled: true } };
  const definition = { id, defaults: value => ({ enabled: value?.enabled !== false }), validate: value => value, equal: (a, b) => a.enabled === b.enabled, seed: value => value };
  const factory = () => ({ id, store: createConfigurationStore(window, { load: async () => structuredClone(saved), save: async settings => { saves++; saved = { revision: saves, updatedAt: 'EXAMPLE_TIME', settings }; return structuredClone(saved); } }, definition),
    activate: () => { active++; return () => { stopped++; }; },
    Settings: ({ store, preferences }) => React.createElement('input', { 'aria-label': 'EXAMPLE_SETTING', type: 'checkbox', checked: preferences.enabled, onChange: event => store.update({ enabled: event.target.checked }) }) });
  const client = async (route, method, body) => {
    if (route === '/updates/status') return { reachable: true };
    if (route === '/runtime') return { enabled, version: '0.1.0' };
    if (route === '/plugins') return { packages: [], items: [{ id, installed: true, enabled: true, active: enabled, packageId: 'EXAMPLE_PACKAGE', manifest: { name: { 'zh-CN': '测试插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '测试', 'en-US': 'Example' }, permissions: [] } }] };
    if (route === '/disable') { enabled = false; return { enabled }; }
    if (route === '/enable') { enabled = true; return { enabled }; }
    return { items: [], next: null };
  };
  const Hub = createFrameworkHub({ client, definitions: { [id]: factory } }), root = document.getElementById('root');
  const click = async selector => act(async () => { const element = document.querySelector(selector); assert.ok(element, selector); element.click(); await new Promise(setImmediate); });
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); });
    assert.equal(active, 1); await click('.c89-plugin-fab');
    assert.equal(document.querySelector('#pk-title').textContent, 'Rivetin 插件中心');
    const emergencyStyle = window.getComputedStyle(document.querySelector('.pk-emergency'));
    assert.equal(emergencyStyle.backgroundColor, 'rgb(225, 25, 45)');
    assert.equal(emergencyStyle.color, 'rgb(255, 255, 255)'); assert.equal(emergencyStyle.fontWeight, '700');
    assert.equal(document.querySelector('.pk-emergency svg').getAttribute('aria-hidden'), 'true');
    assert.equal(document.querySelector('.pk-emergency').textContent, '紧急禁用全部插件');
    await act(async () => { document.documentElement.lang = 'en-US'; await new Promise(setImmediate); });
    assert.equal(document.querySelector('#pk-title').textContent, 'Rivetin Plugin Center');
    assert.match(document.querySelector('.c89-plugin-fab').textContent, /Plugins enabled/);
    await click('[data-pk-plugin="rivetin-example"]'); await click('[aria-label="EXAMPLE_SETTING"]');
    await click('.c89-finish'); assert.equal(document.querySelector('[role="alertdialog"] h3').textContent, 'Unsaved changes');
    await click('.c89-cancel-exit'); assert.ok(document.querySelector('[role="dialog"]'));
    await click('.c89-done'); assert.equal(saves, 1);
    await click('[data-pk-tab="center"]');
    await click('.pk-framework button'); assert.equal(enabled, true); await click('.c89-confirm-actions .c89-discard-exit');
    assert.equal(enabled, false); assert.equal(stopped, 1); assert.ok(document.querySelector('.c89-content').textContent.includes('Framework disabled'));
    assert.match(document.querySelector('.c89-plugin-fab').textContent, /Plugins disabled/);
    await click('.pk-framework button'); await click('.c89-confirm-actions .c89-save-exit'); assert.equal(active, 2);
    await click('[data-pk-tab="logs"]'); assert.ok(document.querySelector('.c89-content').textContent.includes('No activity yet'));
    await click('.pk-about-tab'); assert.match(document.querySelector('.pk-about').textContent, /Facebook/); assert.match(document.querySelector('.pk-about').textContent, /MIT License/);
    const website = document.querySelector('.pk-about-links .pk-website-link');
    assert.equal(website.textContent, 'Rivetin Website'); assert.equal(website.href, 'https://rivetin.dev/');
    assert.equal(website.target, '_blank'); assert.equal(website.rel, 'noopener noreferrer'); assert.equal(website.tabIndex, 0);
    assert.equal(website.querySelector('.pk-website-heart').getAttribute('aria-hidden'), 'true');
    assert.equal(document.querySelector('.pk-github-link').textContent, 'GitHub');
    const links = [...document.querySelectorAll('.pk-notice-link')]; assert.equal(links.length, notices.components.length);
    for (const [index, link] of links.entries()) {
      assert.equal(link.href, notices.components[index].projectUrl); assert.ok(link.href.startsWith('https://'));
      assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.tabIndex, 0);
      assert.match(link.getAttribute('aria-label'), /Source repository|Website/);
      assert.equal(link.closest('details').querySelector('pre').textContent, notices.components[index].text);
      link.addEventListener('click', event => event.preventDefault()); await act(async () => link.click());
      assert.equal(link.closest('details').open, false);
    }
    await click('.c89-finish'); await click('.c89-plugin-fab');
    assert.equal(document.querySelector('[data-pk-tab="center"]').getAttribute('aria-selected'), 'true');
    await click('[data-pk-plugin="rivetin-example"]'); await click('[aria-label="EXAMPLE_SETTING"]');
    await click('.c89-finish'); await click('.c89-discard-exit'); await click('.c89-plugin-fab');
    assert.equal(document.querySelector('[data-pk-tab="center"]').getAttribute('aria-selected'), 'true'); assert.equal(saves, 1);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});

test('navigation puts SSH first, preferences directly before about and locally bundles the existing mark', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const ids = ['rivetin-context-menu','rivetin-disk-smart-info','rivetin-ssh-channel','rivetin-ipmi-redirection'];
  let frameworkEnabled = false;
  const client = async route => route === '/runtime' ? { enabled: frameworkEnabled } : route === '/plugins' ? { packages: [], items: ids.map(id => ({ id, installed: true, enabled: false, active: false })) } : { items: [], next: null };
  const Hub = createFrameworkHub({ client }), root = document.getElementById('root');
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); document.querySelector('.c89-plugin-fab').click(); await new Promise(setImmediate); });
    assert.deepEqual([...document.querySelectorAll('[data-pk-plugin]')].map(node => node.dataset.pkPlugin), [ids[2],ids[0],ids[1],ids[3]]);
    const about = document.querySelector('.pk-about-tab'); assert.equal(about.previousElementSibling.dataset.pkTab, 'global');
    assert.equal(about.previousElementSibling.textContent, '个人设置');
    assert.match(document.querySelector('.pk-toolbar .c89-badge').textContent, /框架已停用/);
    frameworkEnabled = true;
    await act(async () => { [...document.querySelectorAll('button')].find(node => node.textContent === '刷新').click(); await new Promise(setImmediate); });
    assert.equal(document.querySelector('.pk-toolbar .c89-badge').textContent, '框架运行中');
    assert.equal(document.querySelector('.c89-nav button').dataset.pkTab, 'center');
    const logo = document.querySelector('#pk-title img'); assert.equal(decodeURIComponent(logo.src.split(',')[1]), RIVETIN_MARK_SVG);
    assert.equal(logo.alt, ''); assert.equal(logo.getAttribute('aria-hidden'), 'true'); assert.equal(logo.width, 32);
    await act(async () => about.click()); assert.equal(document.querySelector('.pk-website-link').textContent, 'Rivetin Website');
    assert.match(document.querySelector('.pk-notice-link').getAttribute('aria-label'), /源码仓库|官网/);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; }
});

test('update UI checks versions, offers online/manual methods and requires confirmation before applying a staged package', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const id = 'rivetin-example', calls = []; let version = '0.1.0', available = true;
  const client = async (route, method, body) => {
    calls.push({ route, method, body });
    if (route === '/updates/status') return { reachable: true };
    if (route === '/runtime') return { enabled: true, version: '0.1.0' };
    if (route === '/plugins' && method !== 'POST') return { packages: [], items: [{ id, installed: true, enabled: false, active: false, version,
      packageId: 'EXAMPLE_CURRENT_PACKAGE', manifest: { name: { 'zh-CN': '测试插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '测试', 'en-US': 'Example' }, permissions: [] } }] };
    if (route === '/updates') return body.action === 'check' ? { items: [{ id, version: '0.1.1', available, downloadable: true }] } : { packageId: 'EXAMPLE_NEW_PACKAGE' };
    if (route === '/packages') return { packageId: 'EXAMPLE_MANUAL_PACKAGE' };
    if (route === '/plugins' && method === 'POST') { version = '0.1.1'; return {}; }
    return { items: [], next: null };
  };
  const Hub = createFrameworkHub({ client }), root = document.getElementById('root');
  const settle = () => new Promise(setImmediate);
  const click = async selector => act(async () => { const element = document.querySelector(selector); assert.ok(element, selector); element.click(); await settle(); });
  async function selectFile(data) {
    await act(async () => {
      const element = document.querySelector('.pk-manual-upgrade input');
      Object.defineProperty(element, 'files', { configurable: true, value: [{ size: data.length, text: async () => data }] });
      element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle();
    });
  }
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await settle(); });
    await click('.c89-plugin-fab');
    assert.equal(document.querySelector('.pk-plugin-card .pk-muted').textContent, id);
    assert.match(document.querySelector('.pk-plugin-card .pk-toolbar').textContent, /测试插件 · 版本 0.1.0/);
    assert.equal(document.querySelector('.pk-new-version'), null);
    await click('.pk-check-updates'); assert.match(document.querySelector('.pk-new-version').textContent, /0.1.1/);
    await click('.pk-upgrade'); assert.match(document.querySelector('[role="alertdialog"]').textContent, /自动联网升级/);
    assert.ok(document.querySelector('.pk-manual-upgrade input'));
    await click('.c89-confirm-actions .c89-save-exit');
    assert.ok(calls.some(call => call.route === '/updates' && call.body.action === 'download'));
    assert.equal(calls.some(call => call.route === '/plugins' && call.method === 'POST'), false);
    assert.match(document.querySelector('[role="alertdialog"]').textContent, /更新或回滚后插件保持禁用/);
    await click('.c89-confirm-actions .c89-cancel-exit');
    await click('.pk-upgrade');
    await selectFile(JSON.stringify({ manifest: { id: 'rivetin-other' } }));
    assert.equal(calls.some(call => call.route === '/packages'), false);
    assert.ok(document.querySelector('[role="alertdialog"] [role="alert"]'));
    await selectFile(JSON.stringify({ manifest: { id } }));
    assert.ok(calls.some(call => call.route === '/packages'));
    assert.equal(calls.some(call => call.route === '/plugins' && call.method === 'POST'), false);
    await click('.c89-confirm-actions .c89-save-exit');
    assert.ok(calls.some(call => call.route === '/plugins' && call.method === 'POST' && call.body.action === 'update' && call.body.packageId === 'EXAMPLE_MANUAL_PACKAGE'));
    assert.match(document.querySelector('.pk-version').textContent, /0.1.1/);
    available = false; await click('.pk-check-updates'); assert.equal(document.querySelector('.pk-new-version'), null);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});

async function updateUiFixture(t, handler) {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const id = 'rivetin-example', calls = [];
  const client = async (route, method, body) => {
    calls.push({ route, method, body });
    const value = await handler(route, method, body);
    if (value !== undefined) return value;
    if (route === '/runtime') return { enabled: true, version: '0.1.0' };
    if (route === '/plugins') return { packages: [], items: [{ id, installed: true, enabled: false, active: false, version: '0.1.0',
      packageId: 'EXAMPLE_PACKAGE', manifest: { name: { 'zh-CN': '测试插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '测试', 'en-US': 'Example' }, permissions: [] } }] };
    if (route === '/updates/status') return { reachable: true };
    return { items: [], next: null };
  };
  const Hub = createFrameworkHub({ client }), root = document.getElementById('root');
  const settle = () => new Promise(setImmediate);
  let mounted = true;
  async function unmount() { if (mounted) { mounted = false; await act(async () => ReactDOM.unmountComponentAtNode(root)); } }
  t.after(async () => { await unmount(); dom.window.close(); delete globalThis.window; delete globalThis.document; });
  const click = async selector => act(async () => { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); await settle(); });
  await act(async () => { ReactDOM.render(React.createElement(Hub), root); await settle(); });
  return { win: dom.window, calls, click, settle, unmount };
}

test('online upgrade failure stays in its method dialog and cancel clears it without a duplicate center alert', async t => {
  const f = await updateUiFixture(t, async route => { if (route === '/updates') throw new Error('UPDATE_SOURCE_ACCESS_REQUIRED'); });
  await f.click('.c89-plugin-fab'); await f.click('.pk-upgrade');
  await f.click('.c89-confirm-actions .c89-save-exit');
  const modal = document.querySelector('[role="alertdialog"]');
  assert.match(modal.querySelector('.pk-upgrade-error').textContent, /官网更新源拒绝访问/);
  assert.equal(document.querySelector('.c89-config-error'), null);
  assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
  assert.ok(modal.querySelector('.pk-manual-upgrade input'));
  await f.click('.c89-cancel-exit');
  assert.equal(document.querySelector('[role="alertdialog"]'), null); assert.equal(document.querySelector('[role="alert"]'), null);
  await f.click('.pk-upgrade'); assert.equal(document.querySelector('[role="alertdialog"] [role="alert"]'), null);
});

test('update-source availability gates checks, localizes its hover hint and recovers by retry or refresh', async t => {
  let pending, probes = 0, reachable = false;
  const f = await updateUiFixture(t, async route => {
    if (route === '/updates/status') {
      probes++;
      if (probes === 1) return new Promise(resolve => { pending = resolve; });
      return { reachable };
    }
  });
  const intervals = [], cleared = new Set(), nativeSet = f.win.setInterval.bind(f.win), nativeClear = f.win.clearInterval.bind(f.win);
  f.win.setInterval = (callback, delay) => { const id = nativeSet(callback, delay); intervals.push({ id, callback, delay }); return id; };
  f.win.clearInterval = id => { cleared.add(id); nativeClear(id); };
  assert.equal(probes, 0, 'Opening a Tower page does not contact GitHub.');
  await f.click('.c89-plugin-fab');
  assert.equal(document.querySelector('.pk-check-updates').disabled, true);
  assert.equal(document.querySelector('.pk-check-updates-hint').title, '正在检测更新源…');
  await f.click('.pk-check-updates'); assert.equal(f.calls.filter(call => call.route === '/updates').length, 0);
  await f.click('.pk-toolbar > button:last-child'); assert.equal(probes, 1, 'Refresh joins an existing probe.');
  await act(async () => { pending({ reachable: false }); await f.settle(); });
  assert.equal(document.querySelector('.pk-check-updates').disabled, true);
  assert.equal(document.querySelector('.pk-check-updates-hint').title, '无法连接到更新源');
  assert.equal(document.querySelector('.pk-check-updates').style.pointerEvents, 'none');
  await act(async () => { document.documentElement.lang = 'en-US'; await f.settle(); });
  assert.equal(document.querySelector('.pk-check-updates-hint').title, 'Cannot connect to the update source');
  reachable = true;
  const retry = intervals.filter(value => value.delay === 30000).at(-1);
  assert.ok(retry);
  await act(async () => { retry.callback(); await f.settle(); });
  assert.equal(document.querySelector('.pk-check-updates').disabled, false); assert.equal(probes, 2);
  assert.equal(document.querySelector('.pk-check-updates-hint').hasAttribute('title'), false);
  reachable = false; await f.click('.pk-toolbar > button:last-child');
  assert.equal(document.querySelector('.pk-check-updates').disabled, true); assert.equal(probes, 3);
  await f.unmount(); assert.ok(intervals.filter(value => value.delay === 30000).every(value => cleared.has(value.id)));
  await retry.callback(); assert.equal(probes, 3, 'A stale interval cannot issue requests after unmount.');
});

test('closing and reopening during a pending availability probe shares it without accepting stale effect writes', async t => {
  let release, probes = 0;
  const f = await updateUiFixture(t, async route => {
    if (route === '/updates/status') { probes++; return new Promise(resolve => { release = resolve; }); }
  });
  await f.click('.c89-plugin-fab'); await f.click('.c89-close'); await f.click('.c89-plugin-fab');
  assert.equal(probes, 1);
  await act(async () => { release({ reachable: true }); await f.settle(); });
  assert.equal(document.querySelector('.pk-check-updates').disabled, false);
});

test('package cards hide installed and older versions while newer packages and rollback remain available', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const id = 'rivetin-example', actions = [];
  const manifest = version => ({ id, version, name: { 'zh-CN': '测试插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '测试', 'en-US': 'Example' }, permissions: [] });
  const packages = [
    { packageId: 'EXAMPLE_OLD_PACKAGE', manifest: manifest('0.1.0') },
    { packageId: 'EXAMPLE_CURRENT_PACKAGE', manifest: manifest('0.1.1') },
    { packageId: 'EXAMPLE_REPACKED_PACKAGE', manifest: manifest('0.1.1') },
    { packageId: 'EXAMPLE_NEXT_PACKAGE', manifest: manifest('0.1.2') },
    { packageId: 'EXAMPLE_LATER_PACKAGE', manifest: manifest('0.1.10') },
    { packageId: 'EXAMPLE_OTHER_PACKAGE', manifest: { ...manifest('0.1.0'), id: 'rivetin-other', name: { 'zh-CN': '其他插件', 'en-US': 'Other plugin' } } },
  ];
  const before = structuredClone(packages);
  let version = '0.1.1';
  const client = async (route, method, body) => {
    if (route === '/updates/status') return { reachable: true };
    if (route === '/runtime') return { enabled: false, version: '0.1.0' };
    if (route === '/plugins' && method === 'POST') { actions.push(body); return {}; }
    if (route === '/plugins') return { packages, items: [{ id, installed: true, enabled: false, active: false, version,
      packageId: 'EXAMPLE_CURRENT_PACKAGE', previous: { packageId: 'EXAMPLE_OLD_PACKAGE', version: '0.1.0' }, manifest: manifest(version) }] };
    return { items: [], next: null };
  };
  const Hub = createFrameworkHub({ client }), root = document.getElementById('root');
  const click = async selector => act(async () => { const element = document.querySelector(selector); assert.ok(element, selector); element.click(); await new Promise(setImmediate); });
  const cards = () => [...document.querySelectorAll('.pk-package-card')];
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); });
    await click('.c89-plugin-fab');
    assert.equal(document.querySelectorAll('.pk-plugin-card').length, 1);
    assert.equal(cards().length, 3);
    assert.match(cards()[0].textContent, /0.1.2/); assert.match(cards()[1].textContent, /0.1.10/);
    assert.match(cards()[2].textContent, /其他插件/);
    assert.deepEqual(cards().map(card => card.querySelector('button').textContent), ['更新', '更新', '安装']);
    await click('.pk-plugin-card .pk-actions button:nth-child(4)'); await click('.c89-confirm-actions .c89-save-exit');
    assert.deepEqual(actions, [{ action: 'rollback', pluginId: id }]);
    assert.deepEqual(packages, before, 'Filtering must retain archived packages for rollback.');
    version = '0.1.9'; await click('.pk-toolbar > button:last-child');
    assert.equal(cards().length, 2); assert.match(cards()[0].textContent, /0.1.10/);
    version = '0.1.10'; await click('.pk-toolbar > button:last-child');
    assert.equal(cards().length, 1); assert.match(cards()[0].textContent, /其他插件/);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});

test('log rows keep metadata single-line with local scrolling and collapse complete diagnostic details', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const event = { id: 'EXAMPLE_RECORD', time: '2026-01-01T00:00:00Z', actor: { name: 'EXAMPLE_ADMIN_WITH_A_LONG_DISPLAY_NAME' }, pluginId: 'rivetin-example-plugin-with-a-long-identifier', action: 'configuration.save', result: 'failed', code: 'INVALID_SETTINGS', message: 'EXAMPLE_SECRET', towerDelivery: { state: 'permission-denied', code: 'TOWER_AUDIT_SYSTEM_USER_REQUIRED' } };
  const client = async route => route === '/updates/status' ? { reachable: true } : route === '/runtime' ? { enabled: false, version: '0.1.0', audit: 'permission-denied' } : route === '/plugins' ? { items: [], packages: [] } : { items: [event], next: null };
  const Hub = createFrameworkHub({ client }), root = document.getElementById('root');
  const click = async selector => act(async () => { document.querySelector(selector).click(); await new Promise(setImmediate); });
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); });
    await click('.c89-plugin-fab');
    assert.equal(document.querySelector('.c89-panel').classList.contains('pk-panel-logs'), false);
    await click('[data-pk-tab="logs"]');
    assert.equal(document.querySelector('.c89-panel').classList.contains('pk-panel-logs'), false);
    assert.match(document.querySelector('.pk-table thead').textContent, /内容/);
    assert.match(document.querySelector('.pk-log-detail').textContent, /INVALID_SETTINGS/);
    assert.match(document.querySelector('.pk-log-detail').textContent, /only allow by system user/);
    assert.equal(document.querySelector('.c89-content > .pk-muted'), null);
    const details = document.querySelector('.pk-log-detail details'), summary = document.querySelector('.pk-log-summary');
    assert.equal(details.open, false);
    assert.match(summary.textContent, /配置内容不符合插件的配置规则 · 原生日志副本失败/);
    assert.doesNotMatch(summary.textContent, /only allow by system user|TOWER_AUDIT_SYSTEM_USER_REQUIRED|INVALID_SETTINGS/);
    assert.match(details.textContent, /EXAMPLE_RECORD/);
    assert.match(details.textContent, /记录编号/); assert.match(details.textContent, /错误码/);
    assert.doesNotMatch(document.querySelector('.pk-log-detail').textContent, /EXAMPLE_SECRET/);
    const cells = [...document.querySelectorAll('.pk-log-table tbody tr > td')];
    assert.equal(cells.length, 6);
    for (const cell of cells.slice(0, 5)) {
      assert.equal(cell.title, cell.textContent);
      const style = window.getComputedStyle(cell);
      assert.equal(style.whiteSpace, 'nowrap'); assert.equal(style.textOverflow, 'ellipsis'); assert.equal(style.overflow, 'hidden');
    }
    assert.equal(cells[1].title, event.actor.name); assert.equal(cells[3].title, event.pluginId);
    assert.equal(window.getComputedStyle(document.querySelector('.pk-log-table')).tableLayout, 'fixed');
    assert.equal(window.getComputedStyle(document.querySelector('.pk-log-table')).minWidth, '940px');
    const scroll = document.querySelector('.pk-log-scroll');
    assert.equal(window.getComputedStyle(scroll).overflowX, 'auto'); assert.equal(scroll.tabIndex, 0);
    assert.equal(scroll.getAttribute('aria-label'), '操作日志');
    await click('.pk-log-detail summary'); assert.equal(details.open, true);
    await act(async () => { document.documentElement.lang = 'en-US'; await new Promise(setImmediate); });
    assert.match(document.querySelector('.pk-log-summary').textContent, /Settings do not match the plugin schema · Audit copy failed/);
    assert.match(document.querySelector('.pk-log-metadata').textContent, /Record ID/);
    assert.match(document.querySelector('.pk-log-metadata').textContent, /Error code/);
    assert.equal(document.querySelector('.pk-log-scroll').getAttribute('aria-label'), 'Activity log');
    await click('[data-pk-tab="center"]');
    assert.equal(document.querySelector('.c89-panel').classList.contains('pk-panel-logs'), false);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});

test('component status is wired after activity logs and uses the same fixed panel across tabs', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const status = { schemaVersion: 1, checkedAt: '2026-01-01T00:00:00Z', overall: 'unknown', framework: { version: '0.1.5', enabled: false, compatibility: { compatible: null, reason: 'TOWER_BUILD_UNKNOWN', declared: { towerBuilds: ['4.9.0'] }, observed: { towerVersion: '4.9.0' } } }, components: [], plugins: [], actions: { repair: { available: false }, reset: { available: false }, support: { available: false } }, limitations: [] };
  const calls = [], client = async route => {
    calls.push(route);
    if (route.startsWith('/components/status')) return status;
    if (route === '/updates/status') return { reachable: true };
    if (route === '/runtime') return { enabled: false, version: '0.1.5' };
    if (route === '/plugins') return { items: [], packages: [] };
    if (route === '/market') return { schemaVersion: 3, items: [], source: { reachable: true } };
    return { items: [], next: null };
  };
  const Hub = createFrameworkHub({ client }), root = document.getElementById('root');
  const click = async selector => act(async () => { const node = document.querySelector(selector); assert.ok(node, selector); node.click(); await new Promise(setImmediate); });
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); });
    await click('.c89-plugin-fab');
    const panel = document.querySelector('.c89-panel'), header = panel.querySelector('header'), footer = panel.querySelector('footer');
    const size = () => { const style = window.getComputedStyle(panel); return { width: style.width, height: style.height, maxHeight: style.maxHeight }; };
    const original = size(); assert.match(original.width, /1220px/); assert.match(original.height, /90d?vh/); assert.match(original.height, /100d?vh - 48px/);
    assert.deepEqual([...document.querySelectorAll('.c89-nav [data-pk-tab]')].map(node => node.dataset.pkTab), ['center', 'market', 'logs', 'components', 'global']);
    const components = document.querySelector('[data-pk-tab="components"]'); assert.equal(components.nextElementSibling.textContent, '插件配置');
    for (const tab of ['global', 'logs', 'components', 'market', 'center']) {
      await click(`[data-pk-tab="${tab}"]`);
      assert.equal(document.querySelector('.c89-panel'), panel); assert.deepEqual(size(), original); assert.equal(panel.querySelector('header'), header); assert.equal(panel.querySelector('footer'), footer);
      assert.equal(panel.className, 'c89-panel');
    }
    await click('[data-pk-tab="components"]');
    assert.match(document.querySelector('.rv-components').textContent, /CloudTower 4\.9\.0/);
    assert.equal(calls.filter(route => route === '/components/status').length, 2);
    await click('.rv-components-refresh'); assert.equal(calls.filter(route => route === '/components/status?fresh=true').length, 1);
    const scrollStyle = window.getComputedStyle(panel.querySelector('.c89-content'));
    assert.equal(scrollStyle.overflowY, 'auto'); assert.equal(scrollStyle.minHeight, '0');
    assert.equal(window.getComputedStyle(header).flexShrink, '0'); assert.equal(window.getComputedStyle(footer).flexShrink, '0');
    await act(async () => { document.documentElement.lang = 'en-US'; await new Promise(setImmediate); });
    assert.equal(document.querySelector('[data-pk-tab="components"]').textContent, 'Component status');
    assert.equal(document.querySelector('.rv-components h3').textContent, 'Component status');
    await click('.pk-about-tab'); assert.deepEqual(size(), original);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; }
});

test('shared panel geometry has one definition and narrow navigation/content remain independently scrollable', () => {
  const rule = CSS.match(/\.c89-panel\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /width:min\(1220px,100%\)/); assert.match(rule, /height:min\(90vh,calc\(100vh - 48px\)\)/);
  assert.match(rule, /height:min\(90dvh,calc\(100dvh - 48px\)\)/);
  assert.equal((CSS.match(/\.c89-panel\{/g) || []).length, 1); assert.doesNotMatch(CSS, /pk-panel-logs/);
  assert.match(CSS, /\.c89-panel-body\{[^}]*min-height:0[^}]*overflow:hidden/);
  const mobile = CSS.slice(CSS.indexOf('@media(max-width:620px){.c89-panel-body'));
  assert.match(mobile, /grid-template-columns:1fr;grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(mobile, /\.c89-nav\{[^}]*overflow-x:auto;overflow-y:hidden/);
  assert.match(mobile, /\.c89-nav>\*\{flex:0 0 auto;white-space:nowrap\}/);
  assert.match(CSS, /\.c89-plugin-root \.rv-components button\.rv-components-confirm-repair\{color:white;background:#1683ff/);
});

test('compatibility reasons distinguish framework mismatch, SMTX mismatch and unavailable evidence in both languages', () => {
  const reasons = ['FRAMEWORK_TOWER_INCOMPATIBLE', 'FRAMEWORK_VERSION_UNKNOWN', 'PLUGIN_COMPATIBILITY_INVALID', 'SMTX_SNAPSHOT_UNAVAILABLE', 'SMTX_SNAPSHOT_INVALID', 'SMTX_SNAPSHOT_EXPIRED', 'SMTX_SCOPE_UNTRUSTED', 'SMTX_SCOPE_INCOMPLETE', 'SMTX_SCOPE_EMPTY', 'SMTX_VERSION_UNKNOWN', 'SMTX_INCOMPATIBLE'];
  for (const locale of ['zh-CN', 'en-US']) for (const reason of reasons) {
    const value = translator(locale)(reason); assert.notEqual(value, reason); assert.doesNotMatch(value, /EXAMPLE_SECRET|https?:|[A-Z]:\\/);
    if (reason.startsWith('SMTX_')) assert.match(value, /SMTX/);
  }
  assert.match(translator('zh-CN')('SMTX_SNAPSHOT_UNAVAILABLE'), /未知/);
  assert.match(translator('zh-CN')('SMTX_INCOMPATIBLE'), /已阻止插件执行/);
  assert.match(translator('en-US')('SMTX_SNAPSHOT_UNAVAILABLE'), /remains unknown/);
  assert.match(translator('en-US')('SMTX_INCOMPATIBLE'), /execution is blocked/);
});
