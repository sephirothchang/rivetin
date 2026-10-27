import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installContextMenu } from '../src/menu.js';
import { defaults } from '../src/configuration.js';

const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const selector = '[data-rivetin-context-menu]';
const baseHash = '#/clusters/cluster-a?view=%22vms%22';
const hashFor = (id, view = 'detail') => baseHash + '&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id, view }));

function fixture({ preexisting = true, withHistory = true } = {}) {
  const dom = new JSDOM('<!doctype html><button id="outside">Outside</button>', { url: 'https://tower.example.invalid/' + hashFor('vm-a') });
  const win = dom.window, doc = win.document, listeners = new Set();
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{ width: 180, height: 100 }]; };
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 40, top: 50, right: 220, bottom: 150, width: 180, height: 100 });
  const counts = { toggle: 0, replacementToggle: 0, edit: 0, business: 0, pointerOutside: 0, clickOutside: 0 };
  const pane = doc.createElement('aside'); pane.className = 'drawer-content-inner';
  pane.innerHTML = '<div class="detail-sidebar-header"><div class="frame"><div class="title-wrapper"><span class="header-title">VM A</span></div><div class="toolbar"><div class="operation-button-content"><button id="power">关机</button></div></div></div></div><section id="disk-section"><header>磁盘<button id="edit" class="edit-icon">编辑</button></header><div class="disk-item"><div id="disk-header" class="ant-collapse-header" role="button" tabindex="0" aria-expanded="false"><span class="name">Disk A1</span></div></div></section>';
  const header = pane.querySelector('#disk-header'), frame = pane.querySelector('.frame');
  header.onclick = () => { counts.toggle++; header.setAttribute('aria-expanded', String(header.getAttribute('aria-expanded') !== 'true')); };
  pane.querySelector('#edit').onclick = () => counts.edit++;
  pane.querySelector('#power').onclick = () => counts.business++;
  function closeHost(reason) {
    if (!pane.isConnected) return; counts[reason]++; pane.remove(); win.history.replaceState({}, '', baseHash);
    for (const listener of listeners) listener();
  }
  // Native document capture is registered before activation; a later document handler cannot undo a close.
  doc.addEventListener('pointerdown', event => { if (pane.isConnected && !pane.contains(event.target)) closeHost('pointerOutside'); }, true);
  doc.addEventListener('click', event => { if (pane.isConnected && !pane.contains(event.target)) closeHost('clickOutside'); });
  const store = { get: defaults, status: () => ({ loaded: true }), subscribe: () => () => {} };
  const history = { listen(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  if (preexisting) doc.body.append(pane);
  const stop = installContextMenu({ win, store, history: withHistory ? history : undefined });
  if (!preexisting) doc.body.append(pane);
  function show() {
    header.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 100 }));
    const menu = doc.querySelector(selector); assert.ok(menu, 'the internal disk context menu must be shown'); return menu;
  }
  function toggleItem() {
    const menu = show(), item = [...menu.querySelectorAll('[role="menuitem"]')].find(button => /展开详情|收起详情/.test(button.textContent));
    assert.ok(item, 'a pre-existing read-only collapse control must remain available after activation quarantine'); return item;
  }
  function route(id, view) { win.history.replaceState({}, '', hashFor(id, view)); for (const listener of listeners) listener(); }
  return { win, doc, pane, header, frame, counts, show, toggleItem, route,
    dispose() { stop(); dom.window.close(); } };
}

test('a pre-existing disk collapse header can toggle after activation without exposing quarantined edits', () => {
  const f = fixture();
  try {
    const before = f.win.location.href, item = f.toggleItem();
    const labels = [...f.doc.querySelectorAll(`${selector} [role="menuitem"]`)].map(button => button.textContent);
    assert.ok(!labels.some(label => label.includes('编辑磁盘配置') || label.includes('关机')));
    item.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true })); item.click();
    assert.equal(f.counts.toggle, 1); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
    assert.equal(f.header.getAttribute('aria-expanded'), 'true'); assert.equal(f.pane.isConnected, true); assert.equal(f.win.location.href, before);
    assert.equal(f.counts.pointerOutside, 0); assert.equal(f.counts.clickOutside, 0); assert.equal(f.doc.querySelector(selector), null);
  } finally { f.dispose(); }
});

test('pre-existing edit and toolbar controls remain quarantined even though the toggle is read-only', () => {
  const f = fixture();
  try {
    const menu = f.show();
    assert.ok(![...menu.querySelectorAll('[role="menuitem"]')].some(button => button.textContent.includes('编辑磁盘配置') || button.textContent.includes('关机')));
    assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});

test('an explicitly identified pure toggle does not grant editor access without host history', () => {
  const f = fixture({ withHistory: false });
  try {
    f.toggleItem().click();
    assert.equal(f.counts.toggle, 1); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
    const labels = [...f.show().querySelectorAll('[role="menuitem"]')].map(node => node.textContent);
    assert.ok(!labels.some(label => /配置|关机/.test(label)));
  } finally { f.dispose(); }
});

test('reopening the menu supports collapse after a validated expansion without unquarantining editors', () => {
  const f = fixture();
  try {
    f.toggleItem().click(); assert.equal(f.header.getAttribute('aria-expanded'), 'true');
    const collapse = f.toggleItem(); assert.match(collapse.textContent, /收起详情/); collapse.click();
    assert.equal(f.header.getAttribute('aria-expanded'), 'false');
    assert.equal(f.counts.toggle, 2); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});

test('losing the explicit expansion state removes the exception for a saved header', () => {
  const f = fixture();
  try {
    const item = f.toggleItem(); f.header.removeAttribute('aria-expanded'); item.click();
    assert.equal(f.counts.toggle, 0); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});

test('replacing the disk header cannot redirect an old toggle menu to either old or replacement handlers', () => {
  const f = fixture({ preexisting: false });
  try {
    const item = f.toggleItem(), replacement = f.header.cloneNode(true);
    replacement.onclick = () => f.counts.replacementToggle++;
    f.header.replaceWith(replacement); item.click();
    assert.equal(f.counts.toggle, 0); assert.equal(f.counts.replacementToggle, 0); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});

test('renaming the parent VM title invalidates an already-shown internal toggle', () => {
  const f = fixture({ preexisting: false });
  try {
    const item = f.toggleItem(); f.frame.querySelector('.header-title').textContent = 'VM B'; item.click();
    assert.equal(f.counts.toggle, 0); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});

test('a replaced parent frame with the same name cannot inherit the old internal toggle binding', () => {
  const f = fixture({ preexisting: false });
  try {
    const item = f.toggleItem(); f.frame.replaceWith(f.frame.cloneNode(true)); item.click();
    assert.equal(f.counts.toggle, 0); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});

for (const transition of ['A to B', 'A to B to A', 'same ID different view']) test(`route ${transition} invalidates an old internal toggle even before observer cleanup`, () => {
  const f = fixture({ preexisting: false });
  try {
    const item = f.toggleItem();
    if (transition === 'same ID different view') f.route('vm-a', 'snapshots');
    else { f.route('vm-b'); if (transition === 'A to B to A') f.route('vm-a'); }
    item.click(); assert.equal(f.counts.toggle, 0); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});

for (const disabled of ['aria-disabled', 'disabled attribute', 'inert header', 'inert section']) test(`${disabled} prevents an already-shown read-only toggle`, () => {
  const f = fixture({ preexisting: false });
  try {
    const item = f.toggleItem();
    if (disabled === 'aria-disabled') f.header.setAttribute('aria-disabled', 'true');
    if (disabled === 'disabled attribute') f.header.setAttribute('disabled', '');
    if (disabled === 'inert header') f.header.setAttribute('inert', '');
    if (disabled === 'inert section') f.pane.querySelector('#disk-section').setAttribute('inert', '');
    item.click(); assert.equal(f.counts.toggle, 0); assert.equal(f.counts.edit, 0); assert.equal(f.counts.business, 0);
  } finally { f.dispose(); }
});
