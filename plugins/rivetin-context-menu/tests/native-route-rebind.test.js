import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import createPlugin from '../src/definition.js';
import { defaults } from '../src/configuration.js';
import { createNativeActionProvider } from '../src/native/provider.js';

const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom'), React = require('react');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); await tick(); }
const href = id => '#/vms/' + id + '?view=%22detail%22';
const resource = { type: 'vm', id: 'vm-a', name: 'Same VM name' };
async function fixture(t, { direct = false, list = false, initialId = 'vm-a', initialOwner = 'vm-a' } = {}) {
  const dom = new JSDOM('<table><tbody><tr data-row-key="vm-a"><td unique="name">Same VM name</td></tr></tbody></table>', {
    url: 'https://tower.example.invalid/' + (list ? '#/clusters/cluster-a?view=%22vms%22' : href('vm-a')),
  });
  const win = dom.window, doc = win.document, callbacks = new Set(), errors = [];
  win.HTMLElement.prototype.getClientRects = () => [{ width: 180, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 310, height: 450, right: 320, bottom: 460 });
  const counts = { oldB: 0, freshA: 0, submit: 0, http: 0, navigation: 0 };
  win.fetch = () => { counts.http++; throw new Error('NO_LIVE_TRANSPORT'); };
  const history = { listen(fn) { callbacks.add(fn); return () => callbacks.delete(fn); } };
  const notify = channel => {
    if (channel === 'history') for (const callback of [...callbacks]) callback();
    else win.dispatchEvent(new win.Event(channel));
  };
  const route = (id, channel = 'history') => { win.history.replaceState({}, '', href(id)); notify(channel); };
  function handler(owner) {
    return () => {
      counts[owner === 'vm-b' ? 'oldB' : 'freshA']++;
      const modal = doc.createElement('section'); modal.className = 'ant-modal'; modal.dataset.mockOwner = owner;
      modal.innerHTML = '<h2 class="ant-modal-title">编辑虚拟机</h2><button>保存</button>';
      modal.querySelector('button').onclick = () => counts.submit++; doc.body.append(modal);
    };
  }
  function pane({ editor, explicitId } = {}) {
    const node = doc.createElement('aside'); node.className = 'drawer-content-inner frame';
    if (explicitId) node.dataset.resourceId = explicitId;
    node.innerHTML = '<div class="title-wrapper"><span class="header-title">Same VM name</span></div><div class="detail-tabs"><button class="tab-item active" aria-selected="true">详情</button></div><h3>基本信息<span class="extra-action"><button class="edit-icon">编辑</button></span></h3>';
    const placeholder = node.querySelector('.edit-icon');
    if (editor) placeholder.replaceWith(editor); else placeholder.onclick = handler('vm-a');
    doc.querySelector('.drawer-content-inner')?.remove(); doc.body.append(node); return node;
  }
  let currentPane = pane({ explicitId: initialId });
  currentPane.querySelector('.edit-icon').onclick = handler(initialOwner);
  const makeProvider = () => createNativeActionProvider({ win, history, timeoutMs: 100, onError: message => errors.push(message) });
  let provider = direct ? makeProvider() : null;
  const makePlugin = () => createPlugin({ React, win, history, options: {
    configurationBackend: () => ({ load: async () => ({ settings: defaults(), revision: 0, updatedAt: null }) }),
    resourceActions() { throw new Error('NO_BUSINESS_ACTION_BRIDGE'); },
  } });
  const plugin = direct ? null : makePlugin(), extraStops = [];
  let stop;
  if (plugin) { await plugin.store.load(); stop = plugin.activate(message => errors.push(message)); }
  const stopPrimary = () => { const previous = stop; stop = null; previous?.(); };
  t.after(() => { stopPrimary(); provider?.stop(); for (const dispose of extraStops) dispose(); plugin?.store.dispose(); win.close(); });
  const title = () => currentPane.querySelector('.header-title');
  function aba(channel = 'history') {
    const old = currentPane.querySelector('.edit-icon');
    currentPane.removeAttribute('data-resource-id');
    route('vm-b', channel); old.onclick = handler('vm-b'); route('vm-a', channel); return old;
  }
  function replace(options) { currentPane = pane(options); return currentPane; }
  async function cpuFrom(source = title()) {
    source.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); await settle();
    const menu = doc.querySelector('[data-rivetin-object-menu]'); if (!menu) return 'rejected';
    const group = menu.querySelector('[data-group-id="vm.hardware"]'); if (!group) return 'rejected'; group.click(); await settle();
    const cpu = menu.querySelector('[data-action-id="vm.hardware.cpu"]'); if (!cpu || cpu.disabled) return 'disabled';
    cpu.click(); await settle(); await new Promise(resolve => setTimeout(resolve, 25));
    return errors.length ? 'diagnosed' : doc.querySelector('.ant-modal') ? 'dialog' : 'pending';
  }
  function directRequest() { provider.bindSource(title()); const data = provider.read(resource); return { resource, actionId: 'vm.hardware.cpu', snapshot: data.snapshot }; }
  function directRequestFor(other) { other.bindSource(title()); const data = other.read(resource); return { resource, actionId: 'vm.hardware.cpu', snapshot: data.snapshot }; }
  return { win, doc, plugin, counts, errors, history, notify, route, aba, replace, title, cpuFrom, directRequest, directRequestFor, handler, stopPrimary,
    recreateProvider() { provider.stop(); provider = makeProvider(); },
    additionalProvider() { const other = makeProvider(); extraStops.push(() => other.stop()); return other; },
    reactivate() { stopPrimary(); stop = plugin.activate(message => errors.push(message)); },
    async additionalFactory() { const other = makePlugin(); await other.store.load(); const dispose = other.activate(message => errors.push(message)); extraStops.push(() => { dispose(); other.store.dispose(); }); return other; },
    get provider() { return provider; }, get pane() { return currentPane; }, get source() { return doc.querySelector('td[unique="name"]'); } };
}

test('real factory rejects a reused same-name drawer/editor after A-B-A history notifications instead of invoking its old B callback', async t => {
  const f = await fixture(t); f.aba('history'); const result = await f.cpuFrom();
  assert.equal(f.counts.oldB, 0, `old B handler was reached (${result})`);
  assert.equal(f.doc.querySelector('.ant-modal[data-mock-owner="vm-b"]'), null);
  assert.equal(f.counts.submit + f.counts.http, 0);
});

for (const channel of ['hashchange', 'popstate']) test(`real factory rejects retained B controls after A-B-A ${channel} events and a fresh right-click`, async t => {
  const f = await fixture(t); f.aba(channel); await f.cpuFrom();
  assert.equal(f.counts.oldB, 0); assert.equal(f.doc.querySelector('.ant-modal[data-mock-owner="vm-b"]'), null);
  assert.equal(f.counts.submit + f.counts.http, 0);
});

test('a matching explicit data-resource-id on a reused pane cannot wash away an earlier wrong-object control binding', async t => {
  const f = await fixture(t); f.aba(); f.pane.dataset.resourceId = 'vm-a'; await f.cpuFrom();
  assert.equal(f.counts.oldB, 0); assert.equal(f.doc.querySelector('.ant-modal'), null); assert.equal(f.counts.submit + f.counts.http, 0);
});

for (const explicitId of [undefined, 'vm-a']) test(`a retired old B editor moved into a new pane stays blocked even with explicitId=${explicitId || 'none'}`, async t => {
  const f = await fixture(t), old = f.aba(); f.replace({ editor: old, explicitId }); await f.cpuFrom();
  assert.equal(f.counts.oldB, 0); assert.equal(f.doc.querySelector('.ant-modal'), null); assert.equal(f.counts.submit + f.counts.http, 0);
});

test('replacing the pane, title and editor after A-B-A permits a fresh A native dialog', async t => {
  const f = await fixture(t), oldPane = f.pane, oldTitle = f.title(), oldEditor = f.aba(); f.replace();
  assert.notEqual(f.pane, oldPane); assert.notEqual(f.title(), oldTitle); assert.notEqual(f.pane.querySelector('.edit-icon'), oldEditor);
  assert.equal(await f.cpuFrom(), 'dialog'); assert.equal(f.counts.freshA, 1); assert.equal(f.counts.oldB, 0);
  assert.equal(f.doc.querySelector('.ant-modal').dataset.mockOwner, 'vm-a'); assert.equal(f.counts.submit + f.counts.http, 0);
});

for (const channel of ['history', 'hashchange', 'popstate']) test(`a same-URL ${channel} refresh notification does not retire an unchanged valid A editor`, async t => {
  const f = await fixture(t), original = f.pane.querySelector('.edit-icon'), before = f.win.location.href; f.notify(channel);
  assert.equal(f.win.location.href, before); assert.equal(f.pane.querySelector('.edit-icon'), original);
  assert.equal(await f.cpuFrom(), 'dialog'); assert.equal(f.counts.freshA, 1); assert.equal(f.counts.oldB, 0);
  assert.equal(f.counts.submit + f.counts.http, 0);
});

test('direct provider rejects the old proof after route invalidation and a new bind', async t => {
  const f = await fixture(t, { direct: true }), oldRequest = f.directRequest(); f.aba(); f.provider.bindSource(f.title());
  const result = await f.provider.open(oldRequest);
  assert.ok(['unsupported', 'cancelled'].includes(result.status)); assert.equal(f.counts.oldB + f.counts.freshA, 0); assert.equal(f.doc.querySelector('.ant-modal'), null);
});

test('direct provider cannot obtain fresh permission to click an old B editor merely by rebinding the same retained A title', async t => {
  const f = await fixture(t, { direct: true }); f.directRequest(); f.aba();
  const result = await f.provider.open(f.directRequest());
  assert.ok(['unsupported', 'cancelled'].includes(result.status)); assert.equal(f.counts.oldB + f.counts.freshA, 0);
  assert.equal(f.doc.querySelector('.ant-modal'), null);
});

test('direct provider accepts genuinely new A pane/title/editor nodes after invalidating old route proofs', async t => {
  const f = await fixture(t, { direct: true }); f.directRequest(); f.aba(); f.replace();
  assert.equal((await f.provider.open(f.directRequest())).status, 'opened');
  assert.equal(f.counts.oldB, 0); assert.equal(f.counts.freshA, 1); assert.equal(f.counts.submit + f.counts.http, 0);
});

test('the real factory allows its own expected official navigation when the host creates a genuinely new exact A pane', async t => {
  const f = await fixture(t, { list: true }), previous = f.pane; previous.querySelector('.edit-icon').onclick = f.handler('vm-b');
  f.source.onclick = () => { f.counts.navigation++; f.route('vm-a'); f.replace(); };
  assert.equal(await f.cpuFrom(f.source), 'dialog'); assert.equal(f.counts.navigation, 1); assert.notEqual(f.pane, previous);
  assert.equal(f.counts.oldB, 0); assert.equal(f.counts.freshA, 1); assert.equal(f.counts.submit + f.counts.http, 0);
});

for (const direct of [false, true]) test(`${direct ? 'direct provider' : 'real factory'} quarantines an initially unknown pre-existing same-name pane instead of assuming the URL proves its callback`, async t => {
  const f = await fixture(t, { direct, initialId: null, initialOwner: 'vm-b' });
  if (direct) assert.ok(['unsupported', 'cancelled'].includes((await f.provider.open(f.directRequest())).status)); else await f.cpuFrom();
  assert.equal(f.counts.oldB + f.counts.freshA, 0); assert.equal(f.doc.querySelector('.ant-modal'), null);
});

for (const direct of [false, true]) test(`${direct ? 'direct provider' : 'real factory'} accepts an initial exact-ID A pane without invoking any final submit`, async t => {
  const f = await fixture(t, { direct });
  if (direct) assert.equal((await f.provider.open(f.directRequest())).status, 'opened'); else assert.equal(await f.cpuFrom(), 'dialog');
  assert.equal(f.counts.freshA, 1); assert.equal(f.counts.oldB, 0); assert.equal(f.counts.submit + f.counts.http, 0);
});

for (const moved of [false, true]) test(`an initially quarantined editor cannot be trusted by ${moved ? 'moving it into a fresh exact-ID pane' : 'adding an exact ID to its retained pane'}`, async t => {
  const f = await fixture(t, { initialId: null, initialOwner: 'vm-b' });
  if (moved) f.replace({ editor: f.pane.querySelector('.edit-icon'), explicitId: 'vm-a' }); else f.pane.dataset.resourceId = 'vm-a';
  await f.cpuFrom(); assert.equal(f.counts.oldB + f.counts.freshA, 0); assert.equal(f.doc.querySelector('.ant-modal'), null);
});

test('a new provider on the same document cannot wash away a retired callback even when the pane now has a matching explicit ID', async t => {
  const f = await fixture(t, { direct: true }); f.directRequest(); f.aba(); f.pane.dataset.resourceId = 'vm-a'; f.recreateProvider();
  const result = await f.provider.open(f.directRequest());
  assert.ok(['unsupported', 'cancelled'].includes(result.status)); assert.equal(f.counts.oldB + f.counts.freshA, 0); assert.equal(f.doc.querySelector('.ant-modal'), null);
});

test('stopping and reactivating the same real plugin factory cannot make a retired B callback valid', async t => {
  const f = await fixture(t); f.aba(); f.pane.dataset.resourceId = 'vm-a'; f.reactivate(); await f.cpuFrom();
  assert.equal(f.counts.oldB + f.counts.freshA, 0); assert.equal(f.doc.querySelector('.ant-modal'), null);
});

test('a second real plugin instance on the same document cannot regain a retired B editor after the first instance stops', async t => {
  const f = await fixture(t); f.aba(); f.pane.dataset.resourceId = 'vm-a'; await f.additionalFactory(); f.stopPrimary(); await f.cpuFrom();
  assert.equal(f.counts.oldB + f.counts.freshA, 0); assert.equal(f.doc.querySelector('.ant-modal'), null);
});

test('two live provider instances on one document share retirement instead of independently trusting an old callback', async t => {
  const f = await fixture(t, { direct: true }); f.directRequest(); f.aba(); f.pane.dataset.resourceId = 'vm-a';
  const second = f.additionalProvider(), result = await second.open(f.directRequestFor(second));
  assert.ok(['unsupported', 'cancelled'].includes(result.status)); assert.equal(f.counts.oldB + f.counts.freshA, 0); assert.equal(f.doc.querySelector('.ant-modal'), null);
});

test('fresh A nodes can recover after an initially unknown pane is retired without restoring the unknown callback', async t => {
  const f = await fixture(t, { initialId: null, initialOwner: 'vm-b' }); f.replace();
  assert.equal(await f.cpuFrom(), 'dialog'); assert.equal(f.counts.freshA, 1); assert.equal(f.counts.oldB, 0); assert.equal(f.counts.submit + f.counts.http, 0);
});
