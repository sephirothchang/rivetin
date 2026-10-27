import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createProductionActionProvider } from '../src/actions/provider.js';
import { buildActionTree } from '../src/actions/catalog.js';

const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await pause(10);
  assert.ok(predicate(), 'expected state did not become observable within the bounded wait');
}
const resource = { type: 'vm', id: 'vm-a', name: 'VM A' };
const operationId = 'a'.repeat(64);
const allowed = ['vm.general.edit', 'vm.power.start', 'vm.power.shutdown', 'vm.power.poweroff', 'vm.power.restart', 'vm.power.forceRestart', 'vm.power.suspend', 'vm.power.resume'];
function fixture(t, { bridgeOptions = {}, locale = 'zh-CN', drawer = false } = {}) {
  const drawerMarkup = '<aside class="drawer-content-inner"><div class="detail-sidebar-header"><div class="frame"><div class="title-wrapper"><span class="header-title">VM A</span></div></div></div><button id="previous">Previous focus</button></aside>';
  const sidebar = drawer ? '&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'detail' })) : '';
  const dom = new JSDOM(drawer ? drawerMarkup : '<button id="previous">Previous focus</button>', {
    url: 'https://tower.example.invalid/' + (drawer ? '#/clusters/cluster-a?view=%22vms%22' + sidebar : '#/vms'),
  });
  const win = dom.window, doc = win.document;
  let enabled = true;
  const pane = doc.querySelector('.drawer-content-inner'), hostCloses = { pointer: 0, click: 0, escape: 0 };
  if (drawer) {
    const closeHost = reason => { if (!pane.isConnected) return; hostCloses[reason]++; pane.remove(); win.history.replaceState({}, '', '#/clusters/cluster-a?view=%22vms%22'); };
    // Registered before the provider: a document-capture listener will run before any later plugin listener.
    doc.addEventListener('pointerdown', event => { if (!pane.contains(event.target)) closeHost('pointer'); }, true);
    doc.addEventListener('click', event => { if (!pane.contains(event.target)) closeHost('click'); });
    doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) closeHost('escape'); });
  }
  const data = {
    snapshot: { id: 'vm-a', name: 'VM A', description: 'Before', status: 'RUNNING', protected: false, internal: false, in_recycle_bin: false, entityAsyncStatus: null },
    capabilities: Object.fromEntries(allowed.map(id => [id, { allowed: true }])),
  };
  const calls = { read: [], execute: [], task: [], order: [] };
  const bridge = {
    async read(target, options) { calls.order.push('read'); calls.read.push({ resource: target, options }); return copy(data); },
    async execute(request, options) { calls.order.push('execute'); calls.execute.push({ request, options }); return { status: 'succeeded', operationId, snapshot: { id: 'vm-a' } }; },
    ...bridgeOptions,
  };
  const provider = createProductionActionProvider({ win, bridge, getLocale: () => locale, isEnabled: () => enabled });
  t.after(() => { provider.stop(); dom.window.close(); });
  const root = () => doc.querySelector('[data-rivetin-action-form]');
  const confirm = () => [...root().querySelectorAll('button')].find(button => button.textContent === (locale === 'en-US' ? 'Confirm operation' : '确认执行'));
  const cancel = () => [...root().querySelectorAll('button')].find(button => ['取消', '关闭', 'Cancel', 'Close'].includes(button.textContent));
  async function request(actionId) {
    const fresh = await provider.read(resource);
    const action = buildActionTree({ resource, ...fresh, locale }).flatMap(group => group.items).find(value => value.id === actionId);
    assert.ok(action); return { resource, actionId, action, snapshot: fresh.snapshot };
  }
  async function open(actionId = 'vm.general.edit') { const value = await request(actionId); assert.equal((await provider.open(value)).status, 'opened'); assert.ok(root().querySelector('[role="dialog"]')); return value; }
  function input(key, value) {
    const control = root().querySelector(`[data-field="${key}"]`); assert.ok(control, `input ${key} must exist`);
    if (control.type === 'checkbox') control.checked = value; else control.value = value;
    control.dispatchEvent(new win.Event('input', { bubbles: true })); return control;
  }
  return { win, doc, provider, data, calls, bridge, root, confirm, cancel, request, open, input, pane, hostCloses,
    disable() { enabled = false; }, status: () => root()?.querySelector('[role="status"]')?.textContent || '' };
}

test('without an injected authenticated bridge no production provider or form is created', () => {
  const dom = new JSDOM('', { url: 'https://tower.example.invalid/' });
  try { for (const bridge of [undefined, {}, { read() {} }, { execute() {} }]) assert.equal(createProductionActionProvider({ win: dom.window, bridge }), null); assert.equal(dom.window.document.body.children.length, 0); } finally { dom.window.close(); }
});

test('production read preserves fresh snapshot and masks unsupported real forms without mutating bridge data', async t => {
  const f = fixture(t); f.data.capabilities['vm.hardware.nic.add'] = { allowed: true };
  const result = await f.provider.read(resource);
  assert.equal(result.snapshot.id, 'vm-a'); assert.equal(result.capabilities['vm.general.edit'].allowed, true);
  assert.equal(result.capabilities['vm.hardware.nic.add'].allowed, false); assert.equal(f.data.capabilities['vm.hardware.nic.add'].allowed, true);
  result.snapshot.name = 'A local mutation'; assert.equal(f.data.snapshot.name, 'VM A');
  assert.equal(f.calls.execute.length, 0); assert.equal(f.root(), null);
});

test('opening and cancelling a changed name/description form never executes or rereads it', async t => {
  const f = fixture(t); f.doc.querySelector('#previous').focus(); await f.open();
  assert.equal(f.root().querySelector('[data-field="name"]').value, 'VM A'); assert.equal(f.root().querySelector('[data-field="description"]').value, 'Before');
  f.input('name', 'Renamed VM'); f.input('description', 'Edited description');
  assert.equal(f.confirm().disabled, false); assert.equal(f.calls.read.length, 1); assert.equal(f.calls.execute.length, 0);
  f.cancel().click(); assert.equal(f.root(), null); assert.equal(f.calls.read.length, 1); assert.equal(f.calls.execute.length, 0); assert.equal(f.doc.activeElement.id, 'previous');
});

test('confirmation freshly reads first and executes exact captured identity/values once', async t => {
  const f = fixture(t); await f.open(); f.input('name', 'Renamed VM'); f.input('description', '');
  const button = f.confirm(); button.click(); button.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true }));
  await until(() => f.status().includes('操作已完成'));
  assert.deepEqual(f.calls.order, ['read', 'read', 'execute']); assert.equal(f.calls.execute.length, 1);
  const submitted = f.calls.execute[0];
  assert.deepEqual(submitted.request.resource, { type: 'vm', id: 'vm-a', name: 'VM A' });
  assert.equal(submitted.request.actionId, 'vm.general.edit'); assert.deepEqual(submitted.request.values, { name: 'Renamed VM', description: '' });
  assert.match(submitted.request.requestId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
  assert.equal(submitted.options.signal.aborted, false); assert.equal(f.calls.read[1].resource.id, 'vm-a');
  assert.ok(Object.isFrozen(submitted.request)); assert.ok(Object.isFrozen(submitted.request.values));
  button.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true })); await pause(10); assert.equal(f.calls.execute.length, 1);
});

test('revoked permission after form open prevents execution on fresh confirmation', async t => {
  const f = fixture(t); await f.open(); f.data.capabilities['vm.general.edit'] = { allowed: false };
  f.confirm().click(); await until(() => f.status().includes('操作失败'));
  assert.equal(f.calls.read.length, 2); assert.equal(f.calls.execute.length, 0); assert.equal(f.confirm().disabled, true);
});

test('changed power state after form open cannot execute a formerly allowed shutdown', async t => {
  const f = fixture(t); await f.open('vm.power.shutdown'); f.data.snapshot.status = 'STOPPED';
  f.confirm().click(); await until(() => f.status().includes('操作失败'));
  assert.equal(f.calls.read.length, 2); assert.equal(f.calls.execute.length, 0);
});

test('a fresh read belonging to another VM is rejected without any execute call', async t => {
  const f = fixture(t); await f.open(); f.data.snapshot.id = 'vm-b';
  f.confirm().click(); await until(() => f.status().includes('操作失败'));
  assert.equal(f.calls.execute.length, 0); assert.ok(f.status().includes('RESOURCE_ID_MISMATCH'));
});

test('dangerous power operations require the exact displayed resource name', async t => {
  const f = fixture(t); await f.open('vm.power.poweroff');
  const name = f.root().querySelector('input[aria-label="对象名称确认"]'); assert.ok(name); assert.equal(f.confirm().disabled, true);
  for (const wrong of ['', 'vm a', 'VM A ']) { name.value = wrong; name.dispatchEvent(new f.win.Event('input', { bubbles: true })); assert.equal(f.confirm().disabled, true); }
  assert.equal(f.calls.execute.length, 0);
  name.value = 'VM A'; name.dispatchEvent(new f.win.Event('input', { bubbles: true })); assert.equal(f.confirm().disabled, false);
  f.confirm().click(); await until(() => f.status().includes('操作已完成'));
  assert.equal(f.calls.execute.length, 1); assert.equal(f.calls.execute[0].request.actionId, 'vm.power.poweroff'); assert.deepEqual(f.calls.execute[0].request.values, {});
});

test('tracking a running result keeps one submission and correlates the eventual task result', async t => {
  const f = fixture(t); f.bridge.execute = async (request, options) => { f.calls.execute.push({ request, options }); return { status: 'running', operationId, taskId: 'task-a' }; };
  f.bridge.task = async (id, options) => { f.calls.task.push({ operationId: id, options }); return { status: 'succeeded', operationId, taskId: 'task-a', snapshot: { id: 'vm-a' } }; };
  await f.open(); f.confirm().click();
  await until(() => f.calls.execute.length === 1); assert.equal(f.confirm().disabled, true);
  await until(() => f.status().includes('操作已完成'), 2500);
  assert.equal(f.calls.execute.length, 1); assert.equal(f.calls.task.length, 1); assert.equal(f.calls.task[0].operationId, operationId); assert.ok(f.root().textContent.includes('task-a'));
});

test('an accepted running result without tracking is unconfirmed and never resubmitted', async t => {
  const f = fixture(t); f.bridge.execute = async (request, options) => { f.calls.execute.push({ request, options }); return { status: 'running', operationId, taskId: 'task-a' }; };
  await f.open(); f.confirm().click(); await until(() => f.status().includes('操作结果尚未确认'));
  assert.ok(f.status().includes('TRACKING_UNCONFIRMED')); assert.ok(f.root().textContent.includes('task-a'));
  f.confirm().dispatchEvent(new f.win.MouseEvent('click', { bubbles: true })); await pause(10); assert.equal(f.calls.execute.length, 1);
});

test('transport error text cannot leak into the form', async t => {
  const f = fixture(t); const sensitive = 'EXAMPLE_SENSITIVE_DIAGNOSTIC';
  f.bridge.execute = async (request, options) => { f.calls.execute.push({ request, options }); throw new Error(sensitive + ' /private/example/token'); };
  await f.open(); f.confirm().click(); await until(() => f.status().includes('操作结果尚未确认'));
  assert.ok(!f.doc.body.textContent.includes(sensitive)); assert.ok(!f.doc.body.textContent.includes('/private/example/token')); assert.equal(f.calls.execute.length, 1);
});

test('bridge response messages and invalid public error fields are not rendered as diagnostics', async t => {
  const sensitive = 'EXAMPLE_SENSITIVE_DIAGNOSTIC';
  for (const result of [
    { status: 'failed', operationId, code: sensitive + '/private', message: sensitive },
    { status: 'failed', operationId, code: 'OPERATION_DENIED', message: sensitive },
    { status: 'failed', operationId, taskId: '/private/' + sensitive, message: sensitive },
  ]) {
    const f = fixture(t); f.bridge.execute = async (request, options) => { f.calls.execute.push({ request, options }); return result; };
    await f.open(); f.confirm().click(); await until(() => f.status().includes('操作失败') || f.status().includes('操作结果尚未确认'));
    assert.equal(f.calls.execute.length, 1); assert.ok(!f.doc.body.textContent.includes(sensitive)); assert.ok(!f.doc.body.textContent.includes('/private/'));
    if (result.code === 'OPERATION_DENIED') assert.ok(f.status().includes('OPERATION_DENIED'));
    f.provider.stop();
  }
});

test('closing during a pending fresh read cancels before transport and never resurrects the form', async t => {
  const f = fixture(t); await f.open(); const pending = deferred();
  f.bridge.read = async (target, options) => { f.calls.read.push({ resource: target, options }); return pending.promise; };
  f.confirm().click(); await until(() => f.calls.read.length === 2);
  f.cancel().click(); pending.resolve(copy(f.data)); await pause(20);
  assert.equal(f.root(), null); assert.equal(f.calls.execute.length, 0); assert.equal(f.calls.read[1].options.signal.aborted, true);
});

test('disabled plugin cannot keep an interactive production form or submit a change', async t => {
  const f = fixture(t); await f.open(); f.disable();
  f.confirm().click(); assert.equal(f.calls.execute.length, 0);
  await until(() => !f.root(), 1000); assert.equal(f.doc.querySelectorAll('style').length, 0);
});

test('stop removes dialog/styles/listeners and disallows later opens', async t => {
  const f = fixture(t); const request = await f.open();
  f.provider.stop(); f.provider.stop(); assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0);
  assert.equal((await f.provider.open(request)).status, 'unsupported'); assert.equal(f.root(), null); assert.equal(f.calls.execute.length, 0);
  const escape = new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); f.doc.body.dispatchEvent(escape); assert.equal(escape.defaultPrevented, false);
});

test('production form field pointer interactions preserve the already-open host drawer and its URL', async t => {
  const f = fixture(t, { drawer: true }), before = f.win.location.href; f.doc.querySelector('#previous').focus();
  await f.open(); const field = f.root().querySelector('[data-field="name"]');
  field.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  field.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(f.pane.isConnected, true, 'host capture/bubble outside detection must regard the form as inside its own drawer');
  assert.equal(f.win.location.href, before); assert.deepEqual(f.hostCloses, { pointer: 0, click: 0, escape: 0 });
  f.input('name', 'Edited without submission'); f.input('description', 'A safe local draft');
  const cancel = f.cancel(); cancel.dispatchEvent(new f.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true })); cancel.click();
  assert.equal(f.root(), null); assert.equal(f.pane.isConnected, true); assert.equal(f.win.location.href, before);
  assert.equal(f.calls.execute.length, 0); assert.equal(f.doc.activeElement.id, 'previous');
});

test('cancelling a production form does not bubble its detached button as a host outside click', async t => {
  const f = fixture(t, { drawer: true }), before = f.win.location.href; await f.open();
  // Isolate event bubbling after close removes the form, without a preceding pointerdown.
  f.cancel().dispatchEvent(new f.win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(f.root(), null); assert.equal(f.hostCloses.click, 0); assert.equal(f.pane.isConnected, true); assert.equal(f.win.location.href, before);
  assert.equal(f.calls.execute.length, 0);
});

test('Escape closes only the production form and leaves the native drawer open', async t => {
  const f = fixture(t, { drawer: true }), before = f.win.location.href; await f.open();
  const event = new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); f.doc.activeElement.dispatchEvent(event);
  assert.equal(f.root(), null); assert.equal(f.pane.isConnected, true); assert.equal(f.win.location.href, before); assert.equal(f.hostCloses.escape, 0);
  assert.equal(f.calls.execute.length, 0);
});

test('stopping a production form cleans owned DOM without closing the native drawer', async t => {
  const f = fixture(t, { drawer: true }), before = f.win.location.href; await f.open(); f.provider.stop();
  assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0); assert.equal(f.pane.isConnected, true); assert.equal(f.win.location.href, before);
  assert.deepEqual(f.hostCloses, { pointer: 0, click: 0, escape: 0 }); assert.equal(f.calls.execute.length, 0);
});

test('multiple native drawers make the production form fail closed without submitting', async t => {
  const f = fixture(t, { drawer: true }), before = f.win.location.href;
  const other = f.doc.createElement('aside'); other.className = 'drawer-content-inner'; other.textContent = 'Another native drawer'; f.doc.body.append(other);
  const request = await f.request('vm.general.edit');
  assert.equal((await f.provider.open(request)).status, 'unsupported'); assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0);
  assert.equal(f.calls.execute.length, 0); assert.equal(f.pane.isConnected, true); assert.equal(other.isConnected, true); assert.equal(f.win.location.href, before);
});

for (const change of ['remove', 'replace']) test(`host drawer ${change} cleans detached form resources and cancels a pending preflight`, async t => {
  const f = fixture(t, { drawer: true }); await f.open(); const pending = deferred();
  f.bridge.read = async (target, options) => { f.calls.read.push({ resource: target, options }); return pending.promise; };
  f.confirm().click(); await until(() => f.calls.read.length === 2);
  let replacement;
  if (change === 'replace') {
    replacement = f.doc.createElement('aside'); replacement.className = 'drawer-content-inner'; replacement.textContent = 'Fresh native drawer';
    f.pane.replaceWith(replacement);
  } else f.pane.remove();
  assert.equal(f.root(), null);
  await until(() => f.doc.querySelectorAll('style').length === 0);
  assert.equal(f.calls.read[1].options.signal.aborted, true);
  const escape = new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); f.doc.body.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false, 'the removed form must release its capture key listener');
  pending.resolve(copy(f.data)); await pause(20);
  assert.equal(f.calls.execute.length, 0); assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0);
  if (replacement) { assert.equal(replacement.isConnected, true); assert.equal(replacement.textContent, 'Fresh native drawer'); }
});

test('a drawer becoming aria-hidden blocks an old confirmation before any periodic guard runs', async t => {
  const f = fixture(t, { drawer: true }), guards = [];
  t.mock.method(f.win, 'setInterval', callback => { guards.push(callback); return 2147483647; });
  await f.open(); assert.equal(guards.length, 1);
  const confirm = f.confirm(); f.pane.setAttribute('aria-hidden', 'true');
  // No guard callback is invoked: the confirmation path must itself recheck the host boundary.
  confirm.click();
  assert.equal(f.calls.execute.length, 0); assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0);
  assert.equal(f.pane.isConnected, true); assert.equal(f.pane.getAttribute('aria-hidden'), 'true');
});

test('a drawer hidden while fresh preflight is pending cannot execute before the periodic guard', async t => {
  const f = fixture(t, { drawer: true }), guards = [];
  t.mock.method(f.win, 'setInterval', callback => { guards.push(callback); return 2147483647; });
  await f.open(); const pending = deferred();
  f.bridge.read = async (target, options) => { f.calls.read.push({ resource: target, options }); return pending.promise; };
  f.confirm().click(); await until(() => f.calls.read.length === 2);
  f.pane.style.display = 'none'; pending.resolve(copy(f.data)); await pause(20);
  assert.equal(f.calls.execute.length, 0, 'fresh validation must reject a hidden host boundary without waiting for the guard');
  assert.equal(guards.length, 1); guards[0]();
  assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0);
  await pause(20); assert.equal(f.root(), null); assert.equal(f.calls.execute.length, 0); assert.equal(f.pane.style.display, 'none');
});
