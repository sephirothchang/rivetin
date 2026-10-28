import test from 'node:test';
import assert from 'node:assert/strict';
import { createVmActionAdapter } from '../../../framework/server/resource-vm-actions.js';
import { actionFields, fieldValues } from '../src/actions/forms.js';
import { buildActionRequest } from '../src/actions/requests.js';

// This is a local adapter contract test, not an HTTP deployment or live Tower.
const copy = value => JSON.parse(JSON.stringify(value));
const resource = { type: 'vm', id: 'example-vm' }, cluster = { id: 'example-cluster' };
const actor = { id: 'example-root', source: 'tower', role: 'ROOT', auth: { Authorization: 'EXAMPLE_TOKEN' } };
function fixture() {
  const vm = { id: resource.id, name: 'Example VM', description: '', status: 'STOPPED', protected: false, internal: false, in_recycle_bin: false,
    cpu: { cores: 2, sockets: 1 }, vcpu: 2, memory: 1073741824, cpu_model: 'Example CPU', cluster, host: { id: 'source-host' } };
  const disk = { id: 'example-disk', type: 'DISK', bus: 'VIRTIO', boot: 0, vm: { id: vm.id }, vm_volume: { id: 'attached-volume' } };
  const nic = { id: 'example-nic', type: 'VLAN', model: 'VIRTIO', enabled: true, mac_address: '02:00:00:00:00:01', vm: { id: vm.id }, vlan: { id: 'example-vlan' } };
  const sets = {
    'get-vms': [vm], 'get-tasks': [], 'get-vm-disks': [disk], 'get-vm-nics': [nic],
    'get-vm-volumes': [
      { id: 'attached-volume', name: 'Attached', type: 'KVM_VOLUME', cluster, size: 4096, mounting: true, sharing: false, vm_disks: [{ id: disk.id }] },
      { id: 'spare-volume', name: 'Unattached', type: 'KVM_VOLUME', cluster, size: 8192, mounting: false, sharing: false, vm_disks: [] },
    ],
    'get-vm-snapshots': [{ id: 'example-snapshot', name: 'Checkpoint', consistent_type: 'CRASH_CONSISTENT', vm: { id: vm.id } }],
    'get-vlans': [{ id: 'example-vlan', name: 'Example VLAN', vds: { id: 'example-vds' } }], 'get-vdses': [{ id: 'example-vds', cluster }],
    'get-hosts': ['source-host', 'target-host'].map(id => ({ id, name: id, cluster, status: 'CONNECTED_HEALTHY', compatible_cpu_models: ['Example CPU'], total_memory_bytes: 8589934592, allocatable_memory_bytes: 8589934592 })),
  };
  const calls = [];
  const adapter = createVmActionAdapter({ request: async (path, body, current) => {
    assert.equal(current, actor); assert.match(path, /^\/v2\/api\/get-/); const values = sets[path.split('/').at(-1)]; assert.ok(values);
    calls.push({ path, body: copy(body) }); const w = body.where;
    return copy(values.filter(item => (!w.id || item.id === w.id) && (!w.vm || item.vm?.id === w.vm.id) && (!w.cluster || item.cluster?.id === w.cluster.id) &&
      (!w.resource_id || item.resource_id === w.resource_id) && (!w.status_in || w.status_in.includes(item.status)) &&
      (!w.vds?.cluster || sets['get-vdses'].find(vds => vds.id === item.vds?.id)?.cluster.id === w.vds.cluster.id) &&
      (w.mounting === undefined || item.mounting === w.mounting) && (w.sharing === undefined || item.sharing === w.sharing)).slice(0, body.first));
  } });
  return { adapter, calls, vm, sets };
}
const cases = [
  ['vm.hardware.cpu', { vcpu: 5, cpu_sockets: 2, cpu_cores: 3 }],
  ['vm.hardware.memory', { memory: 2147483648, memory_unit: 'B' }],
  ['vm.hardware.disk.add', { mode: 'existing', vm_volume_id: 'spare-volume', bus: 'VIRTIO', boot: 0 }],
  ['vm.hardware.disk.edit', { vm_disk_id: 'example-disk', bus: 'SCSI' }],
  ['vm.hardware.disk.expand', { vm_disk_id: 'example-disk', size: 8192, size_unit: 'B' }],
  ['vm.hardware.disk.remove', { vm_disk_id: 'example-disk' }],
  ['vm.hardware.nic.add', { connect_vlan_id: 'example-vlan', model: 'VIRTIO', enabled: false }],
  ['vm.hardware.nic.edit', { vm_nic_id: 'example-nic', connect_vlan_id: 'example-vlan', enabled: false }],
  ['vm.hardware.nic.remove', { vm_nic_id: 'example-nic' }],
  ['vm.snapshots.create', { name: 'New checkpoint', consistent_type: 'CRASH_CONSISTENT' }],
  ['vm.snapshots.delete', { snapshot_id: 'example-snapshot' }],
  ['vm.migration.withinCluster', { host_id: 'target-host' }],
];
for (const [actionId, intent] of cases) test(`${actionId}: formal choices, production fields and independent backend preparation agree`, async () => {
  const f = fixture(), fresh = await f.adapter.read({ resource, actionId, actor });
  const fields = actionFields(actionId, fresh.snapshot, 'en-US', intent, fresh.choices), values = fieldValues(fields, intent);
  const built = buildActionRequest({ resource, actionId, snapshot: fresh.snapshot, choices: fresh.choices, values });
  const before = f.calls.length, plan = await f.adapter.prepare({ resource, actionId, values, actor });
  assert.ok(f.calls.length > before, 'server preparation must independently reread, not trust client choices');
  assert.deepEqual(plan.request.body, built.body); assert.match(plan.request.path, /^\/v2\/api\//);
  assert.ok(!JSON.stringify(plan).includes('EXAMPLE_TOKEN')); assert.equal(plan.resource.id, resource.id);
  assert.ok(f.calls.every(call => call.path.startsWith('/v2/api/get-')), 'no mutation is submitted by either builder');
});
test('front-end choices cannot authorize stale device ownership at the backend preparation boundary', async () => {
  const f = fixture(), actionId = 'vm.hardware.nic.remove', fresh = await f.adapter.read({ resource, actionId, actor });
  assert.doesNotThrow(() => buildActionRequest({ resource, actionId, snapshot: fresh.snapshot, choices: fresh.choices, values: { vm_nic_id: 'example-nic' } }));
  f.sets['get-vm-nics'][0].vm.id = 'different-vm';
  await assert.rejects(f.adapter.prepare({ resource, actionId, values: { vm_nic_id: 'example-nic' }, actor }));
  assert.ok(f.calls.every(call => call.path.startsWith('/v2/api/get-')));
});
