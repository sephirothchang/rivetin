import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNativeResourceMenu } from '../src/native/resource-menu.js';
import createPlugin from '../src/definition.js';
import { defaults } from '../src/configuration.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(t) {
  const dom = new JSDOM('<table><tbody><tr data-row-key="host-demo"><td unique="name">Host demo</td></tr></tbody></table>', { url: 'https://tower.example.invalid/#/clusters/demo?view=%22hosts%22' });
  const win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30 });
  const resource = { type: 'host', id: 'host-demo', name: 'Host demo', element: doc.querySelector('tr') };
  const called = [], errors = [];
  const adapter = { async prepare() { return { tree: [{ id: 'config', label: 'Configure', children: [{ id: 'nested', label: 'Advanced', children: [{ id: 'edit', label: 'Edit' }, { id: 'blocked', label: 'Disabled', disabled: true }] }] }, { id: 'remove', label: 'Remove', danger: true }], execute: async id => { called.push(id); return { status: 'handed-off' }; }, close() { called.push('close'); } }; } };
  const menu = installNativeResourceMenu({ win, adapter, onError: x => errors.push(x) });
  t.after(() => { menu.stop(); win.close(); });
  return { win, doc, menu, resource, called, errors, flush: async () => { await new Promise(resolve => win.setTimeout(resolve, 1)); } };
}
test('resource menu renders nested sideways levels and delegates an exact opaque leaf', async t => {
  const f = fixture(t); assert.equal(f.menu.open(f.resource, 100, 120), true); await f.flush();
  const button = id => f.doc.querySelector(`[data-native-entry-id="${id}"]`);
  button('config').click(); button('nested').click();
  assert.equal(f.doc.querySelectorAll('.rrm-child').length, 2);
  assert.equal(button('blocked').disabled, true);
  button('edit').click(); await f.flush();
  assert.deepEqual(f.called, ['edit', 'close']); assert.equal(f.doc.querySelector('[data-rivetin-resource-menu]'), null); assert.deepEqual(f.errors, []);
});
test('changed row identity cancels without a native leaf click', async t => {
  const f = fixture(t); f.menu.open(f.resource, 10, 10); await f.flush();
  f.resource.element.setAttribute('data-row-key', 'different'); await f.flush();
  assert.equal(f.doc.querySelector('[data-rivetin-resource-menu]'), null); assert.ok(!f.called.includes('remove'));
});
test('keyboard enters children and returns to the previous persistent level', async t => {
  const f = fixture(t); f.menu.open(f.resource, 10, 10); await f.flush();
  const parent = f.doc.querySelector('[data-native-entry-id="config"]'); parent.focus(); parent.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(f.doc.querySelectorAll('.rrm-child').length, 1);
  f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(f.doc.querySelectorAll('.rrm-child').length, 0); assert.equal(f.doc.activeElement, parent);
  parent.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(f.doc.querySelector('[data-rivetin-resource-menu]'), null);
});

function pendingFixture(t) {
  const dom = new JSDOM('<table><tr data-row-key="host-a"><td unique="name">Host A</td></tr><tr data-row-key="host-b"><td unique="name">Host B</td></tr></table>', { url: 'https://tower.example.invalid/#/hosts' });
  const win = dom.window, doc = win.document, sessions = [], business = [], errors = [];
  win.HTMLElement.prototype.getClientRects = () => [{ width: 180, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 20, top: 20, right: 200, bottom: 150, width: 180, height: 130 });
  const adapter = { async prepare(resource, { signal }) {
    const gate = deferred(), session = { resource, signal, gate, started: 0, closed: 0, tree: [{ id: 'edit', label: 'Edit' }],
      async execute() { session.started++; const result = await gate.promise; if (!signal.aborted) business.push(resource.id); return result || { status: 'handed-off' }; },
      close() { session.closed++; },
    }; sessions.push(session); return session;
  } };
  const menu = installNativeResourceMenu({ win, adapter, onError: message => errors.push(message) });
  t.after(() => { menu.stop(); win.close(); });
  const resource = id => ({ type: 'host', id, name: id, element: doc.querySelector(`tr[data-row-key="${id}"]`) });
  const root = () => doc.querySelector('[data-rivetin-resource-menu]');
  async function open(id = 'host-a') { assert.equal(menu.open(resource(id), 30, 50), true); await settle(); assert.ok(root()); }
  const execute = () => root().querySelector('[data-native-entry-id="edit"]').click();
  return { win, doc, menu, sessions, business, errors, root, open, execute };
}

for (const cancellation of ['close', 'stop', 'new menu']) test(`${cancellation} cancels a native execution after the plugin surface has already been removed`, async t => {
  const f = pendingFixture(t); await f.open(); f.execute(); const former = f.sessions[0];
  assert.equal(former.started, 1); assert.equal(f.root(), null);
  if (cancellation === 'new menu') await f.open('host-b'); else f.menu[cancellation]();
  assert.equal(former.signal.aborted, true); assert.equal(former.closed, 1);
  const current = f.root(); former.gate.resolve(); await settle(); assert.deepEqual(f.business, []); assert.equal(former.closed, 1); assert.deepEqual(f.errors, []);
  if (cancellation === 'new menu') { assert.equal(f.root(), current); assert.equal(f.sessions[1].signal.aborted, false); assert.equal(f.sessions[1].closed, 0); }
  else assert.equal(f.root(), null);
});

test('an old execution finally cannot discard cancellation of a newer execution or report its late error', async t => {
  const f = pendingFixture(t); await f.open(); f.execute(); const old = f.sessions[0]; await f.open('host-b'); f.execute(); const current = f.sessions[1];
  old.gate.reject(new Error('OLD_PRIVATE_ERROR')); await settle(); assert.equal(current.signal.aborted, false); assert.deepEqual(f.errors, []);
  f.menu.close(); assert.equal(current.signal.aborted, true); current.gate.resolve(); await settle();
  assert.deepEqual(f.business, []); assert.equal(old.closed, 1); assert.equal(current.closed, 1); assert.equal(f.root(), null);
});

async function productionFixture(t) {
  const dom = new JSDOM('<table><tr data-row-key="host-a"><td unique="name" id="source">Host A</td><td unique="_action_"><button class="menu-button ant-dropdown-trigger" title="More">More</button></td></tr></table>', { url: 'https://tower.example.invalid/#/hosts' });
  const win = dom.window, doc = win.document, React = require('react'), errors = [];
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden],.ant-dropdown-hidden') ? [] : [this.getBoundingClientRect()]; };
  win.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 20, top: this.classList.contains('ant-dropdown') ? 50 : 20, right: 200, bottom: 180, width: 180, height: 130 }; };
  const popup = doc.createElement('div'); popup.className = 'ant-dropdown ant-dropdown-hidden'; popup.hidden = true; popup.innerHTML = '<ul role="menu"><li role="menuitem">Edit</li></ul>'; doc.body.append(popup);
  let settings = defaults(), toggles = 0, business = 0, network = 0, release;
  const trigger = doc.querySelector('.ant-dropdown-trigger');
  const expose = open => { popup.hidden = !open; popup.classList.toggle('ant-dropdown-hidden', !open); trigger.classList.toggle('ant-dropdown-open', open); };
  trigger.onclick = event => { event.stopPropagation(); toggles++; if (toggles === 3) release = () => expose(true); else expose(popup.hidden); };
  popup.querySelector('li').onclick = () => { business++; const dialog = doc.createElement('section'); dialog.className = 'ant-modal'; dialog.textContent = 'Native edit dialog'; doc.body.append(dialog); };
  win.fetch = () => { network++; throw new Error('NO_NETWORK'); };
  const plugin = createPlugin({ React, win, history: { listen: () => () => {} }, options: { configurationBackend: () => ({ load: async () => ({ settings, revision: 1, updatedAt: null }) }) } });
  await plugin.store.load(); const stop = plugin.activate(message => errors.push(message));
  t.after(() => { stop(); plugin.store.dispose(); win.close(); });
  async function until(predicate) {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'expected local DOM handoff did not occur within the bounded wait');
  }
  async function begin() {
    doc.querySelector('#source').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 50 }));
    await until(() => doc.querySelector('[data-rivetin-resource-menu] [data-native-entry-id]'));
    doc.querySelector('[data-rivetin-resource-menu] [data-native-entry-id]').click(); await until(() => typeof release === 'function');
    assert.equal(doc.querySelector('[data-rivetin-resource-menu]'), null);
  }
  return { win, doc, plugin, stop, errors, begin, until, release: () => release(), counts: () => ({ business, network, toggles }),
    async changeUnrelatedType() { settings = { ...settings, resourceTypes: settings.resourceTypes.filter(type => type !== 'nic') }; await plugin.store.load(); },
  };
}

test('a real saved configuration change cancels the production row handoff even when its resource type stays enabled', async t => {
  const f = await productionFixture(t); await f.begin(); await f.changeUnrelatedType();
  assert.equal(f.plugin.store.get().resourceTypes.includes('host'), true); f.release(); await settle(); await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.counts().business, 0); assert.equal(f.counts().network, 0); assert.equal(f.doc.querySelector('.ant-modal'), null); assert.deepEqual(f.errors, []);
});

test('an unchanged saved settings refresh preserves the production handoff and never closes its native dialog', async t => {
  const f = await productionFixture(t); await f.begin(); await f.plugin.store.load(); f.release(); await f.until(() => f.counts().business === 1);
  const dialog = f.doc.querySelector('.ant-modal'); assert.ok(dialog); f.stop(); assert.equal(dialog.isConnected, true); assert.equal(f.counts().network, 0); assert.deepEqual(f.errors, []);
});
