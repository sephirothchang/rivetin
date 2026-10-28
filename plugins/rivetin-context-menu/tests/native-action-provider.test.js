import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNativeActionProvider } from '../src/native/provider.js';
import { NATIVE_ACTION_CATALOG } from '../src/native/catalog.js';
import { nativeIntent } from '../src/native/controls.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const sourceUrl = 'https://tower.example.invalid/#/clusters/example-cluster?view=%22vms%22';
const detailUrl = id => 'https://tower.example.invalid/#/vms/' + id + '?view=%22detail%22';
const resource = { type: 'vm', id: 'vm-a', name: 'Untrusted display name' };
const supportedActions = new Set(NATIVE_ACTION_CATALOG.flatMap(group => group.items).filter(item => nativeIntent(item.id)).map(item => item.id));
function fixture(t, { anchor = false, historyAvailable = true, nativePane = true, atDetails = false } = {}) {
  const label = anchor ? `<a href="${detailUrl('vm-a')}" id="source">Same VM name</a>` : '<span id="source">Same VM name</span>';
  const dom = new JSDOM(`<table><tbody><tr data-row-key="vm-a"><td unique="name" id="name-a">${label}</td><td unique="_action_"><button id="more">更多</button></td></tr><tr data-row-key="vm-b"><td unique="name" id="name-b">Same VM name</td></tr></tbody></table><aside class="frame"><div class="title-wrapper"><span class="header-title">Same VM name</span></div><div class="toolbar"><button id="power">关机</button><button id="edit">编辑</button><button id="console">打开终端</button></div><div class="detail-tabs"><button class="tab-item" id="snapshots">快照</button></div></aside>`, { url: atDetails ? detailUrl('vm-a') : sourceUrl });
  const win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  const counts = { navigate: 0, business: 0, entry: 0, finalSubmit: 0, tabs: 0, network: 0, token: 0, execute: 0, choices: 0, task: 0, unsubscribed: 0 };
  let historyCallback = null, enabled = true, locale = 'zh-CN';
  const hostHistory = { listen(callback) { historyCallback = callback; return () => { counts.unsubscribed++; historyCallback = null; }; } };
  const guides = [], errors = [];
  function renderPane() {
    if (!nativePane) return;
    const pane = doc.createElement('aside'); pane.className = 'drawer-content-inner';
    if (atDetails) pane.setAttribute('data-resource-id', 'vm-a');
    pane.innerHTML = '<div class="frame"><div class="title-wrapper"><span class="header-title">Same VM name</span></div><div class="toolbar"><button id="power">关机</button><button id="edit">编辑</button><button id="console">打开终端</button><button id="migrate" title="迁移"><span data-testid="Migrate16GradientBlueIcon"></span>迁移</button></div><div class="detail-tabs"><button class="tab-item active" id="details">详情</button><button class="tab-item" id="snapshots">快照</button></div><h3>基本信息<span class="extra-action"><button class="edit-icon" data-entry="basic">编辑</button></span></h3><h3>磁盘<span class="extra-action"><button class="edit-icon" data-entry="disk">编辑</button></span></h3><h3>网络设备<span class="extra-action"><button class="edit-icon" data-entry="nic">编辑</button></span></h3></div>';
    (doc.querySelector('.drawer-content-inner') || doc.querySelector('aside.frame'))?.replaceWith(pane);
    function modal(intent) {
      counts.entry++;
      const titles = { basic: ['编辑虚拟机', 'Edit VM'], disk: ['编辑磁盘', 'Edit disks'], nic: ['编辑虚拟机的网络设备', 'Edit network devices'], migration: ['迁移虚拟机', 'Migrate VM'] };
      const native = doc.createElement('div'); native.className = 'ant-modal';
      const heading = doc.createElement('div'); heading.className = 'ant-modal-title'; heading.textContent = titles[intent][locale === 'en-US' ? 1 : 0];
      const submit = doc.createElement('button'); submit.textContent = 'Native final submit'; submit.onclick = () => counts.finalSubmit++;
      native.append(heading, submit); doc.body.append(native);
    }
    for (const node of pane.querySelectorAll('[data-entry]')) node.onclick = () => modal(node.dataset.entry);
    pane.querySelector('#migrate').onclick = () => modal('migration');
    for (const id of ['power', 'edit', 'console']) pane.querySelector('#' + id).onclick = () => counts.business++;
    for (const view of ['snapshot', 'detail']) pane.querySelector(view === 'snapshot' ? '#snapshots' : '#details').onclick = event => {
      counts.tabs++; pane.querySelectorAll('.tab-item').forEach(tab => tab.classList.remove('active')); event.currentTarget.classList.add('active');
      win.history.replaceState({}, '', detailUrl('vm-a').replace('%22detail%22', `%22${view}%22`)); historyCallback?.();
    };
    return pane;
  }
  renderPane();
  const navigate = event => {
    event.preventDefault(); counts.navigate++;
    win.history.replaceState({}, '', detailUrl('vm-a'));
    renderPane();
    historyCallback?.();
  };
  doc.querySelector(anchor ? '#source' : '#name-a').addEventListener('click', navigate);
  doc.getElementById('more').addEventListener('click', () => counts.business++);
  if (!nativePane) {
    for (const id of ['power', 'edit', 'console']) doc.getElementById(id).addEventListener('click', () => counts.business++);
    doc.getElementById('snapshots').addEventListener('click', () => counts.tabs++);
  }
  win.addEventListener('hashchange', () => { if (win.location.href === detailUrl('vm-a')) renderPane(); });
  win.fetch = () => { counts.network++; throw new Error('FETCH_MUST_NOT_RUN'); };
  Object.defineProperty(win.Storage.prototype, 'getItem', { value() { counts.token++; throw new Error('TOKEN_MUST_NOT_BE_READ'); } });
  Object.defineProperty(doc.getElementById('source'), '__reactFiber$private', { get() { throw new Error('PRIVATE_REACT_MUST_NOT_BE_READ'); } });
  const bridge = { execute() { counts.execute++; throw new Error('EXECUTE_MUST_NOT_RUN'); }, choices() { counts.choices++; throw new Error('CHOICES_MUST_NOT_RUN'); }, task() { counts.task++; throw new Error('TASK_MUST_NOT_RUN'); } };
  const provider = createNativeActionProvider({ win, history: historyAvailable ? hostHistory : undefined, getLocale: () => locale,
    isEnabled: () => enabled, onGuide: message => guides.push(message), onError: message => errors.push(message), timeoutMs: 100, bridge });
  t.after(() => { provider.stop(); win.close(); });
  const bind = (selector = '#source') => provider.bindSource(doc.querySelector(selector));
  const read = () => provider.read(resource);
  const open = (data, actionId = 'vm.hardware.cpu', extra = {}) => provider.open({ resource, actionId, snapshot: data.snapshot, ...extra });
  return { win, doc, provider, counts, guides, errors, bind, read, open,
    setEnabled(value) { enabled = value; }, setLocale(value) { locale = value; }, notifyHistory() { historyCallback?.(); } };
}

test('read and tree expose only verified native entry intents, never authorization or status facts', t => {
  const f = fixture(t); assert.equal(f.bind(), true);
  const data = f.read();
  assert.equal(f.provider.kind, 'native-ui'); assert.equal(f.provider.handoffBeforeOpen, true);
  assert.deepEqual(data.snapshot, { type: 'vm', id: 'vm-a', name: 'Same VM name', status: 'UNKNOWN' });
  assert.deepEqual(data.capabilities, {}); assert.equal(data.native.canNavigate, true);
  assert.ok(Object.isFrozen(data.snapshot));
  const tree = f.provider.tree({ resource, data });
  assert.ok(tree.length > 0); assert.ok(tree.flatMap(group => group.items).every(item => item.enabled === supportedActions.has(item.id) && item.mutation === false && item.operation === null));
  assert.equal(f.counts.network + f.counts.token + f.counts.execute + f.counts.choices + f.counts.task, 0);
});

test('an unbound source cannot manufacture navigation even with forged data.canNavigate', async t => {
  const f = fixture(t), data = f.read();
  assert.equal(data.native.canNavigate, false);
  assert.equal((await f.open({ snapshot: { type: 'vm', id: 'vm-a', status: 'UNKNOWN' }, native: { canNavigate: true } })).status, 'unsupported');
  assert.equal(f.counts.navigate, 0);
});

test('a supported action navigates once and reports success only after a new native dialog appears', async t => {
  const f = fixture(t); f.bind(); const data = f.read();
  assert.deepEqual(await f.open(data), { status: 'opened', surface: 'dialog' });
  assert.equal(f.counts.navigate, 1); assert.equal(f.win.location.href, detailUrl('vm-a'));
  assert.ok(f.doc.querySelector('.ant-modal-title').textContent.includes('编辑虚拟机')); assert.equal(f.guides.length, 0);
  assert.equal(f.counts.entry, 1); assert.equal(f.counts.finalSubmit + f.counts.business + f.counts.tabs, 0);
  assert.equal((await f.open(data)).status, 'unsupported', 'one attested menu cannot replay a navigation');
});

test('same-name objects are never used as an identity fallback', async t => {
  const f = fixture(t); f.bind(); const data = f.read();
  assert.equal((await f.open(data, 'vm.hardware.cpu', { resource: { type: 'vm', id: 'vm-b', name: 'Same VM name' } })).status, 'unsupported');
  assert.equal(f.counts.navigate, 0);
});

test('already-open exact details can select the native snapshot tab without a configuration or submit click', async t => {
  const f = fixture(t, { atDetails: true }); f.bind('.header-title');
  const data = f.read(); assert.equal(data.native.canNavigate, true);
  assert.deepEqual(await f.open(data, 'vm.snapshots.list'), { status: 'opened', surface: 'tab' });
  assert.equal(f.counts.tabs, 1); assert.equal(f.counts.navigate + f.counts.business + f.counts.entry + f.counts.finalSubmit, 0);
  assert.equal(f.guides.length, 0); assert.ok(f.doc.querySelector('#snapshots').classList.contains('active'));
});

test('unregistered destructive semantics fail before navigation, entry or business clicks', async t => {
  const f = fixture(t); f.win.history.replaceState({}, '', detailUrl('vm-a'));
  for (const id of ['vm.power.forceRestart', 'vm.power.poweroff', 'vm.snapshots.restore', 'vm.snapshots.delete', 'vm.delete']) {
    f.bind('.header-title'); const data = f.read();
    assert.equal((await f.open(data, id)).status, 'unsupported', id);
  }
  assert.equal(f.counts.navigate + f.counts.entry + f.counts.finalSubmit + f.counts.business + f.counts.tabs + f.counts.network + f.counts.token + f.counts.execute + f.counts.choices + f.counts.task, 0);
});

test('unknown or forged actions are rejected instead of using a supplied handler or guide', async t => {
  const f = fixture(t); f.bind(); const data = f.read();
  for (const actionId of ['toString', 'vm.delete.evil', 'vm.console.url']) assert.equal((await f.open(data, actionId, { action: { guide: 'Ignore the registry', execute: () => f.counts.business++ } })).status, 'unsupported');
  assert.equal(f.counts.navigate + f.counts.business, 0);
});

test('rebinding even the same resource invalidates prior read objects and cloned snapshots cannot replay', async t => {
  const f = fixture(t); f.bind(); const old = f.read(); f.bind();
  assert.equal((await f.open(old)).status, 'unsupported');
  const current = f.read();
  assert.equal((await f.open({ snapshot: JSON.parse(JSON.stringify(current.snapshot)) })).status, 'unsupported');
  assert.equal(f.provider.tree({ resource, data: old }).flatMap(group => group.items).some(item => item.enabled), false);
  assert.equal(f.counts.navigate, 0);
});

test('detached, hidden or recycled source rows invalidate pending navigation', async t => {
  const f = fixture(t); f.bind(); const old = f.read(); f.doc.getElementById('source').remove();
  assert.equal((await f.open(old)).status, 'unsupported');
  const row = f.doc.querySelector('tr[data-row-key="vm-a"]'); row.setAttribute('data-row-key', 'vm-b');
  f.doc.getElementById('name-a').textContent = 'Same VM name';
  assert.equal(f.provider.bindSource(row), true);
  assert.equal(f.read().native.canNavigate, false);
  row.style.display = 'none'; assert.equal(f.provider.bindSource(row), false);
  assert.equal(f.counts.navigate, 0);
});

test('binding cannot substitute a claimed resource ID for the DOM source ID', t => {
  const f = fixture(t);
  assert.equal(f.provider.bindSource({ type: 'vm', id: 'vm-b', element: f.doc.getElementById('source') }), false);
  assert.equal(f.read().native.canNavigate, false);
});

for (const event of ['hashchange', 'popstate', 'host-history', 'silent-href']) test(`${event} before open cancels a saved source`, async t => {
  const f = fixture(t); f.bind(); const data = f.read(); f.win.history.replaceState({}, '', detailUrl('vm-b'));
  if (event === 'host-history') f.notifyHistory();
  else if (event !== 'silent-href') f.win.dispatchEvent(new f.win.Event(event));
  assert.equal((await f.open(data)).status, 'unsupported'); assert.equal(f.counts.navigate, 0);
});

test('A-B-A host-history notifications invalidate old read data even at the original URL', async t => {
  const f = fixture(t); f.bind(); const data = f.read();
  f.win.history.replaceState({}, '', detailUrl('vm-b')); f.notifyHistory();
  f.win.history.replaceState({}, '', sourceUrl); f.notifyHistory();
  assert.equal((await f.open(data)).status, 'unsupported'); assert.equal(f.counts.navigate, 0);
});

for (const cancellation of ['close', 'stop', 'disable', 'abort', 'route']) test(`${cancellation} during pending handoff does not click any official control`, async t => {
  const f = fixture(t); f.bind(); const data = f.read(), controller = new AbortController();
  const pending = f.provider.open({ resource, actionId: 'vm.hardware.memory', snapshot: data.snapshot }, { signal: controller.signal });
  if (cancellation === 'close') f.provider.close();
  if (cancellation === 'stop') f.provider.stop();
  if (cancellation === 'disable') f.setEnabled(false);
  if (cancellation === 'abort') controller.abort();
  if (cancellation === 'route') { f.win.history.replaceState({}, '', detailUrl('vm-b')); f.notifyHistory(); }
  assert.equal((await pending).status, 'cancelled'); assert.equal(f.counts.navigate + f.counts.business, 0);
});

test('the context menu must be unmounted before the native click is dispatched', async t => {
  const f = fixture(t); f.bind(); const data = f.read(), menu = f.doc.createElement('div'); menu.setAttribute('data-rivetin-context-menu', ''); f.doc.body.append(menu);
  assert.equal((await f.open(data)).status, 'unsupported'); assert.equal(f.counts.navigate, 0);
  menu.remove(); assert.equal((await f.open(data)).status, 'opened'); assert.equal(f.counts.navigate, 1);
});

test('the object action menu also blocks handoff until it is unmounted', async t => {
  const f = fixture(t); f.bind(); const data = f.read(), menu = f.doc.createElement('div'); menu.setAttribute('data-rivetin-object-menu', ''); f.doc.body.append(menu);
  assert.equal((await f.open(data)).status, 'unsupported'); assert.equal(f.counts.navigate, 0);
  menu.remove(); assert.equal((await f.open(data)).status, 'opened'); assert.equal(f.counts.navigate, 1);
});

test('asynchronous own hash navigation opens a native dialog without a fallback guide or final submit', { timeout: 2000 }, async t => {
  const f = fixture(t, { anchor: true }); f.doc.getElementById('source').target = '_blank'; f.bind();
  const changed = new Promise(resolve => f.win.addEventListener('hashchange', resolve, { once: true }));
  assert.equal((await f.open(f.read())).status, 'opened');
  await changed;
  assert.equal(f.counts.navigate + f.counts.business + f.counts.finalSubmit, 0); assert.equal(f.counts.entry, 1); assert.equal(f.guides.length, 0);
  const dialog = f.doc.querySelector('.ant-modal'); assert.ok(dialog);
  f.win.history.replaceState({}, '', detailUrl('vm-b')); f.notifyHistory();
  assert.equal(dialog.isConnected, true, 'plugin route cleanup must not close a native dialog');
});

test('a verified link cannot turn a console button without verified icon semantics into success', async t => {
  const f = fixture(t, { anchor: true }); assert.equal(f.bind(), true);
  assert.equal((await f.open(f.read(), 'vm.console.open')).status, 'unsupported');
  assert.equal(f.counts.navigate, 1); assert.equal(f.counts.business + f.counts.entry + f.counts.finalSubmit, 0); assert.equal(f.guides.length, 0);
});

test('changed cross-origin or action-shaped links cannot become automatic navigation', async t => {
  const f = fixture(t, { anchor: true }); f.bind(); const old = f.read();
  f.doc.getElementById('source').href = 'https://other.example.invalid/#/vms/vm-a?view=%22detail%22';
  assert.equal((await f.open(old)).status, 'unsupported');
  f.doc.getElementById('source').href = detailUrl('vm-a') + '&action=poweroff';
  f.bind(); assert.equal(f.read().native.canNavigate, false);
  assert.equal((await f.open(f.read())).status, 'unsupported'); assert.equal(f.counts.navigate + f.counts.business, 0);
});

test('native buttons or more triggers inside rows are not treated as read-only name selections', async t => {
  const f = fixture(t); f.bind('#more'); const data = f.read();
  // identifyResource may recognize the row, but its navigation is still the
  // exact readonly name cell, never the bound more/power button itself.
  const result = await f.open(data);
  assert.ok(['opened', 'unsupported'].includes(result.status));
  assert.equal(f.counts.business, 0);
});

test('close never closes an official dialog or changes the official page', async t => {
  const f = fixture(t); f.bind(); await f.open(f.read());
  const href = f.win.location.href, dialog = f.doc.querySelector('.ant-modal'); assert.ok(dialog);
  f.provider.close(); assert.equal(f.guides.length, 0); assert.equal(dialog.isConnected, true); assert.equal(f.win.location.href, href); assert.equal(f.counts.finalSubmit, 0);
});

test('locale follows the host and stop disposes history exactly once without monkey-patching public history', async t => {
  const f = fixture(t), push = f.win.history.pushState, replace = f.win.history.replaceState;
  f.setLocale('en-US'); f.bind(); assert.equal((await f.open(f.read(), 'vm.hardware.memory')).status, 'opened');
  assert.equal(f.doc.querySelector('.ant-modal-title').textContent, 'Edit VM'); assert.equal(f.guides.length, 0);
  f.provider.stop(); f.provider.stop(); assert.equal(f.counts.unsubscribed, 1);
  assert.equal(f.win.history.pushState, push); assert.equal(f.win.history.replaceState, replace);
  assert.equal(f.bind(), false);
});

test('without host history, a changed exact href still rejects stale source data', async t => {
  const f = fixture(t, { historyAvailable: false }); f.bind(); const data = f.read();
  f.win.history.replaceState({}, '', detailUrl('vm-b'));
  assert.equal((await f.open(data)).status, 'unsupported'); assert.equal(f.counts.navigate, 0);
});

test('clicking an official selector with no verifiable destination does not report a business success or retry', async t => {
  const f = fixture(t); f.doc.getElementById('name-a').replaceWith(f.doc.getElementById('name-a').cloneNode(true));
  f.bind(); const result = await f.open(f.read());
  assert.equal(result.status, 'unsupported'); assert.equal(f.guides.length, 0); assert.equal(f.counts.business, 0);
});

test('navigation without a new verifiable native pane never reports opened or falls back to a guide', async t => {
  const f = fixture(t, { nativePane: false }); f.bind(); const result = await f.open(f.read());
  assert.equal(result.status, 'unsupported'); assert.equal(f.counts.navigate, 1);
  assert.equal(f.counts.entry + f.counts.finalSubmit + f.counts.business, 0); assert.equal(f.guides.length, 0); assert.ok(f.errors.length > 0);
});

for (const actionId of ['vm.general.edit', 'vm.hardware.memory', 'vm.hardware.disk.add', 'vm.hardware.nic.edit', 'vm.migration.withinCluster']) test(`${actionId} opens the unique native entry dialog and leaves submission to the user`, async t => {
  const f = fixture(t); f.bind(); const result = await f.open(f.read(), actionId);
  assert.deepEqual(result, { status: 'opened', surface: 'dialog' }); assert.equal(f.counts.entry, 1);
  assert.equal(f.doc.querySelectorAll('.ant-modal').length, 1); assert.equal(f.counts.finalSubmit + f.counts.business, 0);
  assert.equal(f.counts.network + f.counts.token + f.counts.execute + f.counts.choices + f.counts.task, 0); assert.equal(f.guides.length, 0);
});
