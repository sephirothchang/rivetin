import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createPluginHub } from '../src/plugin-hub.js';
import { sanitizeFunctionalSettings } from '../src/configuration.js';
import { PLUGIN_ID } from '../src/identity.js';
const { act } = testUtils;

test('shared settings UI seeds clusters, supports all three unsaved actions, and retains drafts after failed saves', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/hosts/host-a?view=%22detail%22', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  let saved = { revision: 0, updatedAt: null, settings: sanitizeFunctionalSettings() }, writes = 0, failSave = false;
  const remote = {
    load: async () => JSON.parse(JSON.stringify(saved)),
    save: async settings => {
      if (failSave) throw new Error('EXAMPLE_SAVE_FAILURE');
      writes++; saved = { revision: saved.revision + 1, updatedAt: 'EXAMPLE_TIMESTAMP', settings }; return JSON.parse(JSON.stringify(saved));
    },
  };
  const Hub = createPluginHub({ client: async route => route === '/runtime' ? { enabled: true } : route === '/plugins' ? { items: [{ id: PLUGIN_ID, installed: true, active: true, packageId: 'example', manifest: { name: { 'zh-CN': 'IPMI 跳转' } } }], packages: [] } : { items: [], next: null }, configurationBackend: () => remote, inventoryProvider: async () => ({
    hosts: [{ id: 'host-a', name: 'EXAMPLE_HOST', cluster: { id: 'cluster-a' } }],
    clusters: [{ id: 'cluster-a', name: 'EXAMPLE_CLUSTER_A' }, { id: 'cluster-b', name: 'EXAMPLE_CLUSTER_B' }],
  }) });
  const root = document.getElementById('root');
  const click = async selector => { await act(async () => { const element = document.querySelector(selector); assert.ok(element, selector); element.click(); await new Promise(setImmediate); }); };
  const change = async value => { await act(async () => { const select = document.getElementById('c89-default-vendor'); select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); };
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await new Promise(setImmediate); });
    await click('.c89-plugin-fab');
    const disclaimer = document.querySelector('[aria-label="免责声明"]');
    assert.ok(disclaimer?.querySelector('svg circle'));
    assert.ok(document.getElementById(disclaimer.getAttribute('aria-describedby')).textContent.includes('非 SmartX 官方产品；'));
    assert.equal(document.querySelector('.c89-project-meta a').href, 'https://github.com/sephirothchang/rivetin/tree/main/plugins/rivetin-ipmi-redirection');
    assert.equal(document.querySelectorAll('.c89-rule').length, 2);
    assert.equal(document.querySelector('[aria-label="例外 1 对象"]').value, 'cluster-a');
    assert.equal(document.querySelector('[aria-label="例外 2 对象"]').value, 'cluster-b');
    assert.equal(writes, 0);
    await click('.c89-finish');
    assert.equal(document.querySelector('[role="alertdialog"] h3').textContent, '存在未保存的更改');
    assert.deepEqual([...document.querySelectorAll('.c89-confirm-actions button')].map(value => value.textContent), ['取消', '丢弃并退出', '保存并退出']);
    await click('.c89-cancel-exit');
    assert.ok(document.querySelector('[role="dialog"]')); assert.equal(document.querySelector('[role="alertdialog"]'), null);
    await click('.c89-finish'); await click('.c89-discard-exit');
    assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(writes, 0);
    await click('.c89-plugin-fab'); await click('.c89-done');
    assert.equal(writes, 1); assert.equal(document.querySelector('.c89-done').disabled, true);
    await change('hpe-ilo');
    assert.equal(saved.settings.defaultVendor, 'generic');
    await click('.c89-finish'); await click('.c89-save-exit');
    assert.equal(writes, 2); assert.equal(saved.settings.defaultVendor, 'hpe-ilo');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await click('.c89-plugin-fab'); await change('dell-idrac'); failSave = true;
    await click('.c89-finish'); await click('.c89-save-exit');
    assert.ok(document.querySelector('[role="alertdialog"]'));
    assert.ok(document.querySelector('[role="alertdialog"]').textContent.includes('未能确认保存成功'));
    await click('.c89-cancel-exit');
    assert.equal(document.getElementById('c89-default-vendor').value, 'dell-idrac');
    assert.equal(saved.settings.defaultVendor, 'hpe-ilo');
    await click('.c89-close'); await click('.c89-discard-exit');
    await click('.c89-plugin-fab'); await click('[role="tab"]');
    await click('#pk-floating');
    await click('.c89-finish');
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.equal(writes, 2); assert.equal(document.querySelector('.c89-plugin-fab'), null);
  } finally {
    await act(async () => { ReactDOM.unmountComponentAtNode(root); });
    dom.window.close(); delete globalThis.window; delete globalThis.document;
  }
});
