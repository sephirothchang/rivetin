import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createProductionActionProvider } from '../src/actions/provider.js';
import { buildActionTree } from '../src/actions/catalog.js';

const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const copy = value => JSON.parse(JSON.stringify(value));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), 'expected state did not become observable within the bounded wait');
}
const resource = { type: 'vm', id: 'vm-a', name: 'VM A' };
const actionIds = ['vm.hardware.cpu', 'vm.hardware.memory', 'vm.hardware.disk.add', 'vm.hardware.disk.edit', 'vm.hardware.disk.expand', 'vm.hardware.disk.remove', 'vm.hardware.nic.add', 'vm.hardware.nic.edit', 'vm.hardware.nic.remove', 'vm.snapshots.list', 'vm.snapshots.create', 'vm.snapshots.restore', 'vm.snapshots.delete', 'vm.migration.withinCluster'];
function fixture(t) {
  const dom = new JSDOM('<button id="previous">Previous focus</button>', { url: 'https://tower.example.invalid/#/vms' });
  const win = dom.window, doc = win.document;
  const snapshot = { type: 'vm', id: 'vm-a', name: 'VM A', status: 'STOPPED', protected: false, internal: false, in_recycle_bin: false, entityAsyncStatus: null,
    vcpu: 8, cpu: { sockets: 2, cores: 4 }, memory: 4294967296, cluster: { id: 'cluster-a' }, host: { id: 'host-current' }, gpu_devices: [], pci_nics: [], usb_devices: [],
    // These older lists deliberately disagree with the independent choices.
    vm_disks: [{ id: 'stale-disk', type: 'DISK', vm: { id: 'vm-a' }, bus: 'IDE' }],
    vm_nics: [{ id: 'stale-nic', type: 'VLAN', vm: { id: 'vm-a' } }],
    snapshots: [{ id: 'stale-snapshot', vm: { id: 'vm-a' }, name: 'Old checkpoint' }],
    availableHosts: [{ id: 'stale-host', cluster: { id: 'cluster-a' }, status: 'CONNECTED_HEALTHY' }],
  };
  const choices = {
    diskAddModes: ['new', 'existing'], consistentTypes: ['CRASH_CONSISTENT'],
    // Lists never replace the authoritative VM's hardware prefill values.
    cpu: { sockets: 999, cores: 999 }, vcpu: 999, memory: 1,
    vm_disks: [
      { id: 'disk-a', type: 'DISK', vm: { id: 'vm-a' }, bus: 'VIRTIO', vm_volume: { id: 'volume-a', size: 4096 } },
      { id: 'disk-b', type: 'DISK', vm: { id: 'vm-a' }, bus: 'SCSI', vm_volume: { id: 'volume-b', size: 8192 } },
    ],
    vm_nics: [
      { id: 'nic-a', type: 'VLAN', vm: { id: 'vm-a' }, vlan: { id: 'vlan-a' }, model: 'E1000', enabled: true, mac_address: '02:00:00:00:00:01' },
      { id: 'nic-b', type: 'VLAN', vm: { id: 'vm-a' }, vlan: { id: 'vlan-b' }, model: 'VIRTIO', enabled: false, mac_address: '02:00:00:00:00:02' },
    ],
    availableVolumes: [{ id: 'spare-volume', cluster: { id: 'cluster-a' }, vm_disks: [], name: 'Spare volume' }],
    availableVlans: [{ id: 'vlan-a', cluster: { id: 'cluster-a' } }, { id: 'vlan-b', cluster: { id: 'cluster-a' } }],
    snapshots: [{ id: 'snapshot-a', vm: { id: 'vm-a' }, name: 'Checkpoint A' }, { id: 'snapshot-b', vm: { id: 'vm-a' }, name: 'Checkpoint B' }],
    availableHosts: [{ id: 'host-current', cluster: { id: 'cluster-a' }, status: 'CONNECTED_HEALTHY' }, { id: 'host-next', cluster: { id: 'cluster-a' }, status: 'CONNECTED_HEALTHY' }, { id: 'host-foreign', cluster: { id: 'cluster-b' }, status: 'CONNECTED_HEALTHY' }],
  };
  const capabilities = Object.fromEntries(actionIds.map(id => [id, { allowed: true }]));
  const calls = { read: [], choices: [], execute: [], order: [] };
  const envelope = actionId => copy({ actionId, snapshot, capabilities, choices });
  // This bridge is exclusively an in-memory fixture, without HTTP or a live Tower.
  const bridge = {
    async read(target, options) { calls.order.push('read'); calls.read.push({ resource: target, options }); return copy({ snapshot, capabilities }); },
    async choices(target, options) { calls.order.push('choices'); calls.choices.push({ resource: target, options }); return envelope(options.actionId); },
    async execute(request, options) { calls.order.push('execute'); calls.execute.push({ request, options }); return { status: 'succeeded', operationId: 'a'.repeat(64), snapshot: { id: 'vm-a' } }; },
  };
  const provider = createProductionActionProvider({ win, bridge });
  t.after(() => { provider.stop(); win.close(); });
  const root = () => doc.querySelector('[data-rivetin-action-form]');
  const field = id => root()?.querySelector(`[data-field="${id}"]`);
  const button = label => [...(root()?.querySelectorAll('button') || [])].find(item => item.textContent === label);
  const confirm = () => button('确认执行');
  const cancel = () => button('取消') || button('关闭');
  const status = () => root()?.querySelector('[role="status"]')?.textContent || '';
  function input(id, value) {
    const control = field(id); assert.ok(control, `field ${id} must exist`);
    if (control.type === 'checkbox') control.checked = value; else control.value = String(value);
    control.dispatchEvent(new win.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }
  function nameGate() {
    const input = root()?.querySelector('input[aria-label="对象名称确认"]');
    if (input) { input.value = 'VM A'; input.dispatchEvent(new win.Event('input', { bubbles: true })); }
  }
  async function request(actionId) {
    const fresh = await provider.read(resource), action = buildActionTree({ resource, ...fresh }).flatMap(group => group.items).find(item => item.id === actionId);
    assert.equal(action?.enabled, true, `${actionId} must be enabled by the local bridge`);
    return { actionId, resource, action, snapshot: fresh.snapshot };
  }
  async function open(actionId) { assert.equal((await provider.open(await request(actionId))).status, 'opened'); assert.ok(root()?.querySelector('[role="dialog"]')); }
  async function submit() {
    const action = confirm(); assert.ok(action); assert.equal(action.disabled, false, 'valid form must enable confirmation');
    action.click(); action.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await until(() => status().includes('操作已完成'));
    assert.equal(calls.execute.length, 1, 'a confirmation submits exactly once');
    assert.deepEqual(calls.order, ['read', 'choices', 'choices', 'execute']);
    assert.deepEqual(calls.choices.map(call => call.resource), [{ type: 'vm', id: 'vm-a' }, { type: 'vm', id: 'vm-a' }]);
    return calls.execute[0].request;
  }
  return { win, doc, bridge, provider, snapshot, capabilities, choices, calls, envelope, root, field, confirm, cancel, status, input, nameGate, request, open, submit };
}
const optionIds = input => [...input.options].map(option => option.value).filter(Boolean);

for (const action of ['cpu', 'memory']) test(`production ${action} form pre-fills current fields and submits converted numeric values exactly once`, async t => {
  const f = fixture(t); await f.open(`vm.hardware.${action}`); assert.equal(f.calls.execute.length, 0);
  if (action === 'cpu') {
    assert.equal(f.field('vcpu').value, '8'); assert.equal(f.field('cpu_sockets').value, '2'); assert.equal(f.field('cpu_cores').value, '4');
    f.input('vcpu', '10'); f.input('cpu_sockets', '3'); f.input('cpu_cores', '2');
  } else {
    assert.equal(f.field('memory').value, '4294967296'); assert.equal(f.field('memory_unit').value, 'B');
    f.input('memory', '8589934592');
  }
  const request = await f.submit();
  assert.equal(request.actionId, `vm.hardware.${action}`); assert.equal(request.resource.id, 'vm-a');
  assert.deepEqual(request.values, action === 'cpu' ? { vcpu: 10, cpu_sockets: 3, cpu_cores: 2 } : { memory: 8589934592, memory_unit: 'B' });
});

test('production disk-add source switching renders only relevant fields and excludes abandoned new-volume values', async t => {
  const f = fixture(t); await f.open('vm.hardware.disk.add');
  f.input('name', 'Abandoned draft'); f.input('size', 32); f.input('size_unit', 'B');
  f.input('mode', 'existing'); assert.equal(f.field('name'), null); assert.equal(f.field('size'), null); assert.equal(f.field('size_unit'), null);
  assert.deepEqual(optionIds(f.field('vm_volume_id')), ['spare-volume']); f.input('vm_volume_id', 'spare-volume');
  f.input('mode', 'new'); assert.equal(f.field('vm_volume_id'), null); assert.equal(f.field('name').value, ''); assert.equal(f.field('size').value, '');
  assert.equal(f.field('size_unit').value, 'B');
  f.input('name', 'Second abandoned draft'); f.input('size', 4096); f.input('mode', 'existing'); f.input('vm_volume_id', 'spare-volume');
  const request = await f.submit(); assert.deepEqual(request.values, { mode: 'existing', bus: 'VIRTIO', boot: 0, vm_volume_id: 'spare-volume' });
});

test('production new-disk form submits only its explicit new-volume fields', async t => {
  const f = fixture(t); await f.open('vm.hardware.disk.add');
  f.input('name', 'New data'); f.input('size', 1073741824); f.input('bus', 'SCSI'); f.input('boot', 1);
  assert.deepEqual((await f.submit()).values, { mode: 'new', bus: 'SCSI', boot: 1, name: 'New data', size: 1073741824, size_unit: 'B' });
});

test('production disk editing switches from A draft to B current bus and never reads stale snapshot devices', async t => {
  const f = fixture(t); await f.open('vm.hardware.disk.edit'); assert.deepEqual(optionIds(f.field('vm_disk_id')), ['disk-a', 'disk-b']);
  f.input('vm_disk_id', 'disk-a'); assert.equal(f.field('bus').value, 'VIRTIO'); f.input('bus', 'USB');
  f.input('vm_disk_id', 'disk-b'); assert.equal(f.field('bus').value, 'SCSI');
  assert.deepEqual((await f.submit()).values, { vm_disk_id: 'disk-b', bus: 'SCSI' });
});

test('production NIC editing switches VLAN, enabled false and MAC together with exact NIC ID without index or editable model', async t => {
  const f = fixture(t); await f.open('vm.hardware.nic.edit'); assert.deepEqual(optionIds(f.field('vm_nic_id')), ['nic-a', 'nic-b']);
  assert.equal(f.field('model'), null);
  f.input('vm_nic_id', 'nic-a'); f.input('connect_vlan_id', 'vlan-b'); f.input('mac_address', '02:00:00:00:00:03');
  f.input('vm_nic_id', 'nic-b');
  assert.equal(f.field('connect_vlan_id').value, 'vlan-b'); assert.equal(f.field('model'), null); assert.equal(f.field('enabled').checked, false); assert.equal(f.field('mac_address').value, '02:00:00:00:00:02');
  assert.deepEqual((await f.submit()).values, { vm_nic_id: 'nic-b', connect_vlan_id: 'vlan-b', enabled: false, mac_address: '02:00:00:00:00:02' });
});

test('snapshot browser renders only current choices as a read-only table and never executes', async t => {
  const f = fixture(t); await f.open('vm.snapshots.list');
  const list = f.root().querySelector('[data-rivetin-snapshots]'); assert.ok(list); assert.ok(list.textContent.includes('Checkpoint A')); assert.ok(list.textContent.includes('snapshot-b')); assert.ok(!list.textContent.includes('stale-snapshot'));
  assert.equal(f.confirm(), undefined); assert.equal(f.root().querySelectorAll('input,select').length, 0);
  list.querySelector('tbody tr').click(); assert.equal(f.calls.execute.length, 0); assert.equal(f.calls.choices.length, 1);
  f.cancel().click(); assert.equal(f.root(), null); assert.equal(f.calls.execute.length, 0);
});

for (const action of ['restore', 'delete']) test(`snapshot ${action} uses explicit fresh owned choices and the exact selected snapshot`, async t => {
  const f = fixture(t); f.choices.snapshots.push({ id: 'foreign-snapshot', vm: { id: 'vm-b' }, name: 'Not ours' });
  await f.open(`vm.snapshots.${action}`); assert.deepEqual(optionIds(f.field('snapshot_id')), ['snapshot-a', 'snapshot-b']);
  f.input('snapshot_id', 'snapshot-b'); assert.equal(f.confirm().disabled, true); f.nameGate();
  const request = await f.submit(); assert.equal(request.actionId, `vm.snapshots.${action}`); assert.deepEqual(request.values, { snapshot_id: 'snapshot-b' });
});

test('production migration excludes current, foreign and stale hosts and submits the chosen fresh target', async t => {
  const f = fixture(t); await f.open('vm.migration.withinCluster'); assert.deepEqual(optionIds(f.field('host_id')), ['host-next']);
  f.input('host_id', 'host-next'); assert.deepEqual((await f.submit()).values, { host_id: 'host-next' });
});

for (const change of ['missing-device', 'foreign-owner', 'permission-revoked']) test(`fresh choices ${change} before confirmation prevents execute despite previously valid fields`, async t => {
  const f = fixture(t); await f.open('vm.hardware.disk.edit'); f.input('vm_disk_id', 'disk-a'); f.input('bus', 'USB'); assert.equal(f.confirm().disabled, false);
  if (change === 'missing-device') f.choices.vm_disks = [];
  if (change === 'foreign-owner') f.choices.vm_disks[0].vm.id = 'vm-b';
  if (change === 'permission-revoked') f.capabilities['vm.hardware.disk.edit'] = { allowed: false };
  f.confirm().click(); await until(() => f.status().includes('操作失败'));
  assert.equal(f.calls.choices.length, 2); assert.equal(f.calls.execute.length, 0); assert.equal(f.confirm().disabled, true);
});

for (const interruption of ['cancel', 'route', 'stop']) test(`pending initial choices cannot open or execute after ${interruption}`, async t => {
  const f = fixture(t), pending = deferred(), request = await f.request('vm.hardware.disk.edit');
  f.bridge.choices = async (target, options) => { f.calls.choices.push({ resource: target, options }); return pending.promise; };
  const opening = f.provider.open(request); await until(() => f.calls.choices.length === 1); assert.equal(f.root(), null);
  if (interruption === 'cancel') f.provider.close();
  if (interruption === 'route') f.win.history.replaceState({}, '', '#/hosts/host-b');
  if (interruption === 'stop') f.provider.stop();
  pending.resolve(f.envelope(request.actionId)); assert.equal((await opening).status, 'cancelled'); await pause(10);
  assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0); assert.equal(f.calls.execute.length, 0);
});

for (const interruption of ['cancel', 'route', 'stop']) test(`pending confirmation choices cannot execute or rebuild a form after ${interruption}`, async t => {
  const f = fixture(t); await f.open('vm.hardware.disk.edit'); f.input('vm_disk_id', 'disk-a'); f.input('bus', 'USB');
  const pending = deferred(); f.bridge.choices = async (target, options) => { f.calls.choices.push({ resource: target, options }); return pending.promise; };
  f.confirm().click(); await until(() => f.calls.choices.length === 2);
  if (interruption === 'cancel') f.cancel().click();
  if (interruption === 'route') { f.win.history.replaceState({}, '', '#/hosts/host-b'); await until(() => !f.root()); }
  if (interruption === 'stop') f.provider.stop();
  assert.equal(f.calls.choices[1].options.signal.aborted, true);
  pending.resolve(f.envelope('vm.hardware.disk.edit')); await pause(15);
  assert.equal(f.root(), null); assert.equal(f.doc.querySelectorAll('style').length, 0); assert.equal(f.calls.execute.length, 0);
});
