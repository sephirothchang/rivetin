import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installObjectActionMenu } from '../src/actions/menu.js';
import { VM_ACTION_CATALOG } from '../src/actions/catalog.js';
import { resolveHostBoundary } from '../src/host-boundary.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const state = (patch = {}, capabilities = {}) => ({ snapshot: { id: 'vm-a', status: 'RUNNING', ...patch }, capabilities: { ...Object.fromEntries(VM_ACTION_CATALOG.flatMap(group => group.items).map(action => [action.id, { allowed: true }])), ...capabilities } });
function fixture(t, { provider, noProvider = false, drawer = false, separateDrawer = false, locale = 'zh-CN' } = {}) {
  const html = '<table><tr data-row-key="vm-a"><td unique="name" id="source" tabindex="0">VM A</td><td><button id="native-more">More</button><button id="native-power">Power</button></td></tr></table>';
  const dom = new JSDOM((drawer ? `<aside class="drawer-content-inner">${html}</aside>` : html) + (separateDrawer ? '<aside class="drawer-content-inner" id="host-drawer"><div class="frame"><div class="title-wrapper"><span class="header-title">VM B</span></div></div></aside>' : '') + '<div id="outside">Outside</div><div class="ant-dropdown" id="native-popup" style="left:42px">Native popup</div>', { url: 'https://tower.example.invalid/#/vms' });
  const win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getBoundingClientRect = function () { return { left: (drawer || separateDrawer) && this.hasAttribute('data-rivetin-object-menu') ? 100 : 0, top: (drawer || separateDrawer) && this.hasAttribute('data-rivetin-object-menu') ? 50 : 0, width: 310, height: 400, bottom: 450 }; };
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{ width: 310, height: 400 }]; };
  let enabled = true, reads = [], opens = [], native = 0, selected = 0, bubbled = 0, hostClosed = 0, next = 1;
  const errors = [], timers = new Map(), intervals = new Map();
  win.setTimeout = (callback, delay) => { const id = next++; timers.set(id, { callback, delay }); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.setInterval = (callback, delay) => { const id = next++; intervals.set(id, { callback, delay }); return id; };
  win.clearInterval = id => intervals.delete(id);
  doc.querySelector('tr').onclick = () => selected++;
  doc.querySelector('#native-more').onclick = doc.querySelector('#native-power').onclick = () => native++;
  doc.body.onclick = () => bubbled++;
  if (separateDrawer) {
    const pane = doc.querySelector('#host-drawer');
    const outside = event => { if (pane.isConnected && !pane.contains(event.target)) { hostClosed++; pane.remove(); } };
    // The host registers both handlers before this plugin. Stopping propagation
    // later on the menu cannot undo this capture-phase outside dismissal.
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('click', outside);
  }
  const actual = noProvider ? undefined : provider || { read: async () => state(), open: async () => ({ status: 'opened' }) };
  const wrapped = actual && {
    read(resource, options) { reads.push({ resource, options }); return actual.read(resource, options); },
    open(request, options) { opens.push({ request, options }); return actual.open(request, options); },
  };
  const menu = installObjectActionMenu({ win, provider: wrapped, getLocale: () => locale, isEnabled: () => enabled, onError: value => errors.push(value) });
  const resource = { type: 'vm', id: 'vm-a', name: 'VM A', element: doc.querySelector('#source') };
  t.after(() => { menu.stop(); dom.window.close(); });
  return { win, doc, menu, resource, errors, timers, intervals, reads, opens,
    root: () => doc.querySelector('[data-rivetin-object-menu]'),
    group: id => doc.querySelector(`[data-group-id="${id}"]`), action: id => doc.querySelector(`[data-action-id="${id}"]`),
    async show(group) { assert.equal(menu.open(resource, 220, 150), true); await settle(); if (group) doc.querySelector(`[data-group-id="${group}"]`).click(); },
    timeout() { const item = [...timers.values()].find(value => value.delay === 8000); assert.ok(item); item.callback(); },
    disable() { enabled = false; for (const value of [...intervals.values()]) value.callback(); },
    counts: () => ({ native, selected, bubbled }),
    hostClosed: () => hostClosed,
  };
}

test('VM menus expose every catalog group and action without sidebar, navigation or native clicks', async t => {
  const f = fixture(t); const href = f.win.location.href; await f.show();
  assert.equal(f.doc.querySelectorAll('[data-group-id]').length, 7);
  let count = 0;
  for (const group of VM_ACTION_CATALOG) {
    f.group(group.id).click();
    const actions = [...f.doc.querySelectorAll('[data-action-id]')]; count += actions.length;
    assert.deepEqual(actions.map(node => node.dataset.actionId), group.items.map(entry => entry.id));
    assert.equal(f.doc.querySelectorAll('[data-group-id]').length, 7, 'parent directory remains visible alongside submenu');
  }
  assert.equal(count, VM_ACTION_CATALOG.flatMap(group => group.items).length);
  assert.equal(f.win.location.href, href); assert.equal(f.doc.querySelector('.frame,.drawer-content-inner'), null);
  assert.equal(f.root().parentElement, f.doc.body);
  assert.deepEqual(f.counts(), { native: 0, selected: 0, bubbled: 0 }); assert.equal(f.opens.length, 0);
});

test('without an adapter the complete directory remains readable and every action is disabled', async t => {
  const f = fixture(t, { noProvider: true }); await f.show(); assert.match(f.root().textContent, /provider-unavailable/);
  for (const group of VM_ACTION_CATALOG) {
    f.group(group.id).click();
    for (const button of f.doc.querySelectorAll('[data-action-id]')) { assert.equal(button.disabled, true); assert.match(button.textContent, /provider-unavailable/); button.click(); }
    assert.equal(f.doc.querySelector('.rvm-back'), null, 'there is no drill-down return step');
  }
  assert.equal(f.reads.length, 0); assert.equal(f.opens.length, 0);
});

test('an authorized action rereads state and opens only its adapter form with plain identity', async t => {
  const f = fixture(t); await f.show('vm.power'); f.action('vm.power.shutdown').click(); await settle();
  assert.equal(f.reads.length, 2); assert.equal(f.opens.length, 1);
  const { request, options } = f.opens[0]; assert.equal(request.actionId, 'vm.power.shutdown'); assert.equal(request.action.enabled, true);
  assert.deepEqual(request.resource, { type: 'vm', id: 'vm-a', name: 'VM A' }); assert.equal(request.snapshot.id, 'vm-a');
  assert.equal(Object.hasOwn(request.resource, 'element'), false); assert.equal(options.signal.aborted, false);
  assert.equal(f.root(), null); assert.deepEqual(f.counts(), { native: 0, selected: 0, bubbled: 0 });
});

test('snapshot ID mismatch disables actions instead of borrowing another VM state', async t => {
  const f = fixture(t, { provider: { read: async () => state({ id: 'vm-b' }), open: async () => ({ status: 'opened' }) } });
  await f.show('vm.power'); const button = f.action('vm.power.shutdown'); assert.equal(button.disabled, true); assert.match(button.textContent, /ID/); button.click(); assert.equal(f.opens.length, 0);
});

test('permission denial stays visible in the disabled action reason', async t => {
  const f = fixture(t, { provider: { read: async () => state({}, { 'vm.power.shutdown': { allowed: false, reason: 'No shutdown permission' } }), open: async () => ({ status: 'opened' }) } });
  await f.show('vm.power'); const button = f.action('vm.power.shutdown'); assert.equal(button.disabled, true); assert.match(button.textContent, /No shutdown permission/); button.click(); assert.equal(f.opens.length, 0);
});

for (const change of ['identity', 'power state', 'permission']) test(`fresh ${change} changes cancel an action before form opening`, async t => {
  let reads = 0;
  const f = fixture(t, { provider: { read: async () => ++reads === 1 ? state() : change === 'identity' ? state({ id: 'vm-b' }) : change === 'power state' ? state({ status: 'STOPPED' }) : state({}, { 'vm.power.shutdown': { allowed: false } }), open: async () => ({ status: 'opened' }) } });
  await f.show('vm.power'); assert.equal(f.action('vm.power.shutdown').disabled, false); f.action('vm.power.shutdown').click(); await settle();
  assert.equal(reads, 2); assert.equal(f.opens.length, 0); assert.equal(f.action('vm.power.shutdown').disabled, true);
});

for (const cancellation of ['close', 'Escape', 'outside', 'source removal', 'source ID reuse', 'disable', 'stop', 'route']) test(`${cancellation} aborts pending reads and ignores late results`, async t => {
  const pending = deferred(); const f = fixture(t, { provider: { read: () => pending.promise, open: async () => ({ status: 'opened' }) } });
  assert.equal(f.menu.open(f.resource, 220, 150), true); const signal = f.reads[0].options.signal;
  if (cancellation === 'close') f.menu.close();
  if (cancellation === 'Escape') f.root().querySelector('button').dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (cancellation === 'outside') f.doc.querySelector('#outside').dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true }));
  if (cancellation === 'source removal') f.resource.element.remove();
  if (cancellation === 'source ID reuse') f.doc.querySelector('tr').dataset.rowKey = 'vm-b';
  if (cancellation === 'disable') f.disable();
  if (cancellation === 'stop') f.menu.stop();
  if (cancellation === 'route') { f.win.history.replaceState({}, '', '#/hosts/host-a'); f.win.dispatchEvent(new f.win.PopStateEvent('popstate')); }
  await settle(); assert.equal(signal.aborted, true); pending.resolve(state()); await settle();
  assert.equal(f.root(), null); assert.equal(f.opens.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
});

test('the eight second deadline cancels a late preflight without a late action', async t => {
  const pending = deferred(); let reads = 0;
  const f = fixture(t, { provider: { read: () => ++reads === 1 ? state() : pending.promise, open: async () => ({ status: 'opened' }) } });
  await f.show('vm.power'); f.action('vm.power.shutdown').click(); const signal = f.reads[1].options.signal; f.timeout();
  assert.equal(signal.aborted, true); assert.equal(f.root(), null); pending.resolve(state()); await settle();
  assert.equal(f.opens.length, 0); assert.match(f.errors[0], /超时/); assert.equal(f.timers.size, 0);
});

test('stopping while an adapter form is opening signals cancellation and ignores its result', async t => {
  const pending = deferred(); const f = fixture(t, { provider: { read: async () => state(), open: () => pending.promise } });
  await f.show('vm.power'); f.action('vm.power.shutdown').click(); await settle(); assert.equal(f.opens.length, 1);
  const signal = f.opens[0].options.signal; f.menu.stop(); assert.equal(signal.aborted, true); pending.resolve({ status: 'opened' }); await settle(); assert.equal(f.root(), null);
});

test('drawer mounting keeps clicks local and accounts for the translated fixed origin', async t => {
  const f = fixture(t, { drawer: true }); await f.show();
  assert.equal(f.root().parentElement, f.doc.querySelector('.drawer-content-inner'));
  assert.equal(f.root().style.left, '120px'); assert.equal(f.root().style.top, '100px');
  f.group('vm.power').click(); assert.equal(f.counts().bubbled, 0); assert.equal(f.counts().selected, 0);
  assert.equal(f.doc.querySelector('#native-popup').getAttribute('style'), 'left:42px');
});

test('a list VM menu uses the existing different-VM drawer only for event containment', async t => {
  const f = fixture(t, { separateDrawer: true });
  const sidebar = encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-b', view: 'detail' }));
  f.win.history.replaceState({}, '', `#/vms?sidebar=${sidebar}`);
  const href = f.win.location.href, pane = f.doc.querySelector('#host-drawer');
  await f.show();
  const group = f.group('vm.power'); group.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true })); group.click();
  assert.equal(f.hostClosed(), 0); assert.equal(pane.isConnected, true); assert.equal(f.root().parentElement, pane);
  assert.equal(f.root().style.left, '120px'); assert.equal(f.root().style.top, '100px');
  const action = f.action('vm.power.shutdown'); action.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true })); action.click(); await settle();
  assert.equal(f.hostClosed(), 0); assert.equal(pane.isConnected, true); assert.equal(f.win.location.href, href);
  assert.ok(f.reads.every(call => call.resource.type === 'vm' && call.resource.id === 'vm-a'));
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0].request.resource.id, 'vm-a'); assert.equal(f.opens[0].request.snapshot.id, 'vm-a');
  assert.deepEqual(f.counts(), { native: 0, selected: 0, bubbled: 0 });
});

test('ambiguous existing drawers fail closed for a list source', t => {
  const f = fixture(t, { separateDrawer: true }); const second = f.doc.createElement('aside'); second.className = 'drawer-content-inner'; f.doc.body.append(second);
  assert.equal(f.menu.open(f.resource, 220, 150), false); assert.equal(f.root(), null); assert.equal(f.reads.length, 0);
});

test('the source own drawer takes precedence over other visible drawers', async t => {
  const f = fixture(t, { drawer: true, separateDrawer: true }); await f.show();
  assert.equal(f.root().parentElement, f.resource.element.closest('.drawer-content-inner')); assert.notEqual(f.root().parentElement.id, 'host-drawer');
  assert.ok(f.reads.every(call => call.resource.id === 'vm-a'));
});

test('a hidden drawer does not make the only open containment drawer ambiguous', async t => {
  const f = fixture(t, { separateDrawer: true }); const hidden = f.doc.createElement('aside'); hidden.className = 'drawer-content-inner'; hidden.hidden = true; f.doc.body.append(hidden);
  await f.show(); assert.equal(f.root().parentElement.id, 'host-drawer');
});

for (const hidden of ['hidden', 'aria-hidden', 'display', 'visibility', 'collapse', 'ancestor display', 'ancestor aria-hidden']) test(`host boundaries exclude ${hidden} panes without relying on geometry`, t => {
  const f = fixture(t, { separateDrawer: true }), pane = f.doc.querySelector('#host-drawer');
  f.win.HTMLElement.prototype.getClientRects = () => [];
  assert.equal(resolveHostBoundary(f.win, f.resource.element), pane);
  if (hidden === 'hidden') pane.hidden = true;
  if (hidden === 'aria-hidden') pane.setAttribute('aria-hidden', 'true');
  if (hidden === 'display') pane.style.display = 'none';
  if (hidden === 'visibility') pane.style.visibility = 'hidden';
  if (hidden === 'collapse') pane.style.visibility = 'collapse';
  if (hidden.startsWith('ancestor')) {
    const wrapper = f.doc.createElement('div'); pane.before(wrapper); wrapper.append(pane);
    if (hidden === 'ancestor display') wrapper.style.display = 'none'; else wrapper.setAttribute('aria-hidden', 'true');
  }
  assert.equal(resolveHostBoundary(f.win, f.resource.element), f.doc.body);
});

test('a source own hidden drawer is rejected rather than borrowing another open pane', t => {
  const f = fixture(t, { drawer: true, separateDrawer: true });
  f.resource.element.closest('.drawer-content-inner').hidden = true;
  assert.equal(resolveHostBoundary(f.win, f.resource.element), null); assert.equal(f.menu.open(f.resource, 220, 150), false); assert.equal(f.reads.length, 0);
});

test('removing a borrowed event container cancels pending work without changing source identity', async t => {
  const pending = deferred(); let reads = 0;
  const f = fixture(t, { separateDrawer: true, provider: { read: () => ++reads === 1 ? state() : pending.promise, open: async () => ({ status: 'opened' }) } });
  await f.show('vm.power'); f.action('vm.power.shutdown').click(); const signal = f.reads[1].options.signal;
  f.doc.querySelector('#host-drawer').remove(); await settle(); assert.equal(f.resource.element.isConnected, true); assert.equal(signal.aborted, true);
  pending.resolve(state()); await settle(); assert.equal(f.opens.length, 0); assert.equal(f.root(), null); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
});

test('hiding a borrowed event container cancels pending work while the source stays connected', async t => {
  const pending = deferred(); let reads = 0;
  const f = fixture(t, { separateDrawer: true, provider: { read: () => ++reads === 1 ? state() : pending.promise, open: async () => ({ status: 'opened' }) } });
  await f.show('vm.power'); f.action('vm.power.shutdown').click(); const signal = f.reads[1].options.signal;
  f.doc.querySelector('#host-drawer').setAttribute('aria-hidden', 'true'); await settle();
  assert.equal(f.resource.element.isConnected, true); assert.equal(signal.aborted, true); pending.resolve(state()); await settle();
  assert.equal(f.opens.length, 0); assert.equal(f.root(), null);
});

test('keyboard navigation stays inside the menu and enters or leaves a cascading submenu', async t => {
  const f = fixture(t, { locale: 'en-US' }); await f.show(); const first = f.group('vm.power'); first.focus();
  const key = value => f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  key('ArrowDown'); assert.equal(f.doc.activeElement.dataset.groupId, 'vm.console'); key('Enter'); assert.ok(f.action('vm.console.open'));
  key('ArrowLeft'); assert.equal(f.doc.querySelectorAll('[data-group-id]').length, 7); key('End'); assert.equal(f.doc.activeElement.dataset.groupId, 'vm.recycle');
  key('Escape'); assert.equal(f.root(), null);
});

test('unsupported form results never claim an action completed', async t => {
  const f = fixture(t, { provider: { read: async () => state(), open: async () => ({ status: 'unsupported' }) } });
  await f.show('vm.power'); f.action('vm.power.shutdown').click(); await settle(); assert.ok(f.root()); assert.match(f.root().textContent, /unexpected/);
});

test('read errors retain a disabled directory and expose only a generic error', async t => {
  const f = fixture(t, { provider: { read: async () => { throw new Error('private adapter diagnostic'); }, open: async () => ({ status: 'opened' }) } });
  await f.show('vm.power'); assert.equal(f.action('vm.power.shutdown').disabled, true); assert.match(f.errors[0], /无法确认/);
  assert.doesNotMatch(f.root().textContent, /private adapter diagnostic/); assert.equal(f.opens.length, 0);
});

test('a late read cannot open a form even before an overdue timer callback runs', async t => {
  const pending = deferred(); let reads = 0, now = 0;
  const f = fixture(t, { provider: { read: () => ++reads === 1 ? state() : pending.promise, open: async () => ({ status: 'opened' }) } });
  Object.defineProperty(f.win.performance, 'now', { value: () => now });
  await f.show('vm.power'); f.action('vm.power.shutdown').click(); now = 8001; pending.resolve(state()); await settle();
  assert.equal(f.opens.length, 0); assert.equal(f.root(), null); assert.equal(f.reads[1].options.signal.aborted, true); assert.match(f.errors[0], /超时/);
});

test('stale menu button references do not read, execute or close a newer session', async t => {
  const f = fixture(t); await f.show('vm.power'); const old = f.action('vm.power.shutdown'); f.menu.close(); await f.show();
  const root = f.root(), reads = f.reads.length; old.click(); await settle();
  assert.equal(f.root(), root); assert.equal(f.reads.length, reads); assert.equal(f.opens.length, 0);
});

test('a new menu supersedes pending reads without accepting the old result', async t => {
  const old = deferred(); let reads = 0;
  const f = fixture(t, { provider: { read: () => ++reads === 1 ? old.promise : state(), open: async () => ({ status: 'opened' }) } });
  f.menu.open(f.resource, 10, 10); const signal = f.reads[0].options.signal; await f.show('vm.power');
  assert.equal(signal.aborted, true); old.resolve(state({ id: 'vm-b' })); await settle(); assert.equal(f.action('vm.power.shutdown').disabled, false);
});

for (const href of ['#/vms/vm-b', '#/hosts/vm-a', 'https://outside.example.invalid/#/vms/vm-a']) test(`reused anchor source ${href} cancels before a saved action handler can run`, async t => {
  const f = fixture(t), anchor = f.doc.createElement('a'); anchor.href = '#/vms/vm-a'; anchor.textContent = 'VM A'; f.doc.body.append(anchor); f.resource.element = anchor;
  await f.show('vm.power'); const oldAction = f.action('vm.power.shutdown'), reads = f.reads.length;
  anchor.href = href; anchor.textContent = 'Reused object';
  // Run before MutationObserver delivery to exercise synchronous identity checks.
  oldAction.click(); await settle();
  assert.equal(f.root(), null); assert.equal(f.reads.length, reads); assert.equal(f.opens.length, 0);
});

test('anchor href observation aborts a pending read even without an interaction', async t => {
  const pending = deferred(), f = fixture(t, { provider: { read: () => pending.promise, open: async () => ({ status: 'opened' }) } });
  const anchor = f.doc.createElement('a'); anchor.href = '#/vms/vm-a'; anchor.textContent = 'VM A'; f.doc.body.append(anchor); f.resource.element = anchor;
  f.menu.open(f.resource, 220, 150); const signal = f.reads[0].options.signal; anchor.href = '#/vms/vm-b'; await settle();
  assert.equal(signal.aborted, true); assert.equal(f.root(), null); pending.resolve(state()); await settle(); assert.equal(f.opens.length, 0);
});

test('a connected source with no verifiable resource identity is rejected', t => {
  const f = fixture(t); assert.equal(f.menu.open({ ...f.resource, element: f.doc.querySelector('#outside') }, 10, 10), false);
  assert.equal(f.root(), null); assert.equal(f.reads.length, 0);
});

test('stop removes only owned menus, style, listeners and scheduled work', async t => {
  const pending = deferred(); const f = fixture(t, { provider: { read: () => pending.promise, open: async () => ({ status: 'opened' }) } });
  const nativeBefore = f.doc.querySelector('#native-popup').outerHTML; f.menu.open(f.resource, 220, 150); assert.equal(f.doc.querySelectorAll('style').length, 1);
  f.menu.stop(); f.menu.stop(); assert.equal(f.root(), null); assert.equal(f.doc.querySelector('style'), null); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.doc.querySelector('#native-popup').outerHTML, nativeBefore); assert.equal(f.menu.open(f.resource, 220, 150), false);
  pending.resolve(state()); await settle(); assert.equal(f.root(), null);
});

test('non VM, internal, malformed and detached sources are not handled', t => {
  const f = fixture(t);
  for (const resource of [{ ...f.resource, type: 'host' }, { ...f.resource, internal: 'vmDisk' }, { ...f.resource, id: '../bad' }, { ...f.resource, element: f.doc.createElement('div') }]) assert.equal(f.menu.open(resource, 0, 0), false);
  assert.equal(f.root(), null); assert.equal(f.reads.length, 0);
});
