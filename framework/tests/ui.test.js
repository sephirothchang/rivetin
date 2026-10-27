import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createFrameworkHub } from '../src/hub.js';
import { createConfigurationStore } from '../src/config-store.js';
const { act } = testUtils;
test('framework UI follows host locale, separates plugin drafts, confirms lifecycle actions and unmounts on emergency disable', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const id = 'pluginkit-example'; let enabled = true, active = 0, stopped = 0, saves = 0;
  let saved = { revision: 0, updatedAt: null, settings: { enabled: true } };
  const definition = { id, defaults: value => ({ enabled: value?.enabled !== false }), validate: value => value, equal: (a, b) => a.enabled === b.enabled, seed: value => value };
  const factory = () => ({ id, store: createConfigurationStore(window, { load: async () => structuredClone(saved), save: async settings => { saves++; saved = { revision: saves, updatedAt: 'EXAMPLE_TIME', settings }; return structuredClone(saved); } }, definition),
    activate: () => { active++; return () => { stopped++; }; },
    Settings: ({ store, preferences }) => React.createElement('input', { 'aria-label': 'EXAMPLE_SETTING', type: 'checkbox', checked: preferences.enabled, onChange: event => store.update({ enabled: event.target.checked }) }) });
  const client = async (route, method, body) => {
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
    assert.equal(document.querySelector('#pk-title').textContent, '插件中心');
    const emergencyStyle = window.getComputedStyle(document.querySelector('.pk-emergency'));
    assert.equal(emergencyStyle.backgroundColor, 'rgb(225, 25, 45)');
    assert.equal(emergencyStyle.color, 'rgb(255, 255, 255)'); assert.equal(emergencyStyle.fontWeight, '700');
    await act(async () => { document.documentElement.lang = 'en-US'; await new Promise(setImmediate); });
    assert.equal(document.querySelector('#pk-title').textContent, 'Plugin Center');
    assert.match(document.querySelector('.c89-plugin-fab').textContent, /Plugins enabled/);
    await click('[role="tab"]:nth-last-child(2)'); await click('[aria-label="EXAMPLE_SETTING"]');
    await click('.c89-finish'); assert.equal(document.querySelector('[role="alertdialog"] h3').textContent, 'Unsaved changes');
    await click('.c89-cancel-exit'); assert.ok(document.querySelector('[role="dialog"]'));
    await click('.c89-done'); assert.equal(saves, 1);
    await click('[role="tab"]:nth-child(2)');
    await click('.pk-framework button'); assert.equal(enabled, true); await click('.c89-confirm-actions .c89-discard-exit');
    assert.equal(enabled, false); assert.equal(stopped, 1); assert.ok(document.querySelector('.c89-content').textContent.includes('All plugins suspended'));
    assert.match(document.querySelector('.c89-plugin-fab').textContent, /Plugins disabled/);
    await click('.pk-framework button'); await click('.c89-confirm-actions .c89-save-exit'); assert.equal(active, 2);
    await click('[role="tab"]:nth-child(3)'); assert.ok(document.querySelector('.c89-content').textContent.includes('No activity yet'));
    await click('.pk-about-tab'); assert.match(document.querySelector('.pk-about').textContent, /Facebook/); assert.match(document.querySelector('.pk-about').textContent, /MIT License/);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});

test('update UI checks versions, offers online/manual methods and requires confirmation before applying a staged package', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const id = 'pluginkit-example', calls = []; let version = '0.1.0', available = true;
  const client = async (route, method, body) => {
    calls.push({ route, method, body });
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
    await selectFile(JSON.stringify({ manifest: { id: 'pluginkit-other' } }));
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

test('log table displays failure explanation and native delivery detail without a persistent warning banner', async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const event = { id: 'EXAMPLE_RECORD', time: '2026-01-01T00:00:00Z', actor: { name: 'EXAMPLE_ADMIN' }, action: 'configuration.save', result: 'failed', code: 'INVALID_SETTINGS', towerDelivery: { state: 'permission-denied', code: 'TOWER_AUDIT_SYSTEM_USER_REQUIRED' } };
  const client = async route => route === '/runtime' ? { enabled: false, version: '0.1.0', audit: 'permission-denied' } : route === '/plugins' ? { items: [], packages: [] } : { items: [event], next: null };
  const Hub = createFrameworkHub({ client }), root = document.getElementById('root');
  const click = async selector => act(async () => { document.querySelector(selector).click(); await new Promise(setImmediate); });
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); });
    await click('.c89-plugin-fab'); await click('[role="tab"]:nth-child(3)');
    assert.match(document.querySelector('.pk-table thead').textContent, /内容/);
    assert.match(document.querySelector('.pk-log-detail').textContent, /INVALID_SETTINGS/);
    assert.match(document.querySelector('.pk-log-detail').textContent, /only allow by system user/);
    assert.equal(document.querySelector('.c89-content > .pk-muted'), null);
    assert.match(document.querySelector('.pk-log-detail details').textContent, /EXAMPLE_RECORD/);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});
