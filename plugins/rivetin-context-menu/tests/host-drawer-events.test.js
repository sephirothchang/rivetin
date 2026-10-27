import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installContextMenu } from '../src/menu.js';
import { defaults } from '../src/configuration.js';

const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const menuSelector = '[data-rivetin-context-menu]';
const baseHash = '#/clusters/cluster-a?view=%22vms%22';
const detailHash = baseHash + '&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' }));

function fixture() {
  const dom = new JSDOM('<!doctype html><head><style id="host-style">.drawer-content-inner{color:black}</style></head><body><button id="outside">Outside</button></body>', {
    url: 'https://tower.example.invalid/' + detailHash,
  });
  const win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{ width: 180, height: 100 }]; };
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 40, top: 50, right: 220, bottom: 150, width: 180, height: 100 });
  let pane, unlistens = 0;
  const historyListeners = new Set(), subscriptions = new Set();
  const counts = { expand: 0, edit: 0, otherBusiness: 0, pointerOutside: 0, clickOutside: 0, escape: 0 };
  function closePane(reason) {
    if (!pane?.isConnected) return;
    counts[reason]++; pane.remove(); win.history.replaceState({}, '', baseHash);
    for (const listener of historyListeners) listener();
  }
  // Host handlers are installed first. A later document listener cannot undo these effects.
  doc.addEventListener('pointerdown', event => { if (pane?.isConnected && !pane.contains(event.target)) closePane('pointerOutside'); }, true);
  doc.addEventListener('click', event => { if (pane?.isConnected && !pane.contains(event.target)) closePane('clickOutside'); });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) closePane('escape'); });
  const store = { get: defaults, status: () => ({ loaded: true }), subscribe(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); } };
  const history = { listen(listener) { historyListeners.add(listener); return () => { unlistens++; historyListeners.delete(listener); }; } };
  const stop = installContextMenu({ win, store, history });
  // New native controls arrive after activation; they are not old quarantined handlers.
  pane = doc.createElement('aside'); pane.className = 'drawer-content-inner';
  pane.innerHTML = '<div class="detail-sidebar-header"><div class="frame"><div class="title-wrapper"><span class="header-title">VM A</span></div><div class="toolbar"><div class="operation-button-content"><button id="other-business">关机</button></div></div></div></div><section><header>磁盘<button class="edit-icon" id="edit-disk">编辑</button></header><div class="disk-item"><div id="disk-header" class="ant-collapse-header" role="button" tabindex="0" aria-expanded="false"><span class="name">Disk A1</span></div></div></section>';
  pane.querySelector('#disk-header').onclick = () => { counts.expand++; pane.querySelector('#disk-header').setAttribute('aria-expanded', 'true'); };
  pane.querySelector('#edit-disk').onclick = () => { counts.edit++; };
  pane.querySelector('#other-business').onclick = () => { counts.otherBusiness++; };
  doc.body.append(pane);
  function open() {
    const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 100 });
    pane.querySelector('#disk-header').dispatchEvent(event);
    const menu = doc.querySelector(menuSelector);
    assert.equal(event.defaultPrevented, true); assert.ok(menu);
    return [...menu.querySelectorAll('[role="menuitem"]')].find(button => button.textContent.includes('展开详情'));
  }
  return { win, doc, pane, counts, stop, subscriptions, open, unlistens: () => unlistens,
    dispose() { stop(); dom.window.close(); } };
}

for (const targetKind of ['button', 'nested icon']) test(`internal disk menu ${targetKind} click preserves host drawer through pointerdown and bubble`, () => {
  const f = fixture();
  try {
    const before = f.win.location.href, button = f.open(); assert.ok(button, 'the read-only native expansion must be available');
    const target = targetKind === 'nested icon' ? button.querySelector('span') : button;
    target.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(f.pane.isConnected, true, 'the host must still consider the menu interaction inside its drawer');
    assert.equal(f.win.location.href, before); assert.equal(f.counts.expand, 1);
    assert.equal(f.pane.querySelector('#disk-header').getAttribute('aria-expanded'), 'true');
    assert.equal(f.counts.edit, 0); assert.equal(f.counts.otherBusiness, 0);
    assert.equal(f.counts.pointerOutside, 0); assert.equal(f.counts.clickOutside, 0); assert.equal(f.doc.querySelector(menuSelector), null);
  } finally { f.dispose(); }
});

test('removing a custom menu during click must not bubble as an outside click to an earlier host listener', () => {
  const f = fixture();
  try {
    const before = f.win.location.href, button = f.open(); assert.ok(button);
    // Isolate the bubble-phase failure even if pointerdown placement has been fixed.
    button.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(f.counts.expand, 1); assert.equal(f.counts.clickOutside, 0); assert.equal(f.pane.isConnected, true);
    assert.equal(f.win.location.href, before); assert.equal(f.doc.querySelector(menuSelector), null);
  } finally { f.dispose(); }
});

test('Escape closes only the custom menu before the host handles drawer Escape', () => {
  const f = fixture();
  try {
    const before = f.win.location.href; f.open();
    const target = f.doc.activeElement;
    target.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(f.doc.querySelector(menuSelector), null); assert.equal(f.pane.isConnected, true); assert.equal(f.counts.escape, 0);
    assert.equal(f.win.location.href, before); assert.equal(f.counts.expand, 0); assert.equal(f.counts.otherBusiness, 0);
  } finally { f.dispose(); }
});

test('a genuine outside pointer click remains available to the host drawer', () => {
  const f = fixture();
  try {
    f.open(); const target = f.doc.querySelector('#outside');
    target.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(f.pane.isConnected, false); assert.equal(f.win.location.hash, baseHash); assert.equal(f.counts.pointerOutside, 1);
    assert.equal(f.doc.querySelector(menuSelector), null); assert.equal(f.counts.expand, 0); assert.equal(f.counts.otherBusiness, 0);
  } finally { f.dispose(); }
});

test('stop removes its menu and stylesheet without removing the native drawer or host style', () => {
  const f = fixture();
  try {
    const before = f.win.location.href, hostStyle = f.doc.querySelector('#host-style').outerHTML;
    f.open(); f.stop(); f.stop();
    assert.equal(f.doc.querySelector(menuSelector), null); assert.equal(f.doc.querySelectorAll('style').length, 1);
    assert.equal(f.doc.querySelector('#host-style').outerHTML, hostStyle); assert.equal(f.pane.isConnected, true); assert.equal(f.win.location.href, before);
    assert.equal(f.unlistens(), 1); assert.equal(f.subscriptions.size, 0);
    const context = new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); f.pane.querySelector('#disk-header').dispatchEvent(context);
    assert.equal(context.defaultPrevented, false); assert.equal(f.doc.querySelector(menuSelector), null);
  } finally { f.dispose(); }
});

test('fallback menu for an external host anchor uses the existing drawer boundary and copies without closing it', async () => {
  const f = fixture();
  try {
    const before = f.win.location.href, copied = [];
    Object.defineProperty(f.win.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied.push(value); } } });
    const source = f.doc.createElement('a'); source.href = '#/hosts/host-b?view=%22detail%22'; source.textContent = 'Host B'; f.doc.body.append(source);
    const context = new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 70, clientY: 90 }); source.dispatchEvent(context);
    assert.equal(context.defaultPrevented, true);
    const menu = f.doc.querySelector(menuSelector); assert.ok(menu); assert.equal(f.pane.contains(menu), true);
    const copy = [...menu.querySelectorAll('[role="menuitem"]')].find(button => button.textContent.includes('复制名称')); assert.ok(copy);
    copy.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    copy.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.deepEqual(copied, ['Host B']); assert.equal(f.doc.querySelector(menuSelector), null);
    assert.equal(f.pane.isConnected, true); assert.equal(f.win.location.href, before);
    assert.deepEqual(f.counts, { expand: 0, edit: 0, otherBusiness: 0, pointerOutside: 0, clickOutside: 0, escape: 0 });
  } finally { f.dispose(); }
});
