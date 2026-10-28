import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createProductionActionProvider } from '../src/actions/provider.js';
import { buildActionTree } from '../src/actions/catalog.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const dom = new JSDOM('<button>Previous focus</button>', { url: 'https://tower.example.invalid/#/vms' });
  const win = dom.window, doc = win.document;
  const resource = { type: 'vm', id: 'vm-a', name: 'VM A' };
  const snapshot = { type: 'vm', id: 'vm-a', name: 'VM A', status: 'STOPPED', cluster: { id: 'cluster-a' }, cpu_sockets: 2, cpu_cores: 4 };
  const capabilities = { 'vm.hardware.disk.edit': { allowed: true }, 'vm.hardware.cpu': { allowed: true } };
  const choices = { vm_disks: [
    { id: 'disk-a', type: 'DISK', vm: { id: 'vm-a' }, bus: 'VIRTIO' },
    { id: 'disk-b', type: 'DISK', vm: { id: 'vm-a' }, bus: 'SCSI' },
  ] };
  const envelope = actionId => JSON.parse(JSON.stringify({ actionId, snapshot, capabilities, choices }));
  const executions = [];
  const bridge = {
    read: async () => ({ snapshot, capabilities }),
    choices: async (target, options) => envelope(options.actionId),
    execute: async request => { executions.push(request); return { status: 'succeeded', operationId: 'a'.repeat(64) }; },
  };
  const routeListeners = new Set();
  const history = { listen(listener) { routeListeners.add(listener); return () => routeListeners.delete(listener); } };
  const provider = createProductionActionProvider({ win, bridge, history });
  t.after(() => { provider.stop(); win.close(); });
  const root = () => doc.querySelector('[data-rivetin-action-form]');
  const field = id => root()?.querySelector(`[data-field="${id}"]`);
  const cancel = () => [...root().querySelectorAll('button')].find(button => ['取消', '关闭'].includes(button.textContent));
  const confirm = () => root()?.querySelector('.rva-confirm');
  function request(actionId = 'vm.hardware.disk.edit') {
    const action = buildActionTree({ resource, snapshot, capabilities }).flatMap(group => group.items).find(entry => entry.id === actionId);
    return { actionId, action, resource, snapshot };
  }
  function change(id, value) {
    const control = field(id); control.value = value; control.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  function routeAba(event) {
    const notify = () => event === 'history.listen' ? [...routeListeners].forEach(listener => listener()) : win.dispatchEvent(new win.Event(event));
    win.history.replaceState({}, '', '#/hosts/host-b'); notify();
    win.history.replaceState({}, '', '#/vms'); notify();
  }
  return { win, doc, provider, bridge, envelope, executions, root, field, cancel, confirm, request, change, routeAba, routeListeners,
    open: actionId => provider.open(request(actionId)),
  };
}

test('a detached old cancel button cannot close a newer form', async t => {
  const f = fixture(t); await f.open(); const oldCancel = f.cancel();
  await f.open('vm.hardware.cpu'); const current = f.root(); assert.ok(current);
  oldCancel.click(); assert.equal(f.root(), current);
});

test('a disabled selector listener cannot rebuild enabled controls during preflight', async t => {
  const f = fixture(t); await f.open(); f.change('vm_disk_id', 'disk-a');
  const selector = f.field('vm_disk_id'), pending = deferred();
  f.bridge.choices = () => pending.promise;
  f.confirm().click(); await settle();
  assert.ok([...f.root().querySelectorAll('[data-field]')].every(control => control.disabled));
  selector.value = 'disk-b'; selector.dispatchEvent(new f.win.Event('change'));
  try {
    assert.ok([...f.root().querySelectorAll('[data-field]')].every(control => control.disabled), 'a stale event must not recreate editable controls while confirming');
    assert.equal(f.confirm().disabled, true);
  } finally {
    f.provider.close(); pending.resolve(f.envelope('vm.hardware.disk.edit')); await settle();
  }
  assert.equal(f.executions.length, 0);
});

test('a detached device A field cannot silently change the submitted device B draft', async t => {
  const f = fixture(t); await f.open(); f.change('vm_disk_id', 'disk-a'); const formerBus = f.field('bus');
  f.change('vm_disk_id', 'disk-b'); assert.equal(formerBus.isConnected, false); assert.equal(f.field('bus').value, 'SCSI');
  formerBus.value = 'USB'; formerBus.dispatchEvent(new f.win.Event('input'));
  assert.equal(f.field('bus').value, 'SCSI'); f.confirm().click(); await settle();
  assert.equal(f.executions.length, 1);
  assert.deepEqual(f.executions[0].values, { vm_disk_id: 'disk-b', bus: 'SCSI' });
});

for (const event of ['popstate', 'hashchange', 'history.listen']) test(`initial choices cannot resurrect after an observed ${event} A→B→A`, async t => {
  const f = fixture(t), pending = deferred(); f.bridge.choices = () => pending.promise;
  const opening = f.open(); await settle(); f.routeAba(event); pending.resolve(f.envelope('vm.hardware.disk.edit'));
  assert.equal((await opening).status, 'cancelled'); assert.equal(f.root(), null); assert.equal(f.executions.length, 0);
});

for (const event of ['popstate', 'hashchange', 'history.listen']) test(`an existing form closes on observed ${event} A→B→A without waiting for a sampling interval`, async t => {
  const f = fixture(t); await f.open(); f.routeAba(event);
  assert.equal(f.root(), null); assert.equal(f.executions.length, 0);
});

test('a superseded pending choices result cannot replace the newer form', async t => {
  const f = fixture(t), pending = deferred(); f.bridge.choices = () => pending.promise;
  const former = f.open(); await settle(); f.bridge.choices = async (target, options) => f.envelope(options.actionId);
  assert.equal((await f.open('vm.hardware.cpu')).status, 'opened'); const current = f.root();
  pending.resolve(f.envelope('vm.hardware.disk.edit')); assert.equal((await former).status, 'cancelled');
  assert.equal(f.root(), current); assert.ok(f.field('cpu_sockets')); assert.equal(f.executions.length, 0);
});

test('stop unsubscribes the public history bridge and pending choices receive cancellation', async t => {
  const f = fixture(t), pending = deferred(); let readSignal;
  f.bridge.choices = (target, options) => { readSignal = options.signal; return pending.promise; };
  assert.equal(f.routeListeners.size, 1);
  const opening = f.open(); await settle(); f.provider.stop();
  assert.equal(f.routeListeners.size, 0); assert.equal(readSignal.aborted, true);
  pending.resolve(f.envelope('vm.hardware.disk.edit'));
  assert.equal((await opening).status, 'cancelled'); assert.equal(f.root(), null); assert.equal(f.executions.length, 0);
});
