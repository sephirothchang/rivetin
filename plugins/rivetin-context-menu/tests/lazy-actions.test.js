import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installContextMenu } from '../src/menu.js';
import { defaults } from '../src/configuration.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const frame = '<aside class="frame"><div class="title-wrapper"><span class="header-title">VM A</span></div><div class="toolbar"><button id="native">关机</button></div></aside>';
function fixture(t, { removeRow = false, delay = 30, render = true } = {}) {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td unique="name" id="target">VM A</td></tr></table>', { url: 'https://tower.example.invalid/#/clusters/cluster-a?view=%22vms%22' }), win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 100, top: 50, bottom: 80, width: 280, height: 300 });
  let settings = defaults(), navigations = 0, mutations = 0; const listeners = new Set();
  const store = { get: () => settings, status: () => ({ loaded: true }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set: patch => { settings = { ...settings, ...patch }; for (const fn of listeners) fn(); } };
  function route(id) { win.history.replaceState({}, '', '#/clusters/cluster-a?view=%22vms%22&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id, view: 'detail' }))); }
  doc.querySelector('#target').onclick = () => {
    navigations++; route('vm-a'); if (removeRow) doc.querySelector('table').remove();
    if (render) win.setTimeout(() => { doc.body.insertAdjacentHTML('beforeend', frame); doc.querySelector('#native').onclick = () => mutations++; }, delay);
  };
  const stop = installContextMenu({ win, store, history: { listen: () => () => {} } });
  t.after(() => { stop(); win.close(); });
  const buttons = () => [...doc.querySelectorAll('[role="menuitem"]')];
  const action = text => buttons().find(button => button.textContent.includes(text));
  function open() { doc.querySelector('#target').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 150 })); }
  function load() { open(); action('显示可用操作').click(); }
  return { win, doc, store, stop, route, open, load, buttons, action, counts: () => ({ navigations, mutations }) };
}
async function until(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('EXPECTED_UI_STATE_NOT_REACHED'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test('right-click itself does not navigate; loading actions only opens the same resource', async t => {
  const f = fixture(t); f.open(); assert.deepEqual(f.counts(), { navigations: 0, mutations: 0 });
  f.action('显示可用操作').click(); assert.deepEqual(f.counts(), { navigations: 1, mutations: 0 });
  await until(() => f.action('关机')); assert.equal(f.counts().mutations, 0); f.action('关机').click(); assert.equal(f.counts().mutations, 1);
});
test('a replaced source row can rebind only to its matching detail title', async t => {
  const f = fixture(t, { removeRow: true }); f.load(); await until(() => f.action('关机'));
  assert.equal(f.doc.querySelector('table'), null); assert.equal(f.counts().mutations, 0);
});
for (const cancel of ['escape', 'outside', 'disable', 'stop']) test(`cancel ${cancel} prevents delayed menu reappearance`, async t => {
  const f = fixture(t); f.load();
  if (cancel === 'escape') f.doc.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (cancel === 'outside') f.doc.body.dispatchEvent(new f.win.Event('pointerdown', { bubbles: true }));
  if (cancel === 'disable') f.store.set({ enabled: false });
  if (cancel === 'stop') f.stop();
  await until(() => f.doc.querySelector('#native')); await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(f.doc.querySelector('[role="menu"]'), null); assert.equal(f.counts().mutations, 0);
});
test('navigating to another ID while loading suppresses late controls with an identical title', async t => {
  const f = fixture(t); f.load(); f.route('vm-b'); await until(() => f.doc.querySelector('#native')); await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(f.doc.querySelector('[role="menu"]'), null); assert.equal(f.counts().mutations, 0);
});
test('a same-name toolbar from the previously selected object cannot be borrowed after navigation', async t => {
  const f = fixture(t, { delay: 180 }); f.route('vm-b'); f.doc.body.insertAdjacentHTML('beforeend', frame);
  let wrongMutations = 0; const previous = f.doc.querySelector('.frame'); previous.querySelector('button').onclick = () => wrongMutations++;
  f.load(); await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(!f.action('关机')); assert.equal(wrongMutations, 0);
  previous.remove(); await until(() => f.action('关机')); f.action('关机').click(); assert.equal(wrongMutations, 0); assert.equal(f.counts().mutations, 1);
});
test('an unmatched toolbar times out with a visible fallback, without executing an action', async t => {
  const f = fixture(t, { render: false }); f.load();
  await until(() => f.doc.querySelector('[role="status"]')?.textContent.includes('当前没有可确认'), 6000);
  assert.deepEqual(f.counts(), { navigations: 1, mutations: 0 }); assert.ok(!f.action('关机'));
});
