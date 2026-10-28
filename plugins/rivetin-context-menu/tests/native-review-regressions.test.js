import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ownedNativePopup } from '../src/native/popup.js';
import { createNativeActionProvider } from '../src/native/provider.js';
import { installNativeResourceMenu } from '../src/native/resource-menu.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
function fixture(t, html, hash = '#/vms/vm-a?view=%22detail%22') {
  const dom = new JSDOM(html, { url: 'https://tower.example.invalid/' + hash });
  const win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = () => [{ width: 120, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 20, top: 20, right: 140, bottom: 50, width: 120, height: 30 });
  win.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  const cleanup = []; t.after(() => { cleanup.forEach(fn => fn()); win.close(); }); return { win, doc, cleanup };
}

test('explicit popup control reference cannot fall back to an unrelated nearby popup', t => {
  const { win, doc } = fixture(t, '<button class="ant-dropdown-open" aria-controls="owned">Edit</button><div id="unrelated" class="ant-dropdown"><ul role="menu"><li role="menuitem">Edit HA</li></ul></div>');
  assert.equal(ownedNativePopup(win, doc.querySelector('button'), new Set()), null);
});
test('an explicit popup relation still requires a public opened state on its exact trigger', t => {
  const { win, doc } = fixture(t, '<button aria-controls="owned">Edit</button><div id="owned" class="ant-dropdown"><ul role="menu"><li role="menuitem">Edit HA</li></ul></div>');
  assert.equal(ownedNativePopup(win, doc.querySelector('button'), new Set()), null);
});
for (const inactiveDetails of [false, true]) test(`failed native lookup cleans its owned toolbar menu, same-URL details navigation=${inactiveDetails}`, async t => {
  const { win, doc, cleanup } = fixture(t, '<aside class="drawer-content-inner" data-resource-id="vm-a"><div class="title-wrapper"><span class="header-title">VM A</span></div><div class="toolbar"><button class="ant-dropdown-trigger">编辑<svg data-testid="EditPen16BlueIcon"></svg></button></div></aside><div id="owned" class="ant-dropdown ant-dropdown-hidden" hidden><ul role="menu"><li role="menuitem">Unrelated entry</li></ul></div>');
  const trigger = doc.querySelector('button'), popup = doc.getElementById('owned'); let clicks = 0;
  if (inactiveDetails) doc.querySelector('aside').insertAdjacentHTML('beforeend', '<div class="detail-tabs"><button class="tab-item">详情</button></div>');
  trigger.onclick = () => { clicks++; popup.hidden = !popup.hidden; popup.classList.toggle('ant-dropdown-hidden', popup.hidden); trigger.classList.toggle('ant-dropdown-open', !popup.hidden); };
  const provider = createNativeActionProvider({ win, timeoutMs: 180 }); cleanup.push(() => provider.stop());
  const resource = { type: 'vm', id: 'vm-a', name: 'VM A' }; provider.bindSource(doc.querySelector('.header-title')); const data = provider.read(resource);
  assert.equal((await provider.open({ resource, actionId: 'vm.availability.ha', snapshot: data.snapshot })).status, 'unsupported');
  assert.equal(popup.hidden, true); assert.equal(clicks, 2, 'one open plus exact owned-trigger close');
});
test('a cancelled popover opening falls back by removing its hidden popover attribute', async t => {
  const { win, doc, cleanup } = fixture(t, '<table><tr data-row-key="host-a"><td unique="name">Host A</td></tr></table>', '#/clusters/cluster-a?view=%22hosts%22');
  win.HTMLElement.prototype.showPopover = function () { /* Host beforetoggle can cancel without throwing. */ };
  const matches = win.Element.prototype.matches;
  win.Element.prototype.matches = function (selector) { return selector === ':popover-open' ? false : matches.call(this, selector); };
  const adapter = { async prepare() { return { tree: [{ id: 'opaque', label: 'Edit' }], execute() {}, close() {} }; } };
  const menu = installNativeResourceMenu({ win, adapter }); cleanup.push(() => menu.stop());
  menu.open({ type: 'host', id: 'host-a', name: 'Host A', element: doc.querySelector('tr') }, 20, 20);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const root = doc.querySelector('[data-rivetin-resource-menu]'); assert.ok(root); assert.equal(root.hasAttribute('popover'), false);
});
test('resource preparation cannot mount its menu into an old detached host boundary', async t => {
  const { win, doc, cleanup } = fixture(t, '<table><tr data-row-key="host-a"><td unique="name">Host A</td></tr></table><aside class="drawer-content-inner"></aside>', '#/clusters/cluster-a?view=%22hosts%22');
  const oldBoundary = doc.querySelector('aside');
  const adapter = { async prepare() { oldBoundary.remove(); return { tree: [{ id: 'opaque', label: 'Edit' }], execute() {}, close() {} }; } };
  const menu = installNativeResourceMenu({ win, adapter }); cleanup.push(() => menu.stop());
  menu.open({ type: 'host', id: 'host-a', name: 'Host A', element: doc.querySelector('tr') }, 20, 20);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(oldBoundary.querySelector('[data-rivetin-resource-menu]'), null, 'must cancel or resolve a fresh connected boundary');
});
test('an externally removed rendered resource menu releases its native session', async t => {
  const { win, doc, cleanup } = fixture(t, '<table><tr data-row-key="host-a"><td unique="name">Host A</td></tr></table>', '#/clusters/cluster-a?view=%22hosts%22');
  let closed = 0;
  const adapter = { async prepare() { return { tree: [{ id: 'opaque', label: 'Edit' }], execute() {}, close() { closed++; } }; } };
  const menu = installNativeResourceMenu({ win, adapter }); cleanup.push(() => menu.stop());
  menu.open({ type: 'host', id: 'host-a', name: 'Host A', element: doc.querySelector('tr') }, 20, 20);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  doc.querySelector('[data-rivetin-resource-menu]').remove();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(closed, 1);
});
