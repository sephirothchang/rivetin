import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import createPlugin from '../src/definition.js';
import { defaults } from '../src/configuration.js';
import { identifyResource } from '../src/resources.js';

const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom'), React = require('react');
const copy = value => JSON.parse(JSON.stringify(value));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await pause(3);
  assert.ok(predicate(), 'expected native/custom menu state did not appear before the bounded deadline');
}
async function fixture(t, { popupDelay = 0 } = {}) {
  const dom = new JSDOM('<table><thead><tr><th>名称</th><th>状态</th><th>虚拟机数</th><th>描述</th><th>创建时间</th></tr></thead><tbody><tr data-row-key="placement-a"><td unique="name">Placement demo</td><td>Normal</td><td>0</td><td></td><td></td><td unique="_action_"><span class="menu-button ant-dropdown-trigger" aria-controls="native-placement-menu"><img alt="1-more-ellipsis-3-16-bold-blue"></span></td></tr></tbody></table><div id="native-placement-menu" class="ant-dropdown" hidden><ul role="menu"><li role="menuitem">编辑</li><li role="menuitem">删除</li></ul></div>', { url: 'https://tower.example.invalid/#/clusters/cluster-a?view=%22vmPlacementGroups%22', pretendToBeVisual: true });
  const win = dom.window, doc = win.document, row = doc.querySelector('tbody tr'), source = row.querySelector('td[unique="name"]'), trigger = row.querySelector('.ant-dropdown-trigger'), popup = doc.getElementById('native-placement-menu');
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{ width: 160, height: 30 }]; };
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 160, height: 30, right: 170, bottom: 40 });
  const intervals = new Map(), interval = win.setInterval.bind(win), clearInterval = win.clearInterval.bind(win);
  let poll;
  win.setInterval = (fn, delay, ...args) => { const id = interval(fn, delay, ...args); intervals.set(id, delay); if (delay === 15000) poll = fn; return id; };
  win.clearInterval = id => { intervals.delete(id); clearInterval(id); };
  const counts = { more: 0, leaf: 0, reads: 0 }, errors = [];
  let response = { revision: 0, updatedAt: null, settings: defaults() }, loadError = false, stopped = false;
  const backend = {
    async load() { counts.reads++; if (loadError) throw new Error('LOCAL_LOAD_FAILURE'); return copy(response); },
    async save(settings) { response = { revision: response.revision + 1, updatedAt: null, settings: copy(settings) }; return copy(response); },
  };
  trigger.onclick = event => {
    event.stopPropagation(); counts.more++;
    const toggle = () => { popup.hidden = !popup.hidden; trigger.setAttribute('aria-expanded', String(!popup.hidden)); };
    if (popupDelay && popup.hidden) win.setTimeout(toggle, popupDelay); else toggle();
  };
  popup.querySelectorAll('li').forEach(item => { item.onclick = () => counts.leaf++; });
  const plugin = createPlugin({ React, win, options: { configurationBackend: () => backend } });
  await plugin.store.load(); const dispose = plugin.activate(message => errors.push(message));
  const stop = () => { if (!stopped) { stopped = true; dispose(); } };
  t.after(() => { stop(); plugin.store.dispose(); win.close(); });
  assert.equal(identifyResource(source, win)?.type, 'vmPlacementGroup');
  const root = () => doc.querySelector('[data-rivetin-resource-menu]');
  function rightClick() { source.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); }
  async function open() { rightClick(); await until(() => root()?.querySelectorAll('button').length === 2); assert.equal(popup.hidden, true); return root(); }
  return { win, doc, row, source, popup, plugin, root, open, rightClick, counts, errors, intervals, stop,
    poll() { assert.equal(typeof poll, 'function'); poll(); },
    server(settings, revision = response.revision + 1) { response = { revision, updatedAt: null, settings }; },
    failLoad() { loadError = true; },
  };
}

test('the real unchanged store.load preserves an already-rendered placement menu and its proof', async t => {
  const f = await fixture(t), original = await f.open(), more = f.counts.more;
  await f.plugin.store.load();
  assert.equal(f.root(), original, 'loading status and identical saved settings must not remove the menu');
  assert.equal(f.counts.more, more); assert.equal(f.counts.leaf, 0); assert.deepEqual(f.errors, []);
});

test('the registered fifteen-second poll callback preserves an unchanged visible resource menu', async t => {
  const f = await fixture(t), original = await f.open(), reads = f.counts.reads;
  f.poll(); await until(() => f.counts.reads === reads + 1); await pause(5);
  assert.equal(f.root(), original); assert.equal(f.counts.leaf, 0); assert.deepEqual(f.errors, []);
});

test('unchanged store.load during native preparation does not abort it or strand a late native popup', async t => {
  const f = await fixture(t, { popupDelay: 30 }); f.rightClick(); await until(() => f.counts.more === 1);
  await f.plugin.store.load(); await until(() => f.root()?.querySelectorAll('button').length === 2);
  assert.equal(f.popup.hidden, true); assert.equal(f.counts.more, 2); assert.equal(f.counts.leaf, 0); assert.deepEqual(f.errors, []);
});

test('a background configuration read error preserves the last effective menu settings', async t => {
  const f = await fixture(t), original = await f.open(); f.failLoad(); await f.plugin.store.load();
  assert.ok(f.plugin.store.status().error); assert.equal(f.root(), original); assert.equal(f.counts.leaf, 0);
});

test('revision-only changes, resource-type set reordering and browser preferences do not revoke an unchanged menu', async t => {
  const f = await fixture(t), original = await f.open(), settings = defaults(); settings.resourceTypes.reverse(); f.server(settings, 23);
  await f.plugin.store.load(); assert.equal(f.root(), original); assert.equal(f.plugin.store.status().revision, 23);
  f.plugin.store.update({ showFloatingButton: false }); assert.equal(f.root(), original); assert.equal(f.counts.leaf, 0);
});

for (const change of ['enabled', 'nativeActions', 'resourceTypes']) test(`a genuine saved ${change} change revokes the open resource menu before any old leaf can execute`, async t => {
  const f = await fixture(t), original = await f.open(), oldButton = original.querySelector('button'), settings = defaults();
  if (change === 'resourceTypes') settings.resourceTypes = settings.resourceTypes.filter(type => type !== 'vmPlacementGroup'); else settings[change] = false;
  f.server(settings); await f.plugin.store.load();
  assert.equal(f.root(), null); oldButton.click(); await pause(5); assert.equal(f.counts.leaf, 0);
});

test('editing a draft does not revoke saved permissions, while saving its real functional change revokes the menu', async t => {
  const f = await fixture(t), original = await f.open(); f.plugin.store.update({ enabled: false });
  assert.equal(f.root(), original); assert.equal(f.plugin.store.get().enabled, true);
  assert.equal(await f.plugin.store.save(), true); assert.equal(f.root(), null); assert.equal(f.counts.leaf, 0);
});

test('a real row replacement still cancels an open menu instead of following a same-name replacement', async t => {
  const f = await fixture(t); const original = await f.open(), oldButton = original.querySelector('button'), replacement = f.row.cloneNode(true); f.row.replaceWith(replacement);
  await until(() => !f.root()); oldButton.click(); await pause(5); assert.equal(f.counts.leaf, 0);
});

test('stop removes all interval registrations and prevents configuration notifications from resurrecting menus', async t => {
  const f = await fixture(t); await f.open(); f.stop();
  assert.equal(f.root(), null); assert.equal(f.intervals.size, 0); assert.equal(f.doc.querySelectorAll('style').length, 0);
  await f.plugin.store.load(); f.rightClick(); await pause(10); assert.equal(f.root(), null); assert.equal(f.counts.leaf, 0);
});
