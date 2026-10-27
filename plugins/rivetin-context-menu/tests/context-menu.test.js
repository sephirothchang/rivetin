import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { configuration, defaults, validate } from '../src/configuration.js';
import { identifyResource, nativeActions, resourceUrl } from '../src/resources.js';
import { installContextMenu, clampPosition } from '../src/menu.js';
import { createConfigurationStore } from '../../../framework/src/config-store.js';
import { validateManifest, validatePackage } from '../../../framework/server/manifest.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
function fixture(markup = '', locale = 'zh-CN') {
  const sidebar = markup.includes('class="frame"') ? '&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' })) : '';
  const dom = new JSDOM('', { url: 'https://tower.example.invalid/#/clusters/cluster-a?view=%22vms%22' + sidebar }), win = dom.window;
  win.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{ width: 150, height: 30 }]; };
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 100, top: 50, bottom: 80, width: 280, height: 300 });
  let settings = defaults(); const subscribers = new Set();
  const store = { get: () => settings, status: () => ({ loaded: true }), subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); },
    set: patch => { settings = { ...settings, ...patch }; for (const fn of subscribers) fn(); } };
  const errors = [], stop = installContextMenu({ win, store, history: { listen: () => () => {} }, getLocale: () => locale, onError: value => errors.push(value) });
  win.document.body.innerHTML = markup;
  return { win, doc: win.document, store, errors, dispose: () => { stop(); win.close(); }, stop };
}
const row = '<table><tr data-row-key="vm-a"><td unique="name"><span id="target" tabindex="0">VM A</span></td></tr></table>';
const frame = `<aside class="frame"><div class="title-wrapper"><span class="header-title">VM A</span></div><div class="toolbar"><div class="operation-button-content"><button id="shutdown" class="ant-btn-dangerous">关机</button><button id="migrate" disabled>迁移</button><button id="hidden" hidden>删除</button><button id="restart"><svg data-testid="RestartNew16GradientGrayIcon"></svg></button></div></div><div class="detail-tabs"><span class="tab-item" id="snapshots">快照</span></div></aside>`;
function selectVm(win, id = 'vm-a') { win.history.replaceState({}, '', `#/clusters/cluster-a?view=%22vms%22&sidebar=${encodeURIComponent(JSON.stringify({ type: 'vm', id, view: 'detail' }))}`); }
function open(f, target = '#target', options = {}) { const event = new f.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 100, ...options }); f.doc.querySelector(target).dispatchEvent(event); return event; }
const items = f => [...f.doc.querySelectorAll('[role="menuitem"]')];
test('manifest declares a distinct plugin identity and supported permission', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url)));
  assert.equal(validateManifest(manifest).id, configuration.id); assert.deepEqual(manifest.configuration.defaults, defaults());
  assert.throws(() => validateManifest({ ...manifest, permissions: ['ui.arbitrary'] }), /INVALID_MANIFEST/);
  assert.equal(validateManifest({ ...manifest, id: 'rivetin-other' }).id, 'rivetin-other');
  // Old-brand IDs and package protocols are deliberately not accepted.
  assert.throws(() => validateManifest({ ...manifest, id: 'pluginkit-context-menu' }), /INVALID_MANIFEST/);
  assert.throws(() => validateManifest({ ...manifest, frontend: { ...manifest.frontend, format: 'pluginkit-global-v1' } }), /INVALID_MANIFEST/);
  assert.throws(() => validatePackage(Buffer.from(JSON.stringify({ format: 'pluginkit-package-v1', manifest, files: [] }))), /INVALID_PACKAGE/);
});
test('settings reject extra fields, duplicate types and wrong value types', () => {
  assert.deepEqual(validate(defaults()), defaults());
  for (const bad of [{ ...defaults(), token: 'x' }, { ...defaults(), resourceTypes: ['vm', 'vm'] }, { ...defaults(), enabled: 1 }, { ...defaults(), resourceTypes: ['unknown'] }]) assert.throws(() => validate(bad));
});
test('only same-origin recognized resource routes are accepted', () => {
  for (const route of ['datacenters', 'clusters', 'hosts', 'vms', 'vm-volumes', 'disks']) assert.ok(resourceUrl(`https://tower.example.invalid/#/${route}/resource-a`, 'https://tower.example.invalid'));
  for (const link of ['javascript:alert(1)', 'https://evil.invalid/#/vms/a', 'https://tower.example.invalid/logout#/vms/a', 'https://tower.example.invalid/#/vms/a/b', 'https://u:p@tower.example.invalid/#/vms/a', 'https://tower.example.invalid/#/users/a', 'https://tower.example.invalid/#/vms/%2e%2e']) assert.equal(resourceUrl(link, 'https://tower.example.invalid'), null);
});
for (const [type, markup] of [
  ['organization', '<div class="resource-topo-content"><div class="infra-area"><span id="target">Tower A</span></div></div>'],
  ['datacenter', '<div class="datacenter-info" data-test="dc-a"><span class="name" id="target">DC A</span></div>'],
  ['cluster', '<div class="cluster-info"><span class="response-area" data-test="cluster-a"></span><span class="name" id="target">Cluster A</span></div>'],
  ['host', '<div class="host-info" data-test="host-a"><span class="name" id="target">Host A</span></div>'],
  ['vm', row], ['vmVolume', '<a href="#/vm-volumes/volume-a" id="target">Volume A</a>'], ['disk', '<a href="#/disks/disk-a" id="target">Disk A</a>'],
]) test(`identifies ${type} without reading private application state`, () => {
  const f = fixture(markup); try { assert.equal(identifyResource(f.doc.querySelector('#target'), f.win)?.type, type); assert.equal(open(f).defaultPrevented, true); } finally { f.dispose(); }
});
test('a datacenter display-name attribute is never presented as its ID', () => {
  const f = fixture('<div class="datacenter-info"><span class="response-area" data-test="DC-A"></span><span class="name" id="target">DC-A</span></div>');
  try { assert.equal(identifyResource(f.doc.querySelector('#target'), f.win).id, null); } finally { f.dispose(); }
});
test('unknown rows and unsafe resource links retain the browser menu', () => {
  const f = fixture('<table><tr data-row-key="vm-a"><td unique="name"><span id="target">Unknown</span></td></tr></table><a id="external" href="https://evil.invalid/#/vms/a">external</a>');
  try { f.win.history.replaceState({}, '', '#/settings/users'); assert.equal(open(f).defaultPrevented, false); assert.equal(open(f, '#external').defaultPrevented, false); } finally { f.dispose(); }
});
for (const markup of ['<input id="target">', '<textarea id="target"></textarea>', '<div contenteditable="true" id="target">edit</div>', '<div role="dialog">' + row + '</div>', '<div class="c89-plugin-root">' + row + '</div>']) test('input, dialog and plugin UI remain untouched', () => {
  const f = fixture(markup); try { assert.equal(open(f).defaultPrevented, false); } finally { f.dispose(); }
});
test('Shift-right-click preserves browser behavior; disabled types and plugin stop intercepting', () => {
  const f = fixture(row); try {
    assert.equal(open(f, '#target', { shiftKey: true }).defaultPrevented, false);
    f.store.set({ resourceTypes: ['host'] }); assert.equal(open(f).defaultPrevented, false);
    f.store.set({ resourceTypes: ['vm'], enabled: false }); assert.equal(open(f).defaultPrevented, false);
  } finally { f.dispose(); }
});
test('right-click never clicks a native operation or changes selection', () => {
  const f = fixture(row + frame); selectVm(f.win); let clicks = 0;
  try { f.doc.querySelector('#shutdown').onclick = () => clicks++; f.doc.querySelector('#target').onclick = () => clicks++; open(f); assert.equal(clicks, 0); assert.ok(items(f).some(button => button.textContent.includes('关机'))); } finally { f.dispose(); }
});
test('row right-click directly delegates native actions without selection or a sidebar', () => {
  const f = fixture(row.replace('</tr>', '<td unique="_action_"><button class="menu-button ant-dropdown-trigger" id="row-more">More</button></td></tr>'));
  let selected = 0, opened = 0, operations = 0;
  try {
    f.doc.querySelector('tr').onclick = () => selected++;
    f.doc.querySelector('#row-more').onclick = event => {
      event.stopPropagation(); opened++;
      f.doc.body.insertAdjacentHTML('beforeend', '<div class="ant-dropdown" style="left:42px"><ul role="menu"><li role="menuitem" id="native-action">关机</li></ul></div>');
      f.doc.querySelector('#native-action').onclick = () => operations++;
    };
    const initialHref = f.win.location.href;
    assert.equal(open(f).defaultPrevented, true); assert.equal(opened, 1); assert.equal(selected, 0); assert.equal(operations, 0);
    assert.equal(f.win.location.href, initialHref); assert.equal(f.doc.querySelector('.frame,[data-rivetin-context-menu]'), null);
    f.store.set({}); assert.equal(f.doc.querySelector('.ant-dropdown').style.left, '42px'); assert.equal(opened, 1);
    f.doc.querySelector('#native-action').click(); assert.equal(operations, 1); assert.equal(selected, 0);
  } finally { f.dispose(); }
});
test('native menu honors disabled/hidden buttons, icon labels and native tabs', () => {
  const f = fixture(row + frame); selectVm(f.win);
  try { open(f); assert.ok(items(f).find(button => button.textContent.includes('迁移')).disabled); assert.ok(items(f).some(button => button.textContent.includes('重启'))); assert.ok(items(f).some(button => button.textContent.includes('快照'))); assert.ok(!items(f).some(button => button.textContent.includes('删除'))); } finally { f.dispose(); }
});
test('native more trigger outside operation-button-content remains reachable', () => {
  const f = fixture(row + frame.replace('</div></div><div class="detail-tabs">', '</div><button id="more"><svg data-testid="MoreEllipsis316BoldBlueIcon"></svg></button></div><div class="detail-tabs">')); selectVm(f.win);
  try { let count = 0; f.doc.querySelector('#more').onclick = () => count++; open(f); items(f).find(button => button.textContent.includes('更多操作')).click(); assert.equal(count, 1); } finally { f.dispose(); }
});
test('English menu follows host locale, including icon-only native buttons', () => {
  const f = fixture(row + frame, 'en-US'); selectVm(f.win);
  try { open(f); assert.ok(f.doc.querySelector('[aria-label="Resource context menu"]')); assert.ok(items(f).some(button => button.textContent.includes('Open details'))); assert.ok(items(f).some(button => button.textContent.includes('Restart'))); } finally { f.dispose(); }
});
test('outside pointer, resize and scroll dismiss the menu', () => {
  const f = fixture(row); try { for (const [target, type] of [[f.doc.body, 'pointerdown'], [f.win, 'resize'], [f.doc.body, 'scroll']]) { open(f); target.dispatchEvent(new f.win.Event(type, { bubbles: true })); assert.equal(f.doc.querySelector('[role="menu"]'), null); } } finally { f.dispose(); }
});
test('removing a target or changing the route dismisses a pending menu', async () => {
  const f = fixture(row); try { open(f); f.doc.querySelector('#target').closest('tr').remove(); await new Promise(resolve => f.win.queueMicrotask(resolve)); assert.equal(f.doc.querySelector('[role="menu"]'), null); } finally { f.dispose(); }
});
test('native action dispatches exactly once and retains native confirmation', () => {
  const f = fixture(row + frame); selectVm(f.win); let clicks = 0;
  try { f.doc.querySelector('#shutdown').onclick = () => { clicks++; const dialog = f.doc.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.textContent = 'Native confirmation'; f.doc.body.append(dialog); };
    open(f); items(f).find(button => button.textContent.includes('关机')).click(); assert.equal(clicks, 1); assert.equal(f.doc.querySelector('[role="dialog"]').textContent, 'Native confirmation'); assert.equal(f.doc.querySelector('[role="menu"]'), null);
  } finally { f.dispose(); }
});
test('switching target or disabling the original button prevents stale action dispatch', () => {
  const f = fixture(row + frame); selectVm(f.win); let clicks = 0;
  try { f.doc.querySelector('#shutdown').onclick = () => clicks++; open(f); selectVm(f.win, 'vm-b'); items(f).find(button => button.textContent.includes('关机')).click(); assert.equal(clicks, 0);
    const fresh = fixture(row + frame);
    try { fresh.doc.querySelector('#shutdown').onclick = () => clicks++; open(fresh); fresh.doc.querySelector('#shutdown').disabled = true; items(fresh).find(button => button.textContent.includes('关机')).click(); assert.equal(clicks, 0); } finally { fresh.dispose(); }
  } finally { f.dispose(); }
});
test('duplicate matching detail frames and other selected objects suppress native actions', () => {
  const f = fixture(row + frame + frame); selectVm(f.win);
  try { const resource = identifyResource(f.doc.querySelector('#target'), f.win); assert.deepEqual(nativeActions(resource, f.win), []); selectVm(f.win, 'vm-b'); assert.deepEqual(nativeActions(resource, f.win), []); } finally { f.dispose(); }
});
for (const type of ['vmDisk', 'nic']) test(`internal ${type} uses only its own section edit entry`, () => {
  const content = type === 'vmDisk' ? '<div class="disk-item"><div class="ant-collapse-header" aria-expanded="false" id="internal">Disk 1</div></div>' : '<div class="ant-collapse-item"><div class="ant-collapse-header" aria-expanded="false" id="internal"><svg data-testid="Nic24GradientBlueIcon"></svg>NIC0</div></div>';
  const f = fixture(row + frame.replace('</aside>', `<section><header>${type === 'vmDisk' ? '磁盘' : '网络设备'}<button class="edit-icon" id="edit">编辑</button></header>${content}</section></aside>`)); selectVm(f.win);
  try { let edits = 0; f.doc.querySelector('#edit').onclick = () => edits++; const resource = identifyResource(f.doc.querySelector('#internal'), f.win); assert.equal(resource.internal, type); open(f, '#internal'); assert.ok(!items(f).some(button => button.textContent.includes('关机'))); items(f).find(button => button.textContent.includes('配置')).click(); assert.equal(edits, 1); } finally { f.dispose(); }
});
test('main title remains a cluster while a VM sidebar is open', () => {
  const f = fixture('<div class="title-wrapper"><span class="title-content" id="target">Cluster A</span></div>' + frame); selectVm(f.win);
  try { const resource = identifyResource(f.doc.querySelector('#target'), f.win); assert.equal(resource.type, 'cluster'); assert.equal(resource.id, 'cluster-a'); assert.ok(!resource.href.includes('sidebar')); assert.deepEqual(nativeActions(resource, f.win), []); } finally { f.dispose(); }
});
test('sidebar identity also works on an overview or global VM list', () => {
  for (const path of ['/overview', '/vms']) {
    const href = `https://tower.example.invalid/#${path}?sidebar=${encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' }))}`;
    assert.equal(resourceUrl(href, 'https://tower.example.invalid').id, 'vm-a');
  }
});
test('an unrelated section edit button cannot edit an internal disk', () => {
  const f = fixture(frame.replace('</aside>', '<main><section><h3>网络设备</h3><button class="edit-icon">编辑</button></section><section class="disk-item"><div id="internal" class="ant-collapse-header" aria-expanded="false">Disk 1</div></section></main></aside>')); selectVm(f.win);
  try { const resource = identifyResource(f.doc.querySelector('#internal'), f.win); const actions = nativeActions(resource, f.win); assert.equal(actions.length, 1); assert.equal(actions[0].label, '展开详情'); } finally { f.dispose(); }
});
test('Tower drawer body devices and tabs can resolve the separate header frame', () => {
  const f = fixture(`<div class="drawer-content-inner"><div class="detail-sidebar-header">${frame}</div><div class="detail-tabs"><span class="tab-item">事件</span></div><section><header>磁盘<button class="edit-icon">编辑</button></header><div class="disk-item"><div class="ant-collapse-header" id="internal">Disk 1</div></div></section></div>${row}`); selectVm(f.win);
  try { const resource = identifyResource(f.doc.querySelector('#internal'), f.win); assert.equal(resource.internal, 'vmDisk'); assert.ok(nativeActions(resource, f.win).some(value => value.label === '编辑磁盘配置…')); const vm = identifyResource(f.doc.querySelector('#target'), f.win); assert.ok(nativeActions(vm, f.win).some(value => value.label === '事件')); } finally { f.dispose(); }
});
test('keyboard opening, arrow navigation and Escape restore focus', () => {
  const f = fixture(row); try { const target = f.doc.querySelector('#target'); target.focus(); target.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    const buttons = items(f); assert.equal(f.doc.activeElement, buttons[0]); f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); assert.equal(f.doc.activeElement, buttons[1]); f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(f.doc.querySelector('[role="menu"]'), null); assert.equal(f.doc.activeElement, target);
  } finally { f.dispose(); }
});
test('stop is idempotent and removes menus, style and listeners', () => {
  const f = fixture(row); try { open(f); f.stop(); f.stop(); assert.equal(f.doc.querySelector('[role="menu"]'), null); assert.equal(f.doc.querySelector('style'), null); assert.equal(open(f).defaultPrevented, false); } finally { f.dispose(); }
});
test('long resource names are rendered as text, never HTML', () => {
  const f = fixture(row); try { f.doc.querySelector('#target').textContent = '<img src=x onerror=alert(1)>'; open(f); assert.equal(f.doc.querySelector('[role="menu"] img'), null); } finally { f.dispose(); }
});
test('menu is clamped at viewport edges', () => {
  assert.deepEqual(clampPosition(990, 790, 280, 300, 1000, 800), { x: 712, y: 492 }); assert.deepEqual(clampPosition(-1, -1, 280, 300, 1000, 800), { x: 8, y: 8 });
});
test('draft changes do not affect active settings until confirmed save; failure keeps draft', async () => {
  const f = fixture(); let saved = defaults(), fail = true;
  const store = createConfigurationStore(f.win, { load: async () => ({ revision: 1, updatedAt: null, settings: saved }), save: async candidate => { if (fail) throw new Error('failed'); saved = candidate; return { revision: 2, updatedAt: null, settings: saved }; } }, configuration);
  try { await store.load(); store.update({ enabled: false }); assert.equal(store.get().enabled, true); assert.equal(await store.save(), false); assert.equal(store.status().dirty, true); fail = false; assert.equal(await store.save(), true); assert.equal(store.get().enabled, false); } finally { store.dispose(); f.dispose(); }
});
