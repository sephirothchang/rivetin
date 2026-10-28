import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import createPlugin from '../src/definition.js';
import { defaults } from '../src/configuration.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom'), React = require('react');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
test('the production factory hands a list action to official object UI with zero resource bridge or configuration forms', async t => {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td unique="name">VM A</td></tr></table>', { url: 'https://tower.example.invalid/#/clusters/cluster-a?view=%22vms%22' });
  const win = dom.window, doc = win.document, listeners = new Set();
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 310, height: 450, bottom: 450 });
  let resourceCalls = 0, httpCalls = 0, businessClicks = 0, navigation = 0, entries = 0;
  win.fetch = async () => { httpCalls++; throw new Error('UNEXPECTED_TRANSPORT'); };
  const history = { listen(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const plugin = createPlugin({ React, win, history, options: {
    configurationBackend: () => ({ load: async () => ({ settings: defaults(), revision: 0, updatedAt: null }) }),
    resourceActions() { resourceCalls++; throw new Error('CUSTOM_MUTATION_BRIDGE_MUST_NOT_LOAD'); },
  } });
  const errors = []; await plugin.store.load(); const stop = plugin.activate(value => errors.push(value));
  t.after(() => { stop(); win.close(); });
  const cell = doc.querySelector('td');
  cell.onclick = () => {
    navigation++; assert.equal(doc.querySelector('[data-rivetin-object-menu]'), null, 'custom menu must be gone before official navigation');
    win.history.replaceState({}, '', '#/clusters/cluster-a?view=%22vms%22&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' })));
    for (const fn of [...listeners]) fn();
    doc.body.insertAdjacentHTML('beforeend', '<aside class="drawer-content-inner"><div class="title-wrapper"><span class="header-title">VM A</span></div><div>基本信息<span class="extra-action"><button class="edit-icon" id="official-edit">编辑</button></span></div></aside>');
    doc.querySelector('#official-edit').onclick = () => {
      entries++; doc.body.insertAdjacentHTML('beforeend', '<section class="ant-modal"><h2 class="ant-modal-title">编辑虚拟机</h2><button id="official-confirm">保存</button></section>');
      doc.querySelector('#official-confirm').onclick = () => businessClicks++;
    };
  };
  cell.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await settle();
  const menu = doc.querySelector('[data-rivetin-object-menu]'); assert.ok(menu); assert.match(menu.textContent, /官方原生界面/);
  menu.querySelector('[data-group-id="vm.hardware"]').click();
  const cpu = menu.querySelector('[data-action-id="vm.hardware.cpu"]'); assert.equal(cpu.disabled, false); cpu.click(); await settle();
  assert.equal(navigation, 1); assert.equal(entries, 1); assert.equal(businessClicks, 0); assert.equal(resourceCalls, 0); assert.equal(httpCalls, 0);
  assert.equal(doc.querySelector('[data-rivetin-action-form]'), null); assert.equal(doc.querySelector('[data-rivetin-object-menu]'), null);
  assert.equal(doc.querySelector('[data-rivetin-native-guide]'), null);
  assert.equal(doc.querySelector('.ant-modal-title')?.textContent, '编辑虚拟机');
  assert.ok(doc.querySelector('.drawer-content-inner')); assert.deepEqual(errors, []);
  stop(); assert.equal(doc.querySelector('[data-rivetin-native-guide]'), null); assert.ok(doc.querySelector('.drawer-content-inner'));
});
