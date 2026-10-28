import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installObjectActionMenu } from '../src/actions/menu.js';
import { VM_ACTION_CATALOG } from '../src/actions/catalog.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = (status = 'RUNNING', overrides = {}) => ({
  snapshot: { id: 'vm-a', status },
  capabilities: { ...Object.fromEntries(VM_ACTION_CATALOG.flatMap(group => group.items).map(action => [action.id, { allowed: true }])), ...overrides },
});
function fixture(t, { read = async () => state(), noProvider = false, clipboard, locale = 'zh-CN', drawer = false } = {}) {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td id="source" unique="name">VM A</td><td><button id="native">Native power</button></td></tr></table>' + (drawer ? '<aside class="drawer-content-inner"><div class="header-title">VM B</div></aside>' : ''), { url: 'https://tower.example.invalid/#/vms' });
  const win = dom.window, doc = win.document, source = doc.querySelector('#source'), opened = [], errors = [], copies = [];
  let native = 0, selected = 0, next = 0; const timers = new Map(), intervals = new Map();
  win.setTimeout = (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; }; win.clearTimeout = id => timers.delete(id);
  win.setInterval = fn => { const id = ++next; intervals.set(id, fn); return id; }; win.clearInterval = id => intervals.delete(id);
  doc.querySelector('#native').onclick = () => native++; source.closest('tr').onclick = () => selected++;
  Object.defineProperty(win.navigator, 'clipboard', { value: clipboard === null ? undefined : { writeText: value => { copies.push(value); return clipboard ? clipboard(value) : Promise.resolve(); } } });
  const provider = noProvider ? undefined : { read, open: async request => { opened.push(request); return { status: 'opened' }; } };
  const menu = installObjectActionMenu({ win, provider, getLocale: () => locale, onError: error => errors.push(error) });
  const resource = { type: 'vm', id: 'vm-a', name: 'VM A', element: source };
  t.after(() => { menu.stop(); win.close(); });
  return { win, doc, menu, resource, opened, errors, copies, source, timers, intervals,
    root: () => doc.querySelector('[data-rivetin-object-menu]'),
    shortcut: id => doc.querySelector(`[data-shortcut-id="${id}"]`),
    copy: () => doc.querySelector('[data-copy-vm-id]'),
    counts: () => ({ native, selected }),
    async show() { assert.equal(menu.open(resource, 30, 40), true); await settle(); },
  };
}

test('five colored two-character shortcuts precede the complete directory; copy ID is last', async t => {
  const f = fixture(t); await f.show(); const root = f.root();
  const shortcuts = [...root.querySelectorAll('[data-shortcut-id]')];
  assert.deepEqual(shortcuts.map(node => node.dataset.shortcutId), ['console', 'power', 'migration', 'clone', 'isolation']);
  assert.deepEqual(shortcuts.map(node => node.textContent), ['终端', '关机', '迁移', '克隆', '隔离']);
  assert.equal(new Set(shortcuts.map(node => node.style.getPropertyValue('--rvm-color'))).size, 5);
  for (const node of shortcuts) { assert.ok(node.title.length > 2); assert.equal(node.getAttribute('aria-label'), node.title); }
  assert.equal(root.querySelectorAll('[data-group-id]').length, 7);
  assert.equal(root.querySelector('.rvm-main').lastElementChild.firstElementChild, f.copy());
  assert.equal(f.shortcut('isolation').disabled, true); assert.match(f.shortcut('isolation').title, /entry-missing/);
  f.shortcut('isolation').click(); assert.equal(f.opened.length, 0);
  assert.deepEqual(f.counts(), { native: 0, selected: 0 }); assert.equal(f.win.location.hash, '#/vms');
});

for (const [status, label, actionId] of [['RUNNING', '关机', 'vm.power.shutdown'], ['STOPPED', '开机', 'vm.power.start']]) {
  test(`power shortcut ${status} opens only its exact canonical action after a fresh read`, async t => {
    let reads = 0; const f = fixture(t, { read: async () => { reads++; return state(status); } }); await f.show();
    assert.equal(f.shortcut('power').textContent, label); assert.equal(f.shortcut('power').disabled, false);
    f.shortcut('power').click(); await settle(); assert.equal(reads, 2);
    assert.equal(f.opened.length, 1); assert.equal(f.opened[0].actionId, actionId); assert.equal(f.opened[0].resource.id, 'vm-a');
    assert.equal(f.root(), null); assert.deepEqual(f.counts(), { native: 0, selected: 0 });
  });
}
for (const status of ['SUSPENDED', 'UNKNOWN', 'STARTING']) {
  test(`power shortcut refuses ${status} without inventing a forced operation`, async t => {
    const f = fixture(t, { read: async () => state(status) }); await f.show();
    assert.equal(f.shortcut('power').disabled, true); assert.equal(f.shortcut('power').textContent, '电源');
    assert.match(f.shortcut('power').title, /不支持/); f.shortcut('power').click(); assert.equal(f.opened.length, 0);
  });
}
for (const [name, second] of [
  ['state change', () => state('STOPPED')],
  ['permission denied', () => state('RUNNING', { 'vm.power.shutdown': { allowed: false, reason: 'No shutdown authorization' } })],
  ['wrong ID', () => ({ ...state(), snapshot: { id: 'vm-b', status: 'RUNNING' } })],
]) {
  test(`shortcut fresh read blocks ${name}`, async t => {
    let reads = 0; const f = fixture(t, { read: async () => ++reads === 1 ? state() : second() }); await f.show();
    f.shortcut('power').click(); await settle(); assert.equal(reads, 2); assert.equal(f.opened.length, 0); assert.ok(f.root());
  });
}
for (const [shortcut, actionId] of [['console', 'vm.console.open'], ['migration', 'vm.migration.withinCluster'], ['clone', 'vm.clone']]) {
  test(`${shortcut} delegates to the canonical verified form path`, async t => {
    const f = fixture(t, shortcut === 'migration' ? { read: async () => state('STOPPED') } : {}); await f.show(); assert.equal(f.shortcut(shortcut).disabled, false);
    f.shortcut(shortcut).click(); await settle(); assert.equal(f.opened[0].actionId, actionId); assert.equal(f.opened[0].action.enabled, true);
  });
}
test('backend clone denial disables the shortcut with the supplied readable reason', async t => {
  const f = fixture(t, { read: async () => state('RUNNING', { 'vm.clone': { allowed: false, reason: 'Clone backend adapter is not connected' } }) });
  await f.show(); assert.equal(f.shortcut('clone').disabled, true); assert.match(f.shortcut('clone').title, /backend adapter/);
  f.shortcut('clone').click(); assert.equal(f.opened.length, 0);
});
test('unconnected adapter keeps copy ID available and copies source VM, never another open drawer VM', async t => {
  const f = fixture(t, { noProvider: true, drawer: true }); await f.show();
  assert.ok([...f.root().querySelectorAll('[data-shortcut-id]')].every(node => node.disabled));
  assert.equal(f.copy().disabled, false); f.copy().click(); await settle();
  assert.deepEqual(f.copies, ['vm-a']); assert.match(f.root().textContent, /ID 已复制/); assert.equal(f.opened.length, 0);
});
for (const change of ['ID', 'route', 'removed', 'closed', 'stopped']) {
  test(`old copy callback cannot write after source ${change}`, async t => {
    const f = fixture(t, { noProvider: true }); await f.show(); const copy = f.copy();
    if (change === 'ID') f.source.closest('tr').dataset.rowKey = 'vm-b';
    if (change === 'route') f.win.history.replaceState({}, '', '#/vms/vm-b');
    if (change === 'removed') f.source.remove();
    if (change === 'closed') f.menu.close();
    if (change === 'stopped') f.menu.stop();
    copy.click(); await settle(); assert.deepEqual(f.copies, []); assert.equal(f.opened.length, 0);
  });
}
test('clipboard failures disclose only a generic actionable message', async t => {
  const f = fixture(t, { noProvider: true, clipboard: () => Promise.reject(new Error('private credential diagnostic')) }); await f.show();
  f.copy().click(); await settle(); assert.match(f.root().textContent, /剪贴板权限/);
  assert.doesNotMatch(f.root().textContent, /private|credential/); assert.equal(f.copy().disabled, false); assert.equal(f.timers.size, 0);
});
test('missing clipboard API is handled without a provider or uncaught rejection', async t => {
  const f = fixture(t, { noProvider: true, clipboard: null }); await f.show(); f.copy().click(); await settle();
  assert.match(f.root().textContent, /剪贴板权限/); assert.equal(f.timers.size, 0);
});
test('rapid clicks coalesce one pending clipboard write and handle synchronous clipboard denial', async t => {
  const pending = deferred(); const f = fixture(t, { noProvider: true, clipboard: () => pending.promise }); await f.show();
  const old = f.copy(); old.click(); old.click(); f.copy().click(); assert.deepEqual(f.copies, ['vm-a']);
  pending.resolve(); await settle(); assert.equal(f.timers.size, 0);
  const rejected = fixture(t, { noProvider: true, clipboard: () => { throw new Error('private clipboard policy'); } }); await rejected.show();
  rejected.copy().click(); assert.match(rejected.root().textContent, /剪贴板权限/); assert.doesNotMatch(rejected.root().textContent, /private/); assert.equal(rejected.timers.size, 0);
});
for (const end of ['close', 'stop', 'source change']) {
  test(`late clipboard completion is ignored after ${end}; owned timers are cleared`, async t => {
    const pending = deferred(); const f = fixture(t, { noProvider: true, clipboard: () => pending.promise }); await f.show();
    f.copy().click(); assert.equal(f.copy().disabled, true); assert.equal(f.timers.size, 1);
    if (end === 'close') f.menu.close(); else if (end === 'stop') f.menu.stop(); else f.source.closest('tr').dataset.rowKey = 'vm-b';
    await settle(); pending.reject(new Error('private late diagnostic')); await settle();
    assert.equal(f.root(), null); assert.equal(f.errors.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.intervals.size, 0);
  });
}
test('copy timeout restores the button and ignores later fulfillment', async t => {
  const pending = deferred(); const f = fixture(t, { noProvider: true, clipboard: () => pending.promise }); await f.show(); f.copy().click();
  [...f.timers.values()][0].fn(); assert.match(f.root().textContent, /剪贴板权限/); assert.equal(f.copy().disabled, false);
  pending.resolve(); await settle(); assert.doesNotMatch(f.root().textContent, /ID 已复制/);
});
test('English quick actions have complete accessible descriptions and keyboard access to footer', async t => {
  const f = fixture(t, { locale: 'en-US' }); await f.show(); assert.equal(f.shortcut('power').textContent, 'Off');
  assert.match(f.shortcut('power').getAttribute('aria-label'), /gracefully/); assert.match(f.copy().textContent, /Copy VM ID/);
  f.shortcut('console').focus(); f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(f.doc.activeElement, f.shortcut('clone'));
  f.copy().focus(); f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  assert.deepEqual(f.copies, ['vm-a']); assert.match(f.root().textContent, /VM ID copied/);
});
test('Tab and Shift Tab reach quick actions and copy without leaving the owned menu', async t => {
  const f = fixture(t); await f.show();
  const key = (shiftKey = false) => f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
  f.doc.querySelector('[data-group-id="vm.power"]').focus(); key(true); assert.equal(f.doc.activeElement, f.shortcut('clone'));
  f.doc.querySelector('[data-group-id="vm.recycle"]').focus(); key(); assert.equal(f.doc.activeElement, f.copy());
  key(); assert.equal(f.doc.activeElement, f.shortcut('console')); assert.ok(f.root());
});
