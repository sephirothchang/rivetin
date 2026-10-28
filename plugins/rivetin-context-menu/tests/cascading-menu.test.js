import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as menuModule from '../src/actions/menu.js';
import { VM_ACTION_CATALOG } from '../src/actions/catalog.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const state = (patch = {}, capabilities = {}) => ({ snapshot: { id: 'vm-a', status: 'RUNNING', ...patch },
  capabilities: { ...Object.fromEntries(VM_ACTION_CATALOG.flatMap(group => group.items).map(action => [action.id, { allowed: true }])), ...capabilities } });
function fixture(t, { read = async () => state(), noProvider = false, locale = 'zh-CN', drawer = false, viewport = [1280, 800] } = {}) {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td id="source" unique="name">VM A</td><td><button id="native">Native action</button></td></tr></table>' + (drawer ? '<aside class="drawer-content-inner"><div class="frame"><div class="title-wrapper"><span class="header-title">VM B</span></div></div></aside>' : '') + '<div id="outside">Outside</div>', { url: 'https://tower.example.invalid/#/vms' });
  const win = dom.window, doc = win.document;
  Object.defineProperty(win, 'innerWidth', { value: viewport[0], configurable: true }); Object.defineProperty(win, 'innerHeight', { value: viewport[1], configurable: true });
  const offset = drawer ? { x: 100, y: 40 } : { x: 0, y: 0 };
  const rect = (left, top, width, height) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() { return {}; } });
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('[data-rivetin-submenu]')) return rect(offset.x + (parseFloat(this.style.left) || 0), offset.y + (parseFloat(this.style.top) || 0), Math.min(310, win.innerWidth - 16), Math.min(560, win.innerHeight - 16));
    if (this.matches('[data-rivetin-object-menu]')) return rect(offset.x + (parseFloat(this.style.left) || 0), offset.y + (parseFloat(this.style.top) || 0), Math.min(310, win.innerWidth - 16), 430);
    if (this.matches('[data-group-id]')) {
      const root = this.closest('[data-rivetin-object-menu]').getBoundingClientRect();
      const index = [...doc.querySelectorAll('[data-group-id]')].indexOf(this);
      return rect(root.left + 6, root.top + 115 + index * 32, root.width - 12, 32);
    }
    return rect(0, 0, 100, 30);
  };
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [this.getBoundingClientRect()]; };
  let next = 0, native = 0, selected = 0; const timers = new Map(), intervals = new Map(), reads = [], opened = [], copies = [];
  win.setTimeout = (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; }; win.clearTimeout = id => timers.delete(id);
  win.setInterval = fn => { const id = ++next; intervals.set(id, fn); return id; }; win.clearInterval = id => intervals.delete(id);
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async value => { copies.push(value); } } });
  doc.querySelector('#native').onclick = () => native++; doc.querySelector('tr').onclick = () => selected++;
  const provider = noProvider ? undefined : {
    read(resource, options) { reads.push({ resource, options }); return read(resource, options); },
    async open(request, options) { opened.push({ request, options }); return { status: 'opened' }; },
  };
  const menu = menuModule.installObjectActionMenu({ win, provider, getLocale: () => locale });
  const source = doc.querySelector('#source'), resource = { type: 'vm', id: 'vm-a', name: 'VM A', element: source };
  t.after(() => { menu.stop(); win.close(); });
  const root = () => doc.querySelector('[data-rivetin-object-menu]'), submenu = () => root()?.querySelector('[data-rivetin-submenu]');
  const group = id => root()?.querySelector(`[data-group-id="${id}"]`);
  const hover = (id, event = 'pointerenter') => group(id).dispatchEvent(new win.Event(event));
  function key(name) { const event = new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }); doc.activeElement.dispatchEvent(event); return event; }
  return { win, doc, menu, source, resource, reads, opened, copies, timers, intervals, root, submenu, group, hover, key,
    counts: () => ({ native, selected }),
    async show(x = 300, y = 100) { assert.equal(menu.open(resource, x, y), true); await settle(); },
  };
}

for (const event of ['pointerenter', 'mouseenter']) test(`${event} opens an accessible side menu while preserving all main groups, shortcuts and footer`, async t => {
  const f = fixture(t); await f.show(); const root = f.root(); f.hover('vm.hardware', event);
  const sub = f.submenu(), parent = f.group('vm.hardware'); assert.ok(sub); assert.equal(sub.getAttribute('role'), 'menu');
  assert.equal(sub.getAttribute('aria-label'), '基本信息与硬件'); assert.equal(sub.id, parent.getAttribute('aria-controls')); assert.ok(sub.id);
  assert.equal(parent.getAttribute('aria-expanded'), 'true'); assert.equal(f.root(), root);
  assert.equal(root.querySelectorAll('[data-group-id]').length, 7); assert.equal(root.querySelectorAll('[data-shortcut-id]').length, 5); assert.ok(root.querySelector('[data-copy-vm-id]'));
  assert.equal(root.querySelector('.rvm-back'), null); assert.doesNotMatch(root.textContent, /返回全部操作|All actions/);
  assert.equal(f.reads.length, 1); assert.equal(f.opened.length, 0); assert.deepEqual(f.counts(), { native: 0, selected: 0 });
});

test('clicking a group opens its submenu instead of replacing the main directory or executing', async t => {
  const f = fixture(t); await f.show(); f.group('vm.power').click();
  assert.ok(f.submenu()?.querySelector('[data-action-id="vm.power.shutdown"]')); assert.equal(f.root().querySelectorAll('[data-group-id]').length, 7);
  assert.equal(f.opened.length, 0); assert.equal(f.reads.length, 1);
});

test('crossing from a parent into its submenu keeps the cascade open with no deferred gap', async t => {
  const f = fixture(t); await f.show(); f.hover('vm.power'); const sub = f.submenu(), parent = f.group('vm.power');
  parent.dispatchEvent(new f.win.MouseEvent('pointerleave', { relatedTarget: sub })); parent.dispatchEvent(new f.win.MouseEvent('mouseleave', { relatedTarget: sub }));
  sub.dispatchEvent(new f.win.MouseEvent('pointerenter', { relatedTarget: parent })); sub.dispatchEvent(new f.win.MouseEvent('mouseenter', { relatedTarget: parent }));
  await settle(); assert.equal(f.submenu(), sub); assert.equal(f.group('vm.power').getAttribute('aria-expanded'), 'true'); assert.equal(f.timers.size, 0);
});

test('hovering another group replaces only the child layer and updates expanded state', async t => {
  const f = fixture(t); await f.show(); f.hover('vm.power'); const old = f.submenu(); f.hover('vm.console');
  assert.equal(old.isConnected, false); assert.equal(f.root().querySelectorAll('[data-rivetin-submenu]').length, 1);
  assert.equal(f.submenu().getAttribute('aria-label'), '控制台与客户机'); assert.equal(f.group('vm.power').getAttribute('aria-expanded'), 'false'); assert.equal(f.group('vm.console').getAttribute('aria-expanded'), 'true');
  assert.equal(f.opened.length, 0); assert.equal(f.reads.length, 1);
});

for (const backKey of ['ArrowLeft', 'Escape']) test(`${backKey} in a child layer returns focus to its parent; next Escape closes the root`, async t => {
  const f = fixture(t); await f.show(); f.group('vm.power').focus(); f.key('ArrowRight');
  const sub = f.submenu(); assert.ok(sub); assert.equal(f.doc.activeElement, sub.querySelector('button:not(:disabled)'));
  assert.equal(f.doc.activeElement.dataset.actionId, 'vm.power.shutdown', 'skip the stopped-only start action');
  f.key(backKey); assert.equal(f.submenu(), null); assert.ok(f.root()); assert.equal(f.doc.activeElement, f.group('vm.power')); assert.equal(f.group('vm.power').getAttribute('aria-expanded'), 'false');
  f.key('Escape'); assert.equal(f.root(), null); assert.equal(f.doc.querySelector('[data-rivetin-submenu]'), null); assert.equal(f.opened.length, 0);
});

test('up/down and Home/End stay in the current layer while the parent directory remains available', async t => {
  const f = fixture(t); await f.show(); f.group('vm.power').focus(); f.key('ArrowDown'); assert.equal(f.doc.activeElement, f.group('vm.console'));
  f.key('ArrowRight'); assert.ok(f.submenu().contains(f.doc.activeElement)); const sub = f.submenu();
  f.key('End'); assert.equal(f.doc.activeElement, [...sub.querySelectorAll('button:not(:disabled)')].at(-1));
  f.key('ArrowDown'); assert.equal(f.doc.activeElement, sub.querySelector('button:not(:disabled)'));
  f.key('ArrowUp'); assert.equal(f.doc.activeElement, [...sub.querySelectorAll('button:not(:disabled)')].at(-1));
  f.key('Home'); assert.equal(f.doc.activeElement, sub.querySelector('button:not(:disabled)'));
  f.key('ArrowLeft'); f.key('End'); assert.equal(f.doc.activeElement, f.group('vm.recycle'));
});

test('a child leaf repeats the authoritative read and opens only the source VM action', async t => {
  const f = fixture(t, { drawer: true }); await f.show(); const href = f.win.location.href; f.hover('vm.power');
  const leaf = f.submenu().querySelector('[data-action-id="vm.power.shutdown"]'); leaf.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true })); assert.ok(f.root());
  leaf.click(); await settle(); assert.equal(f.reads.length, 2); assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].request.actionId, 'vm.power.shutdown'); assert.deepEqual(f.opened[0].request.resource, { type: 'vm', id: 'vm-a', name: 'VM A' });
  assert.equal(f.opened[0].request.snapshot.id, 'vm-a'); assert.equal(f.win.location.href, href); assert.deepEqual(f.counts(), { native: 0, selected: 0 });
  assert.equal(f.root(), null); assert.equal(f.doc.querySelector('[data-rivetin-submenu]'), null);
});

test('revoked permissions on fresh read cancel a formerly enabled leaf without replacing the parent menu', async t => {
  let reads = 0; const f = fixture(t, { read: async () => ++reads === 1 ? state() : state({}, { 'vm.power.shutdown': { allowed: false, reason: 'Shutdown permission revoked' } }) });
  await f.show(); f.hover('vm.power'); f.submenu().querySelector('[data-action-id="vm.power.shutdown"]').click(); await settle();
  assert.equal(reads, 2); assert.equal(f.opened.length, 0); assert.equal(f.root().querySelectorAll('[data-group-id]').length, 7);
  const leaf = f.submenu()?.querySelector('[data-action-id="vm.power.shutdown"]'); assert.ok(leaf); assert.equal(leaf.disabled, true); assert.match(leaf.textContent, /permission revoked/);
});

test('without an adapter groups remain inspectable and copy ID works while all submenu leaves stay disabled', async t => {
  const f = fixture(t, { noProvider: true }); await f.show(); f.hover('vm.hardware');
  assert.ok(f.submenu()); assert.ok([...f.submenu().querySelectorAll('[data-action-id]')].every(node => node.disabled));
  f.root().querySelector('[data-copy-vm-id]').click(); await settle(); assert.deepEqual(f.copies, ['vm-a']); assert.equal(f.opened.length, 0);
});

test('recycled source identity rejects a saved child click immediately', async t => {
  const f = fixture(t); await f.show(); f.hover('vm.power'); const leaf = f.submenu().querySelector('[data-action-id="vm.power.shutdown"]');
  f.source.closest('tr').dataset.rowKey = 'vm-b'; leaf.click(); await settle();
  assert.equal(f.reads.length, 1); assert.equal(f.opened.length, 0); assert.equal(f.root(), null); assert.equal(f.doc.querySelector('[data-rivetin-submenu]'), null);
});

test('stop during child preflight aborts work and leaves no floating submenu or late action', async t => {
  const pending = deferred(); let reads = 0; const f = fixture(t, { read: () => ++reads === 1 ? state() : pending.promise });
  await f.show(); f.hover('vm.power'); f.submenu().querySelector('[data-action-id="vm.power.shutdown"]').click(); await settle();
  const signal = f.reads[1].options.signal; f.menu.stop(); assert.equal(signal.aborted, true); pending.resolve(state()); await settle();
  assert.equal(f.root(), null); assert.equal(f.doc.querySelector('[data-rivetin-submenu]'), null); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0); assert.equal(f.opened.length, 0);
});

test('submenu has a fixed independently scrollable surface and English accessible group label', async t => {
  const f = fixture(t, { locale: 'en-US', viewport: [1200, 420] }); await f.show(); f.hover('vm.hardware');
  const sub = f.submenu(), computed = f.win.getComputedStyle(sub);
  assert.equal(sub.getAttribute('aria-label'), 'General and hardware'); assert.equal(computed.position, 'fixed');
  assert.ok(['auto', 'scroll'].includes(computed.overflowY || computed.overflow), 'the child surface must own its scrolling');
  assert.ok(computed.maxHeight && computed.maxHeight !== 'none', 'child height must be bounded independently');
  assert.equal(f.root().querySelectorAll('[data-group-id]').length, 7);
});

test('submenu positioning accounts for a translated host container without an extra pointer gap', async t => {
  const f = fixture(t, { drawer: true }); await f.show(300, 70); f.hover('vm.power');
  const sub = f.submenu(), anchor = f.group('vm.power').getBoundingClientRect(), actual = sub.getBoundingClientRect();
  assert.equal(actual.left, anchor.right); assert.equal(actual.top, anchor.top); assert.equal(sub.parentElement.closest('[data-rivetin-object-menu]'), f.root());
});

test('pure submenu positioning prefers the right with zero gap and clamps vertically', () => {
  assert.equal(typeof menuModule.calculateSubmenuPosition, 'function');
  assert.deepEqual(menuModule.calculateSubmenuPosition({ anchor: { left: 80, right: 390, top: 90 }, width: 310, height: 280, viewportWidth: 1280, viewportHeight: 800 }), { left: 390, top: 90, side: 'right' });
  const low = menuModule.calculateSubmenuPosition({ anchor: { left: 80, right: 390, top: 740 }, width: 310, height: 280, viewportWidth: 1280, viewportHeight: 800 });
  assert.equal(low.left, 390); assert.equal(low.top, 512);
});

test('pure submenu positioning flips left when the right side is too small', () => {
  assert.equal(typeof menuModule.calculateSubmenuPosition, 'function');
  assert.deepEqual(menuModule.calculateSubmenuPosition({ anchor: { left: 790, right: 1100, top: 650 }, width: 310, height: 280, viewportWidth: 1200, viewportHeight: 800 }), { left: 480, top: 512, side: 'left' });
});

test('pure submenu positioning stays at the viewport margins when neither side fully fits', () => {
  assert.equal(typeof menuModule.calculateSubmenuPosition, 'function');
  const point = menuModule.calculateSubmenuPosition({ anchor: { left: 20, right: 330, top: -40 }, width: 310, height: 700, viewportWidth: 500, viewportHeight: 420 });
  assert.ok(Number.isFinite(point.left)); assert.ok(point.left >= 8 && point.left <= 182); assert.equal(point.top, 8);
});

// These mocks test API lifecycle only. Browser top-layer painting and clipping
// require the separate real rendering acceptance; jsdom does not implement it.
function mockPopover(f, { throwShow = false, throwHide = false, cancelShow = false, removeOnShow = false, missing } = {}) {
  const calls = { show: [], hide: [], hostDialog: 0 }, opened = new WeakSet();
  const prototype = f.win.HTMLElement.prototype, originalRects = prototype.getClientRects, originalMatches = prototype.matches;
  prototype.matches = function (selector) { return selector === ':popover-open' ? opened.has(this) : originalMatches.call(this, selector); };
  Object.defineProperty(prototype, 'showPopover', { configurable: true, value: missing === 'show' ? undefined : function () {
    calls.show.push(this); assert.equal(this.getAttribute('popover'), 'manual'); assert.ok(this.parentElement, 'append before showing');
    if (throwShow) throw new Error('MOCK_POPOVER_UNAVAILABLE');
    if (cancelShow) return;
    opened.add(this); if (removeOnShow) this.remove();
  } });
  Object.defineProperty(prototype, 'hidePopover', { configurable: true, value: missing === 'hide' ? undefined : function () {
    calls.hide.push(this); if (throwHide) throw new Error('MOCK_POPOVER_DISMISS_FAILED'); opened.delete(this);
  } });
  // Approximate only the UA's closed-popover visibility rule so leaving an
  // attribute after a failed show cannot accidentally pass a visibility check.
  prototype.getClientRects = function () { return this.hasAttribute('popover') && !opened.has(this) ? [] : originalRects.call(this); };
  const host = f.doc.createElement('dialog'); host.id = 'host-owned-dialog';
  host.showModal = host.close = () => calls.hostDialog++; f.doc.body.append(host);
  return { calls, host, isOpen: node => opened.has(node), dispatchClosed(node) {
    opened.delete(node); const event = new f.win.Event('toggle'); Object.defineProperty(event, 'newState', { value: 'closed' }); node.dispatchEvent(event);
  } };
}

test('manual popover shows only the owned root and stop hides it without reparenting or touching native dialogs', async t => {
  const f = fixture(t, { drawer: true }), mock = mockPopover(f); const pane = f.doc.querySelector('.drawer-content-inner');
  await f.show(); const root = f.root(); assert.equal(root.parentElement, pane); assert.equal(root.getAttribute('popover'), 'manual');
  assert.deepEqual(mock.calls.show, [root]); assert.equal(mock.isOpen(root), true); assert.ok(root.getClientRects().length > 0);
  f.hover('vm.hardware'); const sub = f.submenu(); assert.ok(root.contains(sub)); assert.equal(root.parentElement, pane);
  assert.equal(f.doc.querySelectorAll('[data-rivetin-object-menu]').length, 1); assert.equal(mock.calls.hostDialog, 0);
  f.menu.stop(); f.menu.stop();
  assert.deepEqual(mock.calls.hide, [root]); assert.equal(mock.isOpen(root), false); assert.equal(root.isConnected, false); assert.equal(sub.isConnected, false);
  assert.equal(mock.host.isConnected, true); assert.equal(pane.isConnected, true); assert.equal(mock.calls.hostDialog, 0);
  assert.equal(f.doc.querySelector('[data-rivetin-object-menu],[data-rivetin-submenu],[popover]'), null); assert.equal(f.doc.querySelectorAll('style').length, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
});

test('opening a new menu hides the former owned popover exactly once and close is idempotent', async t => {
  const f = fixture(t), mock = mockPopover(f); await f.show(); const old = f.root(); await f.show(); const current = f.root();
  assert.notEqual(current, old); assert.deepEqual(mock.calls.show, [old, current]); assert.deepEqual(mock.calls.hide, [old]);
  assert.equal(old.isConnected, false); assert.equal(current.parentElement, f.doc.body); assert.equal(mock.isOpen(current), true);
  f.menu.close(); f.menu.close(); assert.deepEqual(mock.calls.hide, [old, current]); assert.equal(f.root(), null); assert.equal(mock.calls.hostDialog, 0);
});

test('showPopover failure removes its attribute and leaves a visible ordinary menu that can still execute a verified leaf', async t => {
  const f = fixture(t, { drawer: true }), mock = mockPopover(f, { throwShow: true }); await f.show(); const root = f.root();
  assert.deepEqual(mock.calls.show, [root]); assert.equal(root.hasAttribute('popover'), false); assert.equal(root.hidden, false);
  assert.ok(root.getClientRects().length > 0, 'failed show must not retain a closed-popover attribute'); assert.notEqual(f.win.getComputedStyle(root).display, 'none');
  assert.equal(root.parentElement, f.doc.querySelector('.drawer-content-inner')); f.hover('vm.power'); assert.ok(f.submenu());
  f.submenu().querySelector('[data-action-id="vm.power.shutdown"]').click(); await settle();
  assert.equal(f.reads.length, 2); assert.equal(f.opened.length, 1); assert.equal(f.opened[0].request.resource.id, 'vm-a');
  assert.equal(f.root(), null); assert.deepEqual(mock.calls.hide, []); assert.equal(mock.calls.hostDialog, 0); assert.equal(mock.host.isConnected, true);
  assert.equal(f.doc.querySelector('[popover],[data-rivetin-submenu]'), null);
});

test('hidePopover failure cannot prevent owned DOM, timers and style cleanup or affect native dialogs', async t => {
  const f = fixture(t), mock = mockPopover(f, { throwHide: true }); await f.show(); const root = f.root(); f.hover('vm.hardware');
  assert.doesNotThrow(() => f.menu.stop()); assert.deepEqual(mock.calls.hide, [root]);
  assert.equal(root.isConnected, false); assert.equal(f.doc.querySelector('[popover],[data-rivetin-object-menu],[data-rivetin-submenu]'), null);
  assert.equal(f.doc.querySelectorAll('style').length, 0); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(mock.host.isConnected, true); assert.equal(mock.calls.hostDialog, 0);
});

for (const missing of ['show', 'hide']) test(`a partial popover API missing ${missing} uses the ordinary visible fallback without setting the attribute`, async t => {
  const f = fixture(t), mock = mockPopover(f, { missing }); await f.show(); const root = f.root();
  assert.equal(root.hasAttribute('popover'), false); assert.ok(root.getClientRects().length > 0); assert.equal(root.parentElement, f.doc.body);
  f.hover('vm.hardware'); assert.ok(f.submenu()); assert.equal(f.root().querySelectorAll('[data-group-id]').length, 7);
  f.menu.stop(); assert.deepEqual(mock.calls.show, []); assert.deepEqual(mock.calls.hide, []); assert.equal(mock.calls.hostDialog, 0); assert.equal(mock.host.isConnected, true);
});

test('a cancelled popover show falls back visibly even when the API does not throw', async t => {
  const f = fixture(t), mock = mockPopover(f, { cancelShow: true }); await f.show(); const root = f.root();
  assert.deepEqual(mock.calls.show, [root]); assert.equal(mock.isOpen(root), false); assert.equal(root.hasAttribute('popover'), false); assert.ok(root.getClientRects().length > 0);
  mock.dispatchClosed(root); assert.equal(f.root(), root, 'a closed event from the cancelled popover must not remove the ordinary fallback');
  f.hover('vm.hardware'); assert.ok(f.submenu()); f.menu.stop(); assert.deepEqual(mock.calls.hide, []); assert.equal(f.root(), null); assert.equal(mock.calls.hostDialog, 0);
});

test('a show hook removing the source menu fails closed before installing work or observers', async t => {
  const f = fixture(t), mock = mockPopover(f, { removeOnShow: true });
  assert.equal(f.menu.open(f.resource, 300, 100), false); await settle(); const root = mock.calls.show[0]; assert.ok(root);
  assert.equal(root.isConnected, false); assert.deepEqual(mock.calls.hide, [root]); assert.equal(f.root(), null); assert.equal(f.reads.length, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0); assert.equal(mock.host.isConnected, true); assert.equal(mock.calls.hostDialog, 0);
  f.menu.stop(); assert.equal(f.doc.querySelectorAll('style').length, 0);
});

test('an external closed toggle cancels pending reads and removes all owned surfaces without reopening', async t => {
  const pending = deferred(); const f = fixture(t, { read: () => pending.promise }), mock = mockPopover(f); await f.show(); const root = f.root();
  const signal = f.reads[0].options.signal; f.hover('vm.hardware'); assert.ok(f.submenu()); mock.dispatchClosed(root);
  assert.equal(signal.aborted, true); assert.equal(f.root(), null); assert.equal(f.doc.querySelector('[data-rivetin-submenu],[popover]'), null);
  pending.resolve(state()); await settle(); assert.equal(f.root(), null); assert.deepEqual(mock.calls.show, [root]); assert.deepEqual(mock.calls.hide, [root]);
  assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0); assert.equal(mock.calls.hostDialog, 0); assert.equal(mock.host.isConnected, true);
});

test('a late closed toggle from the former popover cannot close or hide a newer session', async t => {
  const f = fixture(t), mock = mockPopover(f); await f.show(); const old = f.root(); await f.show(); const current = f.root(); f.hover('vm.power');
  mock.dispatchClosed(old); await settle(); assert.equal(f.root(), current); assert.equal(mock.isOpen(current), true); assert.ok(f.submenu());
  assert.deepEqual(mock.calls.show, [old, current]); assert.deepEqual(mock.calls.hide, [old]); assert.equal(f.reads.length, 2); assert.equal(f.opened.length, 0); assert.equal(mock.calls.hostDialog, 0);
});
