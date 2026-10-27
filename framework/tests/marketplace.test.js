import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createMarketplace } from '../src/marketplace.js';
const { act } = testUtils;
const id = 'rivetin-example', sha = 'a'.repeat(64), build = 'example-tested-build';
function documentData(overrides = {}) {
  return { towerBuild: build, source: { reachable: true }, items: [{ id, version: '0.1.0', name: { 'zh-CN': '示例插件', 'en-US': 'Example plugin' }, description: { 'zh-CN': '本地测试条目', 'en-US': 'Local test item' }, permissions: ['inventory.read'], compatibility: { towerBuilds: [build] }, compatible: true, installed: false, downloadable: true, published: true, sha256: sha }], ...overrides };
}
async function mount(t, { catalog = documentData(), locale = 'zh-CN', handle } = {}) {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const calls = [], callbacks = []; let installed = false;
  const client = async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (handle) { const value = await handle(route, method, body); if (value !== undefined) return value; }
    if (route === '/marketplace' && method === 'GET') return structuredClone(catalog);
    if (route === '/marketplace' && method === 'POST') { installed = true; return { installed: true, enabled: false }; }
    if (route === '/plugins') return { items: installed ? [{ id, version: '0.1.0', installed: true, enabled: false, active: false }] : [] };
    throw new Error('UNEXPECTED_REQUEST');
  };
  const Marketplace = createMarketplace(React), root = document.getElementById('root');
  const render = async value => act(async () => { ReactDOM.render(React.createElement(Marketplace, { client, locale: value, onInstalled: result => { callbacks.push(result); } }), root); await new Promise(setImmediate); });
  await render(locale);
  const click = async label => act(async () => { const button = [...document.querySelectorAll('button')].find(value => value.textContent === label); assert.ok(button, label); button.click(); await new Promise(setImmediate); });
  t.after(async () => { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; });
  return { calls, callbacks, click, render, catalog, root };
}
test('install requires confirmation disclosing version, permissions, tested build and digest; callback follows disabled readback', async t => {
  const { calls, callbacks, click } = await mount(t);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  await click('安装');
  const dialog = document.querySelector('[role="alertdialog"]');
  for (const value of ['0.1.0', 'inventory.read', build, sha, '安装后默认禁用']) assert.ok(dialog.textContent.includes(value), value);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  await click('确认安装');
  assert.deepEqual(calls.find(call => call.method === 'POST'), { route: '/marketplace', method: 'POST', body: { action: 'install', pluginId: id, version: '0.1.0' } });
  assert.deepEqual(callbacks, [{ id, version: '0.1.0', installed: true, enabled: false, active: false }]);
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.match(document.body.textContent, /已安装，当前保持禁用/);
  assert.equal([...document.querySelectorAll('button')].find(button => button.textContent === '已安装').disabled, true);
  assert.ok(!calls.some(call => call.body?.action === 'enable'));
});
test('unreachable source disables installation but refresh can restore access', async t => {
  const catalog = documentData({ source: { reachable: false, reason: 'EXAMPLE_NETWORK_FAILURE' } });
  const { calls, click } = await mount(t, { catalog });
  assert.equal(document.querySelector('.pk-market-select').disabled, true);
  assert.match(document.body.textContent, /安装已停用/);
  catalog.source.reachable = true; await click('刷新市场');
  assert.equal(document.querySelector('.pk-market-select').disabled, false);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});
test('unpublished, missing artifact, unverified compatibility and installed items cannot be installed', async t => {
  const catalog = documentData();
  catalog.items = [
    { ...catalog.items[0], id: 'rivetin-unpublished', published: false },
    { ...catalog.items[0], id: 'rivetin-no-download', downloadable: false },
    { ...catalog.items[0], id: 'rivetin-incompatible', compatible: false },
    { ...catalog.items[0], id: 'rivetin-no-digest', sha256: null },
    { ...catalog.items[0], id: 'rivetin-no-builds', compatibility: { towerBuilds: [] } },
    { ...catalog.items[0], id: 'rivetin-installed', installed: true, installedVersion: '0.0.9' },
  ];
  const { calls } = await mount(t, { catalog });
  assert.equal(document.querySelectorAll('.pk-market-select').length, 6);
  assert.ok([...document.querySelectorAll('.pk-market-select')].every(button => button.disabled));
  assert.match(document.body.textContent, /通过插件管理进行升级/);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});
test('installation status not confirmed disabled does not claim success or call the host callback', async t => {
  const { calls, callbacks, click } = await mount(t, { handle: async route => route === '/plugins' ? { items: [{ id, version: '0.1.0', installed: true, enabled: true, active: true }] } : undefined });
  await click('安装'); await click('确认安装');
  assert.equal(callbacks.length, 0); assert.ok(document.querySelector('[role="alertdialog"]'));
  assert.match(document.querySelector('[role="alert"]').textContent, /状态与预期不一致/);
  assert.equal(document.querySelector('.pk-market-install').disabled, true);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
test('uncertain POST outcome is reconciled with one read and never retried automatically', async t => {
  const { calls, callbacks, click } = await mount(t, { handle: async (route, method) => {
    if (route === '/marketplace' && method === 'POST') throw new Error('EXAMPLE_TIMEOUT');
    if (route === '/plugins') return { items: [{ id, version: '0.1.0', installed: true, enabled: false, active: false }] };
  } });
  await click('安装'); await click('确认安装');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1); assert.equal(callbacks.length, 1);
  assert.match(document.body.textContent, /已安装，当前保持禁用/);
});
test('raw server diagnostics are localized to a fixed safe error and an unconfirmed install stays blocked', async t => {
  const { callbacks, click } = await mount(t, { handle: async (route, method) => {
    if (route === '/marketplace' && method === 'POST') throw new Error('example-secret at /private/runtime/file');
  } });
  await click('安装'); await click('确认安装');
  assert.equal(callbacks.length, 0);
  assert.match(document.querySelector('[role="alert"]').textContent, /请求未完成/);
  assert.doesNotMatch(document.body.textContent, /example-secret|private\/runtime/);
  assert.equal(document.querySelector('.pk-market-install').disabled, true);
});
test('empty market displays an explicit empty state and locale follows the host', async t => {
  const { render } = await mount(t, { catalog: documentData({ items: [] }) });
  assert.match(document.body.textContent, /暂无已发布的插件条目/);
  await render('en-US'); assert.match(document.body.textContent, /no published plugins/);
  assert.equal(document.querySelectorAll('.pk-market-card').length, 0);
});
test('unknown null Tower build is a valid catalog state that blocks installation without hiding entries', async t => {
  const { calls } = await mount(t, { catalog: documentData({ towerBuild: null }) });
  assert.equal(document.querySelectorAll('.pk-market-card').length, 1);
  assert.match(document.body.textContent, /未知，禁止安装/);
  assert.equal(document.querySelector('.pk-market-select').disabled, true);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(calls.filter(item => item.method === 'POST').length, 0);
});
test('confirmation dialog owns focus and Escape without closing the parent Rivetin Plugin Center', async t => {
  const { click } = await mount(t);
  await click('安装');
  const dialog = document.querySelector('[role="alertdialog"]'), first = dialog.querySelector('button'), last = dialog.querySelector('.pk-market-install');
  let parentKeys = 0; const parent = () => { parentKeys++; }; document.addEventListener('keydown', parent);
  try {
    last.focus();
    await act(async () => last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    assert.equal(document.activeElement, first);
    await act(async () => first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('[role="alertdialog"]'), null); assert.equal(parentKeys, 0);
  } finally { document.removeEventListener('keydown', parent); }
});
