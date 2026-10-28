import test from 'node:test';
import assert from 'node:assert/strict';
import { createVmActionAdapter } from '../server/resource-vm-actions.js';

const copy = value => JSON.parse(JSON.stringify(value));
const resource = { type: 'vm', id: 'example-vm' };
const actor = { id: 'example-root', source: 'tower', role: 'ROOT', auth: { Authorization: 'EXAMPLE_TOKEN' } };
const cluster = { id: 'example-cluster' }, vmRef = { id: resource.id };
function fixture(override) {
  const state = {
    vm: { ...vmRef, name: 'Example VM', description: 'Example description', status: 'STOPPED', protected: false, internal: false, in_recycle_bin: false,
      entityAsyncStatus: null, memory: 1073741824, cpu: { cores: 2, sockets: 1 }, vcpu: 2, cpu_model: 'EXAMPLE_CPU_MODEL', vm_tools_status: 'RUNNING',
      cluster, host: { id: 'source-host' }, ips: ['192.0.2.10'], node_ip: '192.0.2.11' },
    disks: [{ id: 'example-disk', type: 'DISK', bus: 'VIRTIO', boot: 0, vm: vmRef, vm_volume: { id: 'attached-volume' } }],
    volumes: [
      { id: 'attached-volume', name: 'Attached data', type: 'KVM_VOLUME', cluster, size: 1048576, mounting: true, sharing: false, vm_disks: [{ id: 'example-disk' }] },
      { id: 'spare-volume', name: 'Spare data', type: 'KVM_VOLUME', cluster, size: 2097152, mounting: false, sharing: false, vm_disks: [] },
    ],
    nics: [{ id: 'example-nic', type: 'VLAN', model: 'VIRTIO', enabled: true, vm: vmRef, vlan: { id: 'example-vlan' }, mac_address: '02:00:00:00:00:01', order: null, local_id: 'not-an-index' }],
    vlans: [{ id: 'example-vlan', name: 'Example network', vds: { id: 'example-vds' } }],
    vdses: [{ id: 'example-vds', cluster }],
    snapshots: [{ id: 'old-snapshot', name: 'Before changes', consistent_type: 'CRASH_CONSISTENT', vm: vmRef }],
    hosts: ['source-host', 'target-host'].map(id => ({ id, name: id, cluster, status: 'CONNECTED_HEALTHY', compatible_cpu_models: ['EXAMPLE_CPU_MODEL'], total_memory_bytes: 8589934592, allocatable_memory_bytes: 8589934592 })),
    tasks: [],
  };
  const calls = [];
  const collections = { '/get-vms': () => [state.vm], '/get-vm-disks': () => state.disks, '/get-vm-volumes': () => state.volumes,
    '/get-vm-nics': () => state.nics, '/get-vm-snapshots': () => state.snapshots, '/get-vlans': () => state.vlans,
    '/get-vdses': () => state.vdses, '/get-hosts': () => state.hosts, '/get-tasks': () => state.tasks };
  const request = async (path, body, current) => {
    assert.equal(current, actor); assert.ok(path.startsWith('/v2/api/get-'), 'the adapter must never send a mutation');
    const route = path.slice('/v2/api'.length); assert.ok(collections[route], 'fixed read route only');
    calls.push({ path, body: copy(body) });
    const other = override?.(route, body, state); if (other !== undefined) return copy(other);
    const where = body.where || {};
    return copy(collections[route]().filter(item =>
      (!where.id || item.id === where.id) && (!where.vm || item.vm?.id === where.vm.id) && (!where.cluster || item.cluster?.id === where.cluster.id) &&
      (!where.vds?.cluster || state.vdses.find(vds => vds.id === item.vds?.id)?.cluster?.id === where.vds.cluster.id) &&
      (where.mounting === undefined || item.mounting === where.mounting) && (where.sharing === undefined || item.sharing === where.sharing) &&
      (!where.resource_id || item.resource_id === where.resource_id) && (!where.status_in || where.status_in.includes(item.status)),
    ).slice(0, body.first));
  };
  const adapter = createVmActionAdapter({ request });
  const prepare = (actionId, values) => adapter.prepare({ resource, actionId, values, actor });
  const read = actionId => adapter.read({ resource, actionId, actor });
  const verify = (plan, responseData) => adapter.verify({ plan, responseData, actor });
  return { state, calls, adapter, prepare, read, verify };
}

test('supports only the frozen subset and readonly snapshot listing; never claims restore or console', async () => {
  const f = fixture();
  for (const action of ['vm.hardware.cpu', 'vm.hardware.memory', 'vm.hardware.disk.add', 'vm.hardware.disk.edit', 'vm.hardware.disk.expand', 'vm.hardware.disk.remove', 'vm.hardware.nic.add', 'vm.hardware.nic.edit', 'vm.hardware.nic.remove', 'vm.snapshots.create', 'vm.snapshots.delete', 'vm.snapshots.list', 'vm.migration.withinCluster']) assert.equal(f.adapter.supports(action), true, action);
  for (const action of ['vm.snapshots.restore', 'vm.console.open', 'vm.clone', 'vm.migration.acrossCluster', 'vm.delete', 'toString']) assert.equal(f.adapter.supports(action), false, action);
  await assert.rejects(f.prepare('vm.snapshots.restore', { snapshot_id: 'old-snapshot' }), /RESOURCE_ACTION_UNSUPPORTED/);
  await assert.rejects(f.prepare('vm.snapshots.list', {}), /RESOURCE_ACTION_UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});

test('server-verified ROOT actor is required; display names or injected role strings cannot replace context', async () => {
  const f = fixture();
  for (const current of [{ ...actor, auth: {} }, { ...actor, source: 'browser' }, { ...actor, id: '' }, { ...actor, role: 'READ_ONLY', name: 'root' }]) {
    await assert.rejects(f.adapter.read({ resource, actionId: 'vm.hardware.cpu', actor: current }), /RESOURCE_ACTION_PERMISSION_(?:DENIED|UNVERIFIED)/);
  }
  assert.equal(f.calls.length, 0);
});

test('read returns safe VM facts with nested CPU, original byte memory and separate choices', async () => {
  const f = fixture(); f.state.vm.cpu = { cores: 3, sockets: 2 }; f.state.vm.vcpu = 10;
  const result = await f.read('vm.hardware.cpu');
  assert.deepEqual(result.snapshot.cpu, { cores: 3, sockets: 2 }); assert.equal(result.snapshot.vcpu, 10);
  assert.equal(result.snapshot.memory, 1073741824); assert.deepEqual(result.choices, {});
  assert.equal(result.snapshot.vm_disks, undefined); assert.equal(result.snapshot.cpu_sockets, undefined);
  assert.ok(!JSON.stringify(result).includes('192.0.2.')); assert.ok(!JSON.stringify(result).includes('EXAMPLE_TOKEN'));
  assert.ok(f.calls.every(call => call.path !== '/v2/api/get-my-info'));
});

test('CPU requires three independently supplied numbers and never infers their product', async () => {
  const f = fixture(), values = { vcpu: 7, cpu_sockets: 2, cpu_cores: 4 }, plan = await f.prepare('vm.hardware.cpu', values);
  assert.deepEqual(plan.request, { path: '/v2/api/update-vm-basic-info', body: { where: { id: resource.id }, data: values } });
  assert.equal(await f.verify(plan), false);
  f.state.vm.cpu = { cores: 4, sockets: 2 }; f.state.vm.vcpu = 7;
  assert.equal(await f.verify(copy(plan)), true);
  for (const input of [{ cpu_sockets: 2, cpu_cores: 4 }, { ...values, vcpu: '7' }, { ...values, vcpu: 0 }, { ...values, cpu_cores: 1025 }, { ...values, where: {} }]) await assert.rejects(f.prepare('vm.hardware.cpu', input), /RESOURCE_ACTION_VALUES_INVALID/);
});

test('memory is exact bytes with conservative fresh host capacity and exact readback', async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.memory', { memory: 2147483648, memory_unit: 'B' });
  assert.deepEqual(plan.request.body, { where: { id: resource.id }, data: { memory: 2147483648, memory_unit: 'B' } });
  assert.equal(await f.verify(plan), false); f.state.vm.memory = 2147483648; assert.equal(await f.verify(plan), true);
  for (const values of [{ memory: 2, memory_unit: 'GB' }, { memory: '2147483648', memory_unit: 'B' }, { memory: Number.MAX_SAFE_INTEGER + 1, memory_unit: 'B' }]) await assert.rejects(f.prepare('vm.hardware.memory', values), /RESOURCE_ACTION_VALUES_INVALID/);
  await assert.rejects(f.prepare('vm.hardware.memory', { memory: 17179869184, memory_unit: 'B' }), /RESOURCE_ACTION_CAPACITY_UNVERIFIED/);
});

test('fresh parent state and active tasks stop preparation regardless of stale UI assumptions', async () => {
  const f = fixture();
  for (const patch of [{ protected: true }, { internal: true }, { in_recycle_bin: true }, { status: 'RUNNING' }, { entityAsyncStatus: 'UPDATING' }]) {
    const previous = f.state.vm; f.state.vm = { ...previous, ...patch };
    await assert.rejects(f.prepare('vm.hardware.cpu', { vcpu: 2, cpu_sockets: 1, cpu_cores: 2 }), /RESOURCE_ACTION_STATE_REJECTED/); f.state.vm = previous;
  }
  f.state.tasks = [{ id: 'example-task', resource_id: resource.id, status: 'PENDING' }];
  await assert.rejects(f.prepare('vm.hardware.cpu', { vcpu: 2, cpu_sockets: 1, cpu_cores: 2 }), /RESOURCE_ACTION_STATE_REJECTED/);
});

test('single existing disk attachment fixes payload and verifies one fresh delta plus real volume size', async () => {
  const f = fixture(), result = await f.read('vm.hardware.disk.add');
  assert.deepEqual(result.choices.diskAddModes, ['existing']); assert.deepEqual(result.choices.availableVolumes.map(volume => volume.id), ['spare-volume']);
  const plan = await f.prepare('vm.hardware.disk.add', { mode: 'existing', vm_volume_id: 'spare-volume', bus: 'SCSI', boot: 0 });
  assert.deepEqual(plan.request.body, { where: { id: resource.id }, data: { vm_disks: { mount_disks: [{ vm_volume_id: 'spare-volume', bus: 'SCSI', boot: 0 }] } } });
  assert.equal(await f.verify(plan), false);
  f.state.disks.push({ id: 'new-disk', type: 'DISK', bus: 'SCSI', boot: 0, vm: vmRef, vm_volume: { id: 'spare-volume' } });
  f.state.volumes[1].mounting = true; f.state.volumes[1].vm_disks = [{ id: 'new-disk' }];
  assert.equal(await f.verify(plan), true);
  f.state.volumes[1].size += 1; assert.equal(await f.verify(plan), false);
  await assert.rejects(f.prepare('vm.hardware.disk.add', { mode: 'new', bus: 'SCSI', boot: 0, name: 'Not allowed', size: 8, size_unit: 'B' }), /RESOURCE_ACTION_VALUES_INVALID/);
});

test('disk choices and attachment reject unsafe integers, shared/in-use volumes and unknown scope', async () => {
  const f = fixture(), input = { mode: 'existing', vm_volume_id: 'spare-volume', bus: 'VIRTIO', boot: 0 };
  for (const patch of [{ sharing: true }, { mounting: true }, { vm_disks: [{ id: 'foreign-disk' }] }]) {
    const previous = f.state.volumes[1]; f.state.volumes[1] = { ...previous, ...patch };
    await assert.rejects(f.prepare('vm.hardware.disk.add', input), /RESOURCE_ACTION_STATE_REJECTED/); f.state.volumes[1] = previous;
  }
  f.state.volumes[1].size = '2097152'; await assert.rejects(f.prepare('vm.hardware.disk.add', input), /RESOURCE_ACTION_RESPONSE_INVALID/);
});

test('bus editing preserves the exact owned disk and its underlying volume identity', async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.disk.edit', { vm_disk_id: 'example-disk', bus: 'SCSI' });
  assert.deepEqual(plan.request.body, { where: { id: resource.id }, data: { vm_disk_id: 'example-disk', bus: 'SCSI' } });
  assert.equal(await f.verify(plan), false); f.state.disks[0].bus = 'SCSI'; assert.equal(await f.verify(plan), true);
  f.state.disks[0].vm_volume.id = 'spare-volume'; assert.equal(await f.verify(plan), false);
  await assert.rejects(f.prepare('vm.hardware.disk.edit', { vm_disk_id: 'example-disk', bus: 'SCSI', vm_volume_id: 'spare-volume' }), /RESOURCE_ACTION_VALUES_INVALID/);
});

test('disk expansion uses exact child plus parent filter and larger bytes, responseKind stays vm', async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.disk.expand', { vm_disk_id: 'example-disk', size: 2097152, size_unit: 'B' });
  assert.deepEqual(plan.request, { path: '/v2/api/expand-vm-disk', body: { where: { id: 'example-disk', vm: { id: resource.id } }, size: 2097152, size_unit: 'B' } });
  assert.equal(plan.responseKind, 'vm'); assert.equal(await f.verify(plan), false);
  f.state.volumes[0].size = 2097152; assert.equal(await f.verify(plan, { id: resource.id }), true); assert.equal(await f.verify(plan, { id: 'example-disk' }), false);
  await assert.rejects(f.prepare('vm.hardware.disk.expand', { vm_disk_id: 'example-disk', size: 2097152, size_unit: 'B' }), /RESOURCE_ACTION_VALUES_INVALID/);
  await assert.rejects(f.prepare('vm.hardware.disk.expand', { vm_disk_id: 'example-disk', size: 8, size_unit: 'GB' }), /RESOURCE_ACTION_VALUES_INVALID/);
});

test('detachment verifies absence from this VM and preservation of the volume', async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.disk.remove', { vm_disk_id: 'example-disk' });
  assert.deepEqual(plan.request.body, { where: { id: resource.id }, data: { disk_ids: ['example-disk'] } });
  assert.equal(await f.verify(plan), false);
  f.state.disks = []; f.state.volumes[0].mounting = false; f.state.volumes[0].vm_disks = [];
  assert.equal(await f.verify(plan), true); f.state.volumes.shift(); assert.equal(await f.verify(plan), false);
});

test('foreign or ambiguous child objects and child-specific active tasks fail closed', async () => {
  const foreign = fixture((route, body, state) => route === '/get-vm-disks' && body.where.id ? [{ ...state.disks[0], vm: { id: 'other-vm' } }] : undefined);
  await assert.rejects(foreign.prepare('vm.hardware.disk.remove', { vm_disk_id: 'example-disk' }), /RESOURCE_ACTION_RELATIONSHIP_UNVERIFIED/);
  const f = fixture(); f.state.tasks = [{ id: 'child-task', resource_id: 'example-disk', status: 'EXECUTING' }];
  await assert.rejects(f.prepare('vm.hardware.disk.remove', { vm_disk_id: 'example-disk' }), /RESOURCE_ACTION_STATE_REJECTED/);
});

test('NIC edit/remove are ID-based, independent of order or integer index', async () => {
  const f = fixture(), result = await f.read('vm.hardware.nic.edit');
  assert.equal(result.choices.vm_nics[0].nic_index, undefined); assert.equal(result.choices.vm_nics[0].order, undefined);
  const plan = await f.prepare('vm.hardware.nic.edit', { vm_nic_id: 'example-nic', enabled: false });
  assert.deepEqual(plan.request, { path: '/v2/api/update-vm-nic-advance-info', body: { where: { id: 'example-nic', vm: { id: resource.id } }, data: { enabled: false } } });
  assert.equal(await f.verify(plan), false); f.state.nics[0].enabled = false; assert.equal(await f.verify(plan), true);
  const remove = await f.prepare('vm.hardware.nic.remove', { vm_nic_id: 'example-nic' });
  assert.deepEqual(remove.request, { path: '/v2/api/remove-vm-nic-by-where', body: { where: { id: 'example-nic', vm: { id: resource.id } }, effect: { vm_ids: [resource.id] } } });
  f.state.nics = []; assert.equal(await f.verify(remove), true);
  await assert.rejects(f.prepare('vm.hardware.nic.edit', { vm_nic_id: 'example-nic', model: 'E1000' }), /RESOURCE_ACTION_VALUES_INVALID/);
});

test('VLAN selection is freshly resolved through its VDS cluster rather than a client cluster claim', async () => {
  const f = fixture(); f.state.vdses[0].cluster = { id: 'other-cluster' };
  await assert.rejects(f.prepare('vm.hardware.nic.add', { connect_vlan_id: 'example-vlan', model: 'VIRTIO', enabled: true }), /RESOURCE_ACTION_RELATIONSHIP_UNVERIFIED/);
  assert.ok(f.calls.some(call => call.path === '/v2/api/get-vlans' && call.body.where.id === 'example-vlan'));
  assert.ok(f.calls.some(call => call.path === '/v2/api/get-vdses' && call.body.where.id === 'example-vds'));
});

test('one VLAN NIC addition verifies a new ID, concrete attributes and duplicate MAC rules', async () => {
  const f = fixture(), values = { connect_vlan_id: 'example-vlan', model: 'E1000', enabled: true, mac_address: '02:00:00:00:00:02' }, plan = await f.prepare('vm.hardware.nic.add', values);
  assert.equal(await f.verify(plan), false);
  f.state.nics.push({ id: 'new-nic', type: 'VLAN', model: 'E1000', enabled: true, mac_address: values.mac_address, vm: vmRef, vlan: { id: values.connect_vlan_id } });
  assert.equal(await f.verify(plan), true); f.state.nics[1].enabled = false; assert.equal(await f.verify(plan), false);
  await assert.rejects(f.prepare('vm.hardware.nic.add', values), /RESOURCE_ACTION_STATE_REJECTED/);
  await assert.rejects(f.prepare('vm.hardware.nic.add', { ...values, model: 'SRIOV' }), /RESOURCE_ACTION_VALUES_INVALID/);
  await assert.rejects(f.prepare('vm.hardware.nic.add', { ...values, mac_address: 'ff:ff:ff:ff:ff:ff' }), /RESOURCE_ACTION_VALUES_INVALID/);
});

test('snapshot read/list is readonly, advertises crash consistency only and never leaks raw objects', async () => {
  const f = fixture(), read = await f.read('vm.snapshots.list'), create = await f.read('vm.snapshots.create');
  assert.deepEqual(read.choices.snapshots.map(item => item.id), ['old-snapshot']);
  assert.deepEqual(create.choices.consistentTypes, ['CRASH_CONSISTENT']);
  assert.ok(!JSON.stringify(read).includes('EXAMPLE_TOKEN'));
  await assert.rejects(f.prepare('vm.snapshots.create', { name: 'New checkpoint', consistent_type: 'FILE_SYSTEM_CONSISTENT' }), /RESOURCE_ACTION_VALUES_INVALID/);
});

test('snapshot creation verifies the response ID, VM ownership, fresh name and consistency', async () => {
  const f = fixture(), plan = await f.prepare('vm.snapshots.create', { name: 'New checkpoint' });
  assert.equal(plan.responseKind, 'snapshot');
  assert.deepEqual(plan.request.body, { data: [{ vm_id: resource.id, name: 'New checkpoint', consistent_type: 'CRASH_CONSISTENT' }] });
  assert.equal(await f.verify(plan), false); assert.equal(await f.verify(plan, { id: 'old-snapshot' }), false);
  f.state.snapshots.push({ id: 'new-snapshot', name: 'New checkpoint', consistent_type: 'CRASH_CONSISTENT', vm: vmRef });
  assert.equal(await f.verify(plan, { id: 'new-snapshot' }), true);
  assert.equal(await f.verify(plan, { id: 'new-snapshot', vm: { id: 'foreign-vm' } }), false);
  f.state.snapshots[1].vm = { id: 'foreign-vm' }; assert.equal(await f.verify(plan, { id: 'new-snapshot' }), false);
});

test('snapshot deletion requires exact owner and verifies exact child absence', async () => {
  const f = fixture(), plan = await f.prepare('vm.snapshots.delete', { snapshot_id: 'old-snapshot' });
  assert.deepEqual(plan.request.body, { where: { id: 'old-snapshot', vm: { id: resource.id } } });
  assert.equal(await f.verify(plan), false); f.state.snapshots = []; assert.equal(await f.verify(plan, { id: 'old-snapshot' }), true);
  assert.equal(await f.verify(plan, { id: 'other-snapshot' }), false);
  const foreign = fixture((route, body, state) => route === '/get-vm-snapshots' && body.where.id ? [{ ...state.snapshots[0], vm: null }] : undefined);
  await assert.rejects(foreign.prepare('vm.snapshots.delete', { snapshot_id: 'old-snapshot' }), /RESOURCE_ACTION_RELATIONSHIP_UNVERIFIED/);
});

test('cold migration verifies fresh source/target, CPU compatibility, memory and final host', async () => {
  const f = fixture(), plan = await f.prepare('vm.migration.withinCluster', { host_id: 'target-host' });
  assert.deepEqual(plan.request.body, { where: { id: resource.id }, data: { host_id: 'target-host' } });
  assert.equal(await f.verify(plan), false); f.state.vm.host = { id: 'target-host' }; assert.equal(await f.verify(plan), true);
  f.state.vm.status = 'RUNNING'; assert.equal(await f.verify(plan), false);
  const blocked = fixture(); blocked.state.hosts[1].compatible_cpu_models = [];
  await assert.rejects(blocked.prepare('vm.migration.withinCluster', { host_id: 'target-host' }), /RESOURCE_ACTION_CAPACITY_UNVERIFIED/);
  blocked.state.hosts[1].compatible_cpu_models = ['EXAMPLE_CPU_MODEL']; blocked.state.hosts[1].allocatable_memory_bytes = 0;
  await assert.rejects(blocked.prepare('vm.migration.withinCluster', { host_id: 'target-host' }), /RESOURCE_ACTION_CAPACITY_UNVERIFIED/);
});

test('plans are finite JSON without credentials and verification never executes forged routes or mismatched kinds', async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.cpu', { vcpu: 2, cpu_sockets: 1, cpu_cores: 2 });
  assert.equal(await f.verify(copy(plan)), true); assert.ok(!JSON.stringify(plan).includes('EXAMPLE_TOKEN'));
  for (const change of [
    value => { value.request.path = '/v2/api/delete-vm'; },
    value => { value.expected.kind = 'migration'; },
    value => { value.request.body.where = {}; },
    value => { value.expected.vmId = 'another-vm'; },
    value => { value.expected.password = 'EXAMPLE_PASSWORD'; },
  ]) {
    const bad = copy(plan), before = f.calls.length; change(bad); assert.equal(await f.verify(bad), false); assert.equal(f.calls.length, before);
  }
  assert.ok(f.calls.every(call => call.path.startsWith('/v2/api/get-')));
});

test('malformed, oversized and wrong-ID reads do not authorize partial choices or readback success', async () => {
  const f = fixture((route, body, state) => route === '/get-vms' ? [{ ...state.vm, memory: Number.MAX_SAFE_INTEGER + 1 }] : undefined);
  await assert.rejects(f.read('vm.hardware.memory'), /RESOURCE_ACTION_RESPONSE_INVALID/);
  const many = fixture((route) => route === '/get-vm-snapshots' ? Array.from({ length: 129 }, (_, i) => ({ id: `snapshot-${i}`, vm: vmRef, name: 'Example', consistent_type: 'CRASH_CONSISTENT' })) : undefined);
  await assert.rejects(many.read('vm.snapshots.list'), /RESOURCE_ACTION_RESPONSE_INVALID/);
  const denied = fixture(() => { throw Object.assign(new Error('PRIVATE_SERVER_DETAIL'), { status: 403 }); });
  await assert.rejects(denied.read('vm.hardware.cpu'), /^Error: RESOURCE_ACTION_PERMISSION_DENIED$/);
});

test('matching postcondition fields do not pass while a child or volume has another active change', async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.disk.expand', { vm_disk_id: 'example-disk', size: 2097152, size_unit: 'B' });
  f.state.volumes[0].size = 2097152;
  assert.equal(await f.verify(plan), true);
  f.state.tasks = [{ id: 'volume-task', resource_id: 'attached-volume', status: 'EXECUTING' }];
  assert.equal(await f.verify(plan), false);
  f.state.tasks = []; f.state.volumes[0].entityAsyncStatus = 'UPDATING';
  assert.equal(await f.verify(plan), false);
});

test('a new matching device cannot hide removal of a pre-existing device in readback', async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.nic.add', { connect_vlan_id: 'example-vlan', model: 'VIRTIO', enabled: true });
  f.state.nics = [{ ...f.state.nics[0], id: 'replacement-nic' }];
  assert.equal(await f.verify(plan), false);
});

for (const [condition, change] of [
  ['an executing volume task', state => { state.tasks = [{ id: 'volume-task', resource_id: 'attached-volume', status: 'EXECUTING' }]; }],
  ['an updating volume', state => { state.volumes[0].entityAsyncStatus = 'UPDATING'; }],
  ['a volume moved outside the VM cluster', state => { state.volumes[0].cluster = { id: 'foreign-cluster' }; }],
]) test(`matching disk bus is insufficient with ${condition}`, async () => {
  const f = fixture(), values = { vm_disk_id: 'example-disk', bus: 'SCSI' }, plan = await f.prepare('vm.hardware.disk.edit', values);
  f.state.disks[0].bus = 'SCSI'; assert.equal(await f.verify(plan), true);
  change(f.state);
  await assert.rejects(f.prepare('vm.hardware.disk.edit', values), /RESOURCE_ACTION_/);
  assert.equal(await f.verify(plan), false);
  assert.ok(f.calls.every(call => call.path.startsWith('/v2/api/get-')));
});

for (const [condition, change] of [
  ['a shared volume', state => { state.volumes[0].sharing = true; }],
  ['a missing volume-to-disk relationship', state => { state.volumes[0].vm_disks = []; }],
]) test(`matching expanded size is insufficient with ${condition}`, async () => {
  const f = fixture(), plan = await f.prepare('vm.hardware.disk.expand', { vm_disk_id: 'example-disk', size: 2097152, size_unit: 'B' });
  f.state.volumes[0].size = 2097152; assert.equal(await f.verify(plan), true);
  change(f.state);
  await assert.rejects(f.prepare('vm.hardware.disk.expand', { vm_disk_id: 'example-disk', size: 4194304, size_unit: 'B' }), /RESOURCE_ACTION_/);
  assert.equal(await f.verify(plan), false);
  assert.ok(f.calls.every(call => call.path.startsWith('/v2/api/get-')));
});
