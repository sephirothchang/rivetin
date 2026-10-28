import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNativeActionProvider } from '../src/native/provider.js';
import { findNativeControl } from '../src/native/controls.js';
import { nativeErrorMessage } from '../src/native/errors.js';
import { installObjectActionMenu } from '../src/actions/menu.js';
import { identifyResource } from '../src/resources.js';

const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await pause(2);
  assert.ok(predicate(), 'expected local fixture event did not occur before the bounded deadline');
}
const resource = { type: 'vm', id: 'vm-a', name: 'VM A' };
function fixture(t, { popupAfterNavigate = false, preparePane = () => {} } = {}) {
  const dom = new JSDOM('<table><tbody><tr data-row-key="vm-a"><td unique="name">VM A</td><td unique="_action_"><button class="menu-button ant-dropdown-trigger">更多</button></td></tr></tbody></table>', { url: 'https://tower.example.invalid/#/clusters/cluster-a?view=%22vms%22' });
  const win = dom.window, doc = win.document, source = doc.querySelector('td[unique="name"]'), row = source.closest('tr');
  win.HTMLElement.prototype.getClientRects = () => [{ width: 180, height: 30 }];
  win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 180, height: 30, right: 190, bottom: 40 });
  win.fetch = () => { throw new Error('NO_BUSINESS_TRANSPORT'); };
  const listeners = new Set(), errors = [], counts = { navigation: 0, menu: 0, tab: 0, entry: 0, submit: 0 };
  const history = { listen(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  let pane;
  source.onclick = () => {
    counts.navigation++; row.classList.add('active-row');
    win.history.replaceState({}, '', '#/clusters/cluster-a?view=%22vms%22&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' })));
    for (const notify of listeners) notify();
    pane = doc.createElement('aside'); pane.className = 'drawer-content-inner'; pane.dataset.resourceId = 'vm-a';
    pane.innerHTML = '<div class="title-wrapper"><span class="header-title">VM A</span></div><div class="toolbar"><button class="ant-dropdown-trigger"><svg data-testid="EditPen16BlueIcon"></svg>编辑</button></div><div class="detail-tabs"><button class="tab-item active">详情</button><button class="tab-item">快照</button></div><h3>基本信息<span class="extra-action"><button class="edit-icon">编辑</button></span></h3>';
    pane.querySelector('.toolbar button').onclick = () => counts.menu++;
    pane.querySelectorAll('.tab-item')[1].onclick = () => counts.tab++;
    pane.querySelector('.edit-icon').onclick = () => counts.entry++;
    preparePane(pane);
    doc.body.append(pane);
    if (popupAfterNavigate) { const popup = doc.createElement('div'); popup.className = 'ant-dropdown'; popup.textContent = 'An unrelated host popup'; doc.body.append(popup); }
  };
  doc.querySelector('td[unique="_action_"] button').onclick = event => { event.stopPropagation(); counts.menu++; };
  const provider = createNativeActionProvider({ win, history, timeoutMs: 300, onError: message => errors.push(message) });
  t.after(() => { provider.stop(); win.close(); });
  function open(actionId, options) { provider.bindSource(source); const data = provider.read(resource); return provider.open({ resource, actionId, snapshot: data.snapshot }, options); }
  return { win, doc, provider, source, counts, errors, open, get pane() { return pane; } };
}

test('untrusted diagnostic values never leak HTML, internal paths, URLs or exception messages', () => {
  const secret = 'EXAMPLE_PRIVATE_DIAGNOSTIC';
  for (const reason of [secret, new Error(secret), { reason: secret }, '<img src=x onerror=alert(1)>', 'https://private.example.invalid/' + secret, '__proto__']) {
    for (const locale of ['zh-CN', 'en-US']) {
      const text = nativeErrorMessage(reason, locale);
      assert.ok(text.endsWith('(unexpected)')); assert.ok(!text.includes(secret)); assert.ok(!text.includes('<img'));
    }
  }
});

test('an unrelated popup blocking a correct single target pane reports obstruction rather than identity mismatch', async t => {
  const f = fixture(t, { popupAfterNavigate: true }), result = await f.open('vm.hardware.cpu');
  assert.equal(f.pane.dataset.resourceId, 'vm-a'); assert.equal(f.doc.querySelectorAll('.drawer-content-inner').length, 1);
  assert.equal(result.status, 'unsupported'); assert.equal(result.reason, 'blocked-by-dialog');
  assert.equal(f.errors.length, 1); assert.ok(f.errors[0].endsWith('(blocked-by-dialog)'));
  assert.equal(f.counts.entry + f.counts.submit, 0);
});

for (const actionId of ['vm.power.menu', 'vm.availability.ha', 'vm.snapshots.create']) test(`cancelling ${actionId} during its native intermediate wait is cancellation rather than a false timeout failure`, async t => {
  const f = fixture(t), controller = new f.win.AbortController(), pending = f.open(actionId, { signal: controller.signal });
  await until(() => actionId === 'vm.snapshots.create' ? f.counts.tab === 1 : f.counts.menu === 1);
  controller.abort(); const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(f.errors.length, 0);
  assert.equal(f.counts.entry + f.counts.submit, 0);
});

for (const scope of ['pane', 'menu']) test(`diagnostic queries identify inherited ${scope} disabling with a fixed reason and no clicks`, t => {
  const f = fixture(t); f.source.click(); let menu, intent = 'basic';
  if (scope === 'pane') f.pane.setAttribute('aria-disabled', 'true');
  else {
    intent = 'ha'; menu = f.doc.createElement('div'); menu.className = 'ant-dropdown'; menu.setAttribute('aria-disabled', 'true');
    menu.innerHTML = '<ul role="menu"><li role="menuitem" class="ant-dropdown-menu-item"><svg data-testid="EditPen24GradientBlueIcon"></svg>编辑高可用</li></ul>'; f.doc.body.append(menu);
  }
  const before = f.doc.body.innerHTML, counts = { ...f.counts };
  assert.equal(findNativeControl({ win: f.win, pane: f.pane, intent, menu }), null);
  assert.equal(findNativeControl({ win: f.win, pane: f.pane, intent, menu, diagnostic: true }), 'entry-disabled');
  assert.equal(f.doc.body.innerHTML, before); assert.deepEqual(f.counts, counts);
});

test('an exception after object-menu handoff is reported once with fixed diagnostics instead of disappearing with its closed session', async t => {
  const f = fixture(t), errors = [], provider = { kind: 'native-ui', handoffBeforeOpen: true,
    read() { return { snapshot: { type: 'vm', id: 'vm-a' } }; },
    tree() { return [{ id: 'vm.hardware', label: 'Hardware', items: [{ id: 'vm.hardware.cpu', label: 'CPU', enabled: true }] }]; },
    async open() { throw new Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); },
  };
  const menu = installObjectActionMenu({ win: f.win, provider, onError: value => errors.push(value) });
  t.after(() => menu.stop());
  assert.equal(menu.open(identifyResource(f.source, f.win), 30, 30), true);
  await until(() => Boolean(f.doc.querySelector('[data-group-id="vm.hardware"]')));
  f.doc.querySelector('[data-group-id="vm.hardware"]').click();
  await until(() => Boolean(f.doc.querySelector('[data-action-id="vm.hardware.cpu"]')));
  f.doc.querySelector('[data-action-id="vm.hardware.cpu"]').click();
  await pause(20);
  assert.equal(f.doc.querySelector('[data-rivetin-object-menu]'), null);
  assert.equal(errors.length, 1); assert.ok(errors[0].endsWith('(unexpected)')); assert.ok(!errors[0].includes('EXAMPLE_PRIVATE_DIAGNOSTIC'));
});

for (const condition of ['disabled', 'duplicate']) test(`power chooser reports its ${condition} row trigger accurately without clicking it`, async t => {
  const f = fixture(t), trigger = f.doc.querySelector('td[unique="_action_"] button');
  if (condition === 'disabled') trigger.disabled = true; else trigger.parentElement.append(trigger.cloneNode(true));
  const result = await f.open('vm.power.menu');
  assert.equal(result.status, 'unsupported'); assert.equal(result.reason, condition === 'disabled' ? 'entry-disabled' : 'trigger-ambiguous');
  assert.equal(f.counts.menu + f.counts.entry + f.counts.submit, 0);
});

test('a disabled Edit menu opener is distinguished from a missing editor menu', async t => {
  const f = fixture(t, { preparePane(pane) { pane.querySelector('.toolbar button').disabled = true; } });
  const result = await f.open('vm.availability.ha');
  assert.equal(result.status, 'unsupported'); assert.equal(result.reason, 'entry-disabled');
  assert.equal(f.counts.menu + f.counts.entry + f.counts.submit, 0);
});

test('a disabled prerequisite snapshot tab is distinguished from a missing tab', async t => {
  const f = fixture(t, { preparePane(pane) { pane.querySelectorAll('.tab-item')[1].disabled = true; } });
  const result = await f.open('vm.snapshots.create');
  assert.equal(result.status, 'unsupported'); assert.equal(result.reason, 'entry-disabled');
  assert.equal(f.counts.tab + f.counts.entry + f.counts.submit, 0);
});

test('provider-reported failure is presented once when the real object menu has already unmounted', async t => {
  const f = fixture(t, { preparePane(pane) { pane.querySelector('.edit-icon').disabled = true; } });
  const menu = installObjectActionMenu({ win: f.win, provider: f.provider, onError: value => f.errors.push(value) });
  t.after(() => menu.stop());
  assert.equal(menu.open(identifyResource(f.source, f.win), 30, 30), true);
  await until(() => Boolean(f.doc.querySelector('[data-group-id="vm.hardware"]')));
  f.doc.querySelector('[data-group-id="vm.hardware"]').click();
  await until(() => Boolean(f.doc.querySelector('[data-action-id="vm.hardware.cpu"]')));
  f.doc.querySelector('[data-action-id="vm.hardware.cpu"]').click();
  await until(() => f.errors.length > 0); await pause(10);
  assert.equal(f.errors.length, 1); assert.ok(f.errors[0].endsWith('(entry-disabled)'));
  assert.equal(f.doc.querySelector('[data-rivetin-object-menu]'), null);
  assert.equal(f.counts.entry + f.counts.submit, 0);
});
