import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_OPERATIONS, buildActionRequest, parseSubmission, buildTaskQuery, parseTask } from '../src/actions/requests.js';

const resource = { type: 'vm', id: 'demo-vm' };
const snapshot = { id: resource.id, status: 'STOPPED', entityAsyncStatus: null, protected: false, internal: false, in_recycle_bin: false,
  cluster: { id: 'demo-cluster' }, host: { id: 'source-host' }, vm_tools_status: 'NOT_RUNNING',
  availableHosts: [{ id: 'target-host', cluster: { id: 'demo-cluster' }, status: 'CONNECTED_HEALTHY' }],
  snapshots: [{ id: 'restore-point', vm: { id: resource.id } }], gpu_devices: [], pci_nics: [], usb_devices: [],
  vm_disks: [{ id: 'vm-disk', type: 'DISK', bus: 'VIRTIO', vm: { id: resource.id }, vm_volume: { id: 'attached-volume', size: 4096 } }],
  vm_nics: [{ id: 'vm-nic', type: 'VLAN', model: 'VIRTIO', enabled: true, mac_address: '02:00:00:00:00:01', vm: { id: resource.id }, vlan: { id: 'vm-vlan' } }],
  availableVolumes: [{ id: 'spare-volume', cluster: { id: 'demo-cluster' }, vm_disks: [] }],
  availableVlans: [{ id: 'vm-vlan', cluster: { id: 'demo-cluster' } }],
};
const build = (actionId, values = {}, changes = {}) => buildActionRequest({ actionId, values, resource, snapshot: { ...snapshot, ...changes } });
const rejects = (callback, code) => assert.throws(callback, error => error.code === code);

test('all seven power actions create exact single-VM selectors and distinct operations', () => {
  const definitions = [
    ['start', 'StartVm', 'STOPPED'], ['shutdown', 'ShutDownVm', 'RUNNING'], ['poweroff', 'PoweroffVm', 'RUNNING'],
    ['restart', 'RestartVm', 'RUNNING'], ['forceRestart', 'ForceRestartVm', 'RUNNING'], ['suspend', 'SuspendVm', 'RUNNING'], ['resume', 'ResumeVm', 'SUSPENDED'],
  ];
  for (const [id, operationId, status] of definitions) assert.deepEqual(build(`vm.power.${id}`, {}, { status }), { operationId, body: { where: { id: resource.id } } });
  rejects(() => build('vm.power.shutdown'), 'VM_PRECONDITION_state');
  rejects(() => build('vm.power.resume'), 'VM_PRECONDITION_state');
});

test('callers cannot inject broad filters, resource IDs, credentials or payload fields', () => {
  for (const values of [{ where: {} }, { id: 'other-vm' }, { data: {} }, { token: 'EXAMPLE' }, { authorization: 'EXAMPLE' }]) rejects(() => build('vm.power.start', values), 'INVALID_FORM_VALUES');
  rejects(() => buildActionRequest({ actionId: 'vm.power.start', resource, snapshot: { ...snapshot, id: 'other-vm' } }), 'VM_PREFLIGHT_MISMATCH');
  rejects(() => buildActionRequest({ actionId: 'vm.power.start', resource: { type: 'vmDisk', id: resource.id }, snapshot }), 'VM_PREFLIGHT_MISMATCH');
});

test('fresh busy, protected, internal, recycled or migrating objects cannot be submitted', () => {
  for (const change of [{ entityAsyncStatus: 'UPDATING' }, { protected: true }, { internal: true }, { in_recycle_bin: true }, { status: 'UNKNOWN' }]) assert.throws(() => build('vm.power.start', {}, change));
  assert.throws(() => build('vm.power.start', {}, { migration: { verified: true, vmId: resource.id, taskId: 'migration-task', taskStatus: 'EXECUTING', kind: 'CROSS_CLUSTER' } }));
});

test('explicit start targets require freshly read same-cluster healthy host identity', () => {
  assert.deepEqual(build('vm.power.start', { host_id: 'target-host' }).body, { where: { id: resource.id }, data: { host_id: 'target-host' } });
  rejects(() => build('vm.power.start', { host_id: resource.id }), 'HOST_PREFLIGHT_REQUIRED');
  rejects(() => build('vm.power.start', { host_id: 'unread-host' }), 'HOST_NOT_ELIGIBLE');
  for (const host of [
    { id: 'target-host', cluster: { id: 'other-cluster' }, status: 'CONNECTED_HEALTHY' },
    { id: 'target-host', cluster: snapshot.cluster, status: 'CONNECTED_ERROR' },
    { id: 'target-host', cluster: snapshot.cluster, status: 'CONNECTED_HEALTHY', entityAsyncStatus: 'UPDATING' },
  ]) rejects(() => build('vm.power.start', { host_id: 'target-host' }, { availableHosts: [host] }), 'HOST_NOT_ELIGIBLE');
});

test('basic info sends only explicitly edited fields, allows clearing description, rejects empty updates', () => {
  assert.deepEqual(build('vm.general.edit', { name: 'Demo renamed' }), { operationId: 'UpdateVm', body: { where: { id: resource.id }, data: { name: 'Demo renamed' } } });
  assert.deepEqual(build('vm.general.edit', { description: '' }).body.data, { description: '' });
  rejects(() => build('vm.general.edit'), 'EMPTY_UPDATE');
  rejects(() => build('vm.general.edit', { name: ' ' }), 'INVALID_TEXT');
  assert.equal(build('vm.general.edit', { name: 'A'.repeat(256) }).body.data.name.length, 256);
  for (const name of ['A'.repeat(257), ' leading', 'trailing ']) rejects(() => build('vm.general.edit', { name }), 'INVALID_TEXT');
  rejects(() => build('vm.general.edit', { name: 'Demo', vcpu: 4 }), 'INVALID_FORM_VALUES');
});

test('CPU sends three explicit positive int32 fields unchanged without inferring their relationship', () => {
  const values = { cpu_sockets: 2, cpu_cores: 4, vcpu: 6 };
  assert.deepEqual(build('vm.hardware.cpu', values).body.data, values);
  assert.deepEqual(build('vm.hardware.cpu', { cpu_sockets: 65536, cpu_cores: 65536, vcpu: 1 }).body.data, { cpu_sockets: 65536, cpu_cores: 65536, vcpu: 1 });
  for (const key of Object.keys(values)) {
    const missing = { ...values }; delete missing[key]; rejects(() => build('vm.hardware.cpu', missing), 'INVALID_FORM_VALUES');
    for (const count of [0, -1, 1.5, '4', Infinity, 2147483648, Number.MAX_SAFE_INTEGER + 1]) rejects(() => build('vm.hardware.cpu', { ...values, [key]: count }), 'INVALID_POSITIVE_INTEGER');
  }
});

test('memory requires explicit exact bytes and safe integer size without unverified unit conversions', () => {
  assert.deepEqual(build('vm.hardware.memory', { memory: 8589934592, memory_unit: 'B' }).body.data, { memory: 8589934592, memory_unit: 'B' });
  for (const memory_unit of ['KB', 'MB', 'GB', 'TB', 'PB', 'GiB', '', null]) rejects(() => build('vm.hardware.memory', { memory: 8, memory_unit }), 'INVALID_MEMORY_UNIT');
  rejects(() => build('vm.hardware.memory', { memory: 8 }), 'INVALID_FORM_VALUES');
  rejects(() => build('vm.hardware.memory', { memory: Number.MAX_SAFE_INTEGER + 1, memory_unit: 'B' }), 'INVALID_POSITIVE_INTEGER');
});

test('snapshot creation uses data array and explicit official consistency values', () => {
  assert.deepEqual(build('vm.snapshots.create', { name: 'Before change' }), { operationId: 'CreateVmSnapshot', body: { data: [{ vm_id: resource.id, name: 'Before change', consistent_type: 'CRASH_CONSISTENT' }] } });
  assert.equal(build('vm.snapshots.create', { name: 'Quiesced', consistent_type: 'FILE_SYSTEM_CONSISTENT' }, { status: 'RUNNING', vm_tools_status: 'RUNNING' }).body.data[0].consistent_type, 'FILE_SYSTEM_CONSISTENT');
  rejects(() => build('vm.snapshots.create', { name: 'Quiesced', consistent_type: 'FILE_SYSTEM_CONSISTENT' }), 'SNAPSHOT_GUEST_AGENT_REQUIRED');
  rejects(() => build('vm.snapshots.create', { name: 'Demo', consistent_type: 'QUIESCED' }), 'INVALID_SNAPSHOT_CONSISTENCY');
});

test('rollback verifies the selected snapshot belongs to this VM and never reuses parent ID', () => {
  assert.deepEqual(build('vm.snapshots.restore', { snapshot_id: 'restore-point' }), { operationId: 'RollbackVm', body: { where: { id: resource.id }, data: { snapshot_id: 'restore-point' } } });
  rejects(() => build('vm.snapshots.restore', { snapshot_id: resource.id }), 'DEVICE_PREFLIGHT_REQUIRED');
  rejects(() => build('vm.snapshots.restore', { snapshot_id: 'unread-snapshot' }), 'DEVICE_NOT_OWNED_OR_READY');
  rejects(() => build('vm.snapshots.restore', { snapshot_id: 'restore-point' }, { snapshots: [{ id: 'restore-point', vm: { id: 'other-vm' } }] }), 'DEVICE_NOT_OWNED_OR_READY');
  rejects(() => build('vm.snapshots.restore', { snapshot_id: 'restore-point' }, { snapshots: [{ id: 'restore-point' }] }), 'DEVICE_NOT_OWNED_OR_READY');
  rejects(() => build('vm.snapshots.restore', { snapshot_id: 'restore-point' }, { snapshots: [{ id: 'restore-point', vm: { id: resource.id }, entityAsyncStatus: 'DELETING' }] }), 'DEVICE_NOT_OWNED_OR_READY');
});

test('within-cluster migration requires one explicit eligible destination distinct from current host', () => {
  assert.deepEqual(build('vm.migration.withinCluster', { host_id: 'target-host' }).body, { where: { id: resource.id }, data: { host_id: 'target-host' } });
  rejects(() => build('vm.migration.withinCluster'), 'INVALID_FORM_VALUES');
  rejects(() => build('vm.migration.withinCluster', { host_id: 'target-host' }, { host: { id: 'target-host' } }), 'MIGRATION_TARGET_IS_CURRENT_HOST');
});

test('first clone form emits one same-cluster, stopped clone with exact documented source ID', () => {
  assert.deepEqual(build('vm.clone', { name: 'Demo copy', description: 'A copy', is_full_copy: true }), { operationId: 'CloneVm', body: [{ src_vm_id: resource.id, name: 'Demo copy', status: 'STOPPED', cluster_id: snapshot.cluster.id, description: 'A copy', is_full_copy: true }] });
  assert.equal(build('vm.clone', { name: 'Demo copy', host_id: 'target-host' }).body[0].host_id, 'target-host');
  rejects(() => build('vm.clone', { name: 'Demo', status: 'RUNNING' }), 'INVALID_FORM_VALUES');
  rejects(() => build('vm.clone', { name: 'Demo', cluster_id: 'other-cluster' }), 'INVALID_FORM_VALUES');
  rejects(() => build('vm.clone', { name: 'Demo' }, { gpu_devices: [{ id: 'gpu-device' }] }), 'CLONE_DEVICE_MAPPING_UNSUPPORTED');
  rejects(() => build('vm.clone', { name: 'Demo' }, { usb_devices: undefined }), 'CLONE_DEVICE_PREFLIGHT_REQUIRED');
});

test('unimplemented action requests fail explicitly without guessed payloads', () => {
  for (const id of ['vm.hardware.nic.qos', 'vm.migration.acrossCluster', 'vm.template.create', 'vm.delete']) rejects(() => build(id), 'ACTION_REQUEST_UNSUPPORTED');
  assert.equal(Object.keys(REQUEST_OPERATIONS).length, 22);
});

test('submission parser distinguishes explicit synchronous completion, queued task and unknown outcomes', () => {
  const options = { operationId: 'StartVm', resourceId: resource.id };
  assert.deepEqual(parseSubmission([{ task_id: null, data: { id: resource.id } }], options), { state: 'synchronous', taskIds: [], resourceIds: [resource.id], requiresReadback: true, retrySubmission: false });
  assert.equal(parseSubmission([{ task_id: 'demo-task', data: { id: resource.id } }], options).state, 'pending');
  for (const body of [[], [{ data: { id: resource.id } }], [{ task_id: '', data: { id: resource.id } }], [{ task_id: null, data: { id: 'other-vm' } }], { data: [{ task_id: null, data: { id: resource.id } }] }]) {
    const result = parseSubmission(body, options); assert.equal(result.state, 'unconfirmed'); assert.equal(result.retrySubmission, false);
  }
});

test('created snapshots and clones require a new object identity and no mismatching owner', () => {
  assert.equal(parseSubmission([{ task_id: 'demo-task', data: { id: 'new-clone' } }], { operationId: 'CloneVm', resourceId: resource.id }).state, 'pending');
  assert.equal(parseSubmission([{ task_id: null, data: { id: resource.id } }], { operationId: 'CloneVm', resourceId: resource.id }).state, 'unconfirmed');
  assert.equal(parseSubmission([{ task_id: null, data: { id: 'new-snapshot', vm: { id: 'other-vm' } } }], { operationId: 'CreateVmSnapshot', resourceId: resource.id }).state, 'unconfirmed');
});

test('task query is exact-ID and task parsing validates identity and known statuses', () => {
  assert.deepEqual(buildTaskQuery('demo-task'), { operationId: 'GetTasks', body: { where: { id: 'demo-task' }, first: 1 } });
  for (const [status, state] of [['PENDING', 'pending'], ['EXECUTING', 'pending'], ['PAUSED', 'paused'], ['SUCCESSED', 'succeeded'], ['FAILED', 'failed']]) {
    const result = parseTask([{ id: 'demo-task', status }], { taskId: 'demo-task' });
    assert.equal(result.state, state); assert.equal(result.requiresReadback, true); assert.equal(result.retrySubmission, false);
  }
  for (const body of [[], [{ id: 'other-task', status: 'SUCCESSED' }], [{ id: 'demo-task', status: 'SUCCESS' }], [{ id: 'demo-task', status: '__proto__' }], [{ id: 'demo-task', status: 'toString' }], [{ id: 'demo-task', status: 'SUCCESSED' }, { id: 'other-task', status: 'SUCCESSED' }]]) assert.equal(parseTask(body, { taskId: 'demo-task' }).state, 'unconfirmed');
});

test('failed task diagnostics are bounded and never include arbitrary task payloads', () => {
  const result = parseTask([{ id: 'demo-task', status: 'FAILED', error_code: 'ResourceLocked', error_message: 'Busy\u0000: retry later', args: { ignored: 'payload' }, stack: 'ignored' }], { taskId: 'demo-task' });
  assert.equal(result.errorCode, 'ResourceLocked'); assert.equal(result.errorMessage, 'Busy: retry later'); assert.equal(result.args, undefined); assert.equal(result.stack, undefined);
});

test('disk addition builds documented new-volume or existing-volume arrays, never a bulk selector', () => {
  assert.deepEqual(build('vm.hardware.disk.add', { mode: 'new', bus: 'VIRTIO', boot: 0, name: 'Demo data', size: 8589934592, size_unit: 'B' }), {
    operationId: 'AddVmDisk', body: { where: { id: resource.id }, data: { vm_disks: { mount_new_create_disks: [{ bus: 'VIRTIO', boot: 0, vm_volume: { name: 'Demo data', size: 8589934592, size_unit: 'B' } }] } } },
  });
  assert.deepEqual(build('vm.hardware.disk.add', { mode: 'existing', bus: 'SCSI', boot: 1, vm_volume_id: 'spare-volume' }).body, {
    where: { id: resource.id }, data: { vm_disks: { mount_disks: [{ bus: 'SCSI', boot: 1, vm_volume_id: 'spare-volume' }] } },
  });
  rejects(() => build('vm.hardware.disk.add', { mode: 'new', bus: 'VIRTIO', boot: 0, name: 'Demo', size: 8, size_unit: 'GB', vm_volume_id: 'spare-volume' }), 'INVALID_FORM_VALUES');
  rejects(() => build('vm.hardware.disk.add', { mode: 'existing', bus: 'VIRTIO', boot: false, vm_volume_id: 'spare-volume' }), 'INVALID_NONNEGATIVE_INTEGER');
  rejects(() => build('vm.hardware.disk.add', { mode: 'existing', bus: 'NVME', boot: 0, vm_volume_id: 'spare-volume' }), 'INVALID_DISK_BUS');
});

test('new disk sizes use exact bytes and existing volumes must be empty, idle and same-cluster', () => {
  assert.equal(build('vm.hardware.disk.add', { mode: 'new', bus: 'VIRTIO', boot: 0, name: 'Demo', size: 8, size_unit: 'B' }).body.data.vm_disks.mount_new_create_disks[0].vm_volume.size, 8);
  for (const size_unit of ['KB', 'MB', 'GB', 'TB', 'PB', 'GiB', '', null]) rejects(() => build('vm.hardware.disk.add', { mode: 'new', bus: 'VIRTIO', boot: 0, name: 'Demo', size: 8, size_unit }), 'INVALID_SIZE_UNIT');
  const values = { mode: 'existing', bus: 'VIRTIO', boot: 0, vm_volume_id: 'spare-volume' };
  for (const volume of [
    { id: 'spare-volume', cluster: { id: 'other-cluster' }, vm_disks: [] },
    { id: 'spare-volume', cluster: snapshot.cluster, vm_disks: [], entityAsyncStatus: 'UPDATING' },
  ]) rejects(() => build('vm.hardware.disk.add', values, { availableVolumes: [volume] }), 'CHOICE_NOT_IN_VM_CLUSTER');
  for (const vm_disks of [undefined, [{ id: 'in-use-disk' }]]) rejects(() => build('vm.hardware.disk.add', values, { availableVolumes: [{ id: 'spare-volume', cluster: snapshot.cluster, vm_disks }] }), 'VOLUME_NOT_CONFIRMED_UNATTACHED');
  rejects(() => build('vm.hardware.disk.add', { ...values, vm_volume_id: resource.id }), 'DEVICE_PREFLIGHT_REQUIRED');
});

test('disk editing and removal require exact owned DISK identity, not CD-ROM or parent ID', () => {
  assert.deepEqual(build('vm.hardware.disk.edit', { vm_disk_id: 'vm-disk', bus: 'SCSI' }), { operationId: 'UpdateVmDisk', body: { where: { id: resource.id }, data: { vm_disk_id: 'vm-disk', bus: 'SCSI' } } });
  assert.deepEqual(build('vm.hardware.disk.remove', { vm_disk_id: 'vm-disk' }), { operationId: 'RemoveVmDisk', body: { where: { id: resource.id }, data: { disk_ids: ['vm-disk'] } } });
  for (const type of ['CD_ROM', undefined]) rejects(() => build('vm.hardware.disk.remove', { vm_disk_id: 'vm-disk' }, { vm_disks: [{ ...snapshot.vm_disks[0], type }] }), 'DEVICE_NOT_OWNED_OR_READY');
  rejects(() => build('vm.hardware.disk.edit', { vm_disk_id: resource.id, bus: 'SCSI' }), 'DEVICE_PREFLIGHT_REQUIRED');
  for (const disk of [
    { ...snapshot.vm_disks[0], vm: { id: 'other-vm' } }, { ...snapshot.vm_disks[0], vm: undefined },
    { ...snapshot.vm_disks[0], entityAsyncStatus: 'UPDATING' },
  ]) rejects(() => build('vm.hardware.disk.remove', { vm_disk_id: 'vm-disk' }, { vm_disks: [disk] }), 'DEVICE_NOT_OWNED_OR_READY');
});

test('disk expansion targets the child disk and only increases its exact fresh byte size', () => {
  assert.deepEqual(build('vm.hardware.disk.expand', { vm_disk_id: 'vm-disk', size: 8192, size_unit: 'B' }), { operationId: 'ExpandVmDisk', body: { where: { id: 'vm-disk', vm: { id: resource.id } }, size: 8192, size_unit: 'B' } });
  for (const size of [2048, 4096]) rejects(() => build('vm.hardware.disk.expand', { vm_disk_id: 'vm-disk', size, size_unit: 'B' }), 'DISK_SIZE_MUST_INCREASE');
  rejects(() => build('vm.hardware.disk.expand', { vm_disk_id: 'vm-disk', size: 8, size_unit: 'GB' }), 'DISK_EXPANSION_BYTES_REQUIRED');
  rejects(() => build('vm.hardware.disk.expand', { vm_disk_id: 'vm-disk', size: 8192, size_unit: 'B' }, { vm_disks: [{ ...snapshot.vm_disks[0], vm_volume: { id: 'attached-volume' } }] }), 'DISK_CURRENT_SIZE_REQUIRED');
  rejects(() => build('vm.hardware.disk.expand', { vm_disk_id: 'vm-disk', size: 8192, size_unit: 'B' }, { vm_disks: [{ ...snapshot.vm_disks[0], vm_volume: { id: 'attached-volume', size: '4096' } }] }), 'DISK_CURRENT_SIZE_REQUIRED');
  for (const size of [-1, Number.MAX_SAFE_INTEGER + 1, Infinity]) rejects(() => build('vm.hardware.disk.expand', { vm_disk_id: 'vm-disk', size: 8192, size_unit: 'B' }, { vm_disks: [{ ...snapshot.vm_disks[0], vm_volume: { id: 'attached-volume', size } }] }), 'DISK_CURRENT_SIZE_REQUIRED');
  const latest = { vm_disks: [{ ...snapshot.vm_disks[0], vm_volume: { id: 'attached-volume', size: 16384 } }] };
  rejects(() => buildActionRequest({ actionId: 'vm.hardware.disk.expand', resource, snapshot, choices: latest, values: { vm_disk_id: 'vm-disk', size: 8192, size_unit: 'B' } }), 'DISK_SIZE_MUST_INCREASE');
  const options = { operationId: 'ExpandVmDisk', resourceId: resource.id };
  assert.equal(parseSubmission([{ task_id: 'expand-task', data: { id: resource.id } }], options).state, 'pending');
  assert.equal(parseSubmission([{ task_id: 'expand-task', data: { id: 'vm-disk' } }], { ...options, targetId: 'vm-disk' }).state, 'unconfirmed');
});

test('NIC addition builds one documented VLAN NIC and rejects unsupported network models or guessed scope', () => {
  assert.deepEqual(build('vm.hardware.nic.add', { connect_vlan_id: 'vm-vlan', model: 'VIRTIO', enabled: true }), { operationId: 'AddVmNic', body: { where: { id: resource.id }, data: { vm_nics: [{ type: 'VLAN', connect_vlan_id: 'vm-vlan', model: 'VIRTIO', enabled: true }] } } });
  rejects(() => build('vm.hardware.nic.add', { connect_vlan_id: 'vm-vlan', model: 'SRIOV', enabled: true }), 'NIC_MODEL_UNSUPPORTED');
  rejects(() => build('vm.hardware.nic.add', { connect_vlan_id: 'vm-vlan', model: 'VIRTIO', enabled: 'true' }), 'INVALID_BOOLEAN');
  rejects(() => build('vm.hardware.nic.add', { connect_vlan_id: 'vm-vlan', model: 'VIRTIO', enabled: true }, { availableVlans: [{ id: 'vm-vlan', cluster: { id: 'other-cluster' } }] }), 'CHOICE_NOT_IN_VM_CLUSTER');
});

test('NIC editing and removal bind exact child and parent IDs without requiring or deriving an index', () => {
  const where = { id: 'vm-nic', vm: { id: resource.id } };
  const expectedEdit = { operationId: 'UpdateVmNicAdvanceInfo', body: { where, data: { connect_vlan_id: 'vm-vlan', enabled: false } } };
  assert.deepEqual(build('vm.hardware.nic.edit', { vm_nic_id: 'vm-nic', connect_vlan_id: 'vm-vlan', enabled: false }), expectedEdit);
  const expectedRemove = { operationId: 'RemoveVmNicByWhere', body: { where, effect: { vm_ids: [resource.id] } } };
  assert.deepEqual(build('vm.hardware.nic.remove', { vm_nic_id: 'vm-nic' }), expectedRemove);
  for (const nic of [snapshot.vm_nics[0], { ...snapshot.vm_nics[0], order: null }, { ...snapshot.vm_nics[0], nic_index: 7, order: 99 }]) {
    const vm_nics = [{ ...nic, id: 'another-nic', nic_index: 7, order: 99 }, nic];
    assert.deepEqual(build('vm.hardware.nic.remove', { vm_nic_id: 'vm-nic' }, { vm_nics }), expectedRemove);
    assert.deepEqual(build('vm.hardware.nic.edit', { vm_nic_id: 'vm-nic', connect_vlan_id: 'vm-vlan', enabled: false }, { vm_nics }), expectedEdit);
  }
  for (const injected of [{ nic_index: 0 }, { order: 0 }, { model: 'E1000' }, { vm_id: 'other-vm' }, { effect: { vm_ids: [] } }]) rejects(() => build('vm.hardware.nic.edit', { vm_nic_id: 'vm-nic', enabled: false, ...injected }), 'INVALID_FORM_VALUES');
  for (const injected of [{ nic_index: [0] }, { order: 0 }, { where: {} }, { vm_ids: ['other-vm'] }, { effect: { vm_ids: [] } }]) rejects(() => build('vm.hardware.nic.remove', { vm_nic_id: 'vm-nic', ...injected }), 'INVALID_FORM_VALUES');
  rejects(() => build('vm.hardware.nic.edit', { vm_nic_id: 'vm-nic' }), 'EMPTY_UPDATE');
  for (const actionId of ['vm.hardware.nic.edit', 'vm.hardware.nic.remove']) {
    const values = actionId.endsWith('edit') ? { vm_nic_id: 'vm-nic', enabled: false } : { vm_nic_id: 'vm-nic' };
    rejects(() => build(actionId, values, { vm_nics: [snapshot.vm_nics[0], snapshot.vm_nics[0]] }), 'DEVICE_NOT_OWNED_OR_READY');
    for (const nic of [{ ...snapshot.vm_nics[0], vm: { id: 'other-vm' } }, { ...snapshot.vm_nics[0], vm: undefined }, { ...snapshot.vm_nics[0], type: 'VPC' }, { ...snapshot.vm_nics[0], entityAsyncStatus: 'UPDATING' }]) rejects(() => build(actionId, values, { vm_nics: [nic] }), 'DEVICE_NOT_OWNED_OR_READY');
    for (const nic of [{ ...snapshot.vm_nics[0], model: 'SRIOV' }, { ...snapshot.vm_nics[0], vpc_nic: { id: 'vpc-a' } }]) rejects(() => build(actionId, values, { vm_nics: [nic] }), 'NIC_TYPE_UNSUPPORTED');
  }
  for (const operationId of ['UpdateVmNicAdvanceInfo', 'RemoveVmNicByWhere']) assert.equal(parseSubmission([{ task_id: 'nic-task', data: { id: resource.id } }], { operationId, resourceId: resource.id }).state, 'pending');
  for (const operationId of ['UpdateVmNic', 'RemoveVmNic']) assert.equal(parseSubmission([{ task_id: 'nic-task', data: { id: resource.id } }], { operationId, resourceId: resource.id }).state, 'unconfirmed');
});

test('MAC input is optional, valid unicast and nonduplicating; empty input is not a clear command', () => {
  const values = { connect_vlan_id: 'vm-vlan', model: 'VIRTIO', enabled: true };
  assert.equal(build('vm.hardware.nic.add', { ...values, mac_address: '02:00:00:00:00:02' }).body.data.vm_nics[0].mac_address, '02:00:00:00:00:02');
  for (const mac_address of ['', 'not-a-mac', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:00:00:00:01']) rejects(() => build('vm.hardware.nic.add', { ...values, mac_address }), 'INVALID_MAC_ADDRESS');
  rejects(() => build('vm.hardware.nic.add', { ...values, mac_address: '02:00:00:00:00:01' }), 'DUPLICATE_MAC_ADDRESS');
  assert.equal(build('vm.hardware.nic.edit', { vm_nic_id: 'vm-nic', mac_address: '02:00:00:00:00:01' }).body.data.mac_address, '02:00:00:00:00:01');
});

test('snapshot deletion uses the owned snapshot selector and parser validates its child response ID', () => {
  assert.deepEqual(build('vm.snapshots.delete', { snapshot_id: 'restore-point' }), { operationId: 'DeleteVmSnapshot', body: { where: { id: 'restore-point', vm: { id: resource.id } } } });
  rejects(() => build('vm.snapshots.delete', { snapshot_id: resource.id }), 'DEVICE_PREFLIGHT_REQUIRED');
  rejects(() => build('vm.snapshots.delete', { snapshot_id: 'restore-point' }, { snapshots: [{ id: 'restore-point', vm: { id: 'other-vm' } }] }), 'DEVICE_NOT_OWNED_OR_READY');
  const response = [{ task_id: 'delete-task', data: { id: 'restore-point' } }], options = { operationId: 'DeleteVmSnapshot', resourceId: resource.id, targetId: 'restore-point' };
  assert.equal(parseSubmission(response, options).state, 'pending');
  assert.equal(parseSubmission([{ task_id: null, data: { id: 'restore-point' } }], options).state, 'synchronous');
  assert.equal(parseSubmission(response, { operationId: options.operationId, resourceId: resource.id }).state, 'unconfirmed');
  assert.equal(parseSubmission([{ task_id: 'restore-point', data: { id: 'restore-point' } }], options).state, 'unconfirmed');
});

test('device selectors reject ambiguous records and every added form rejects raw payload injection', () => {
  rejects(() => build('vm.hardware.disk.remove', { vm_disk_id: 'vm-disk' }, { vm_disks: [snapshot.vm_disks[0], snapshot.vm_disks[0]] }), 'DEVICE_NOT_OWNED_OR_READY');
  for (const [action, values] of [
    ['vm.hardware.disk.add', { mode: 'existing', bus: 'VIRTIO', boot: 0, vm_volume_id: 'spare-volume' }],
    ['vm.hardware.disk.edit', { vm_disk_id: 'vm-disk', bus: 'SCSI' }],
    ['vm.hardware.disk.expand', { vm_disk_id: 'vm-disk', size: 8192, size_unit: 'B' }],
    ['vm.hardware.disk.remove', { vm_disk_id: 'vm-disk' }],
    ['vm.hardware.nic.add', { connect_vlan_id: 'vm-vlan', model: 'VIRTIO', enabled: true }],
    ['vm.hardware.nic.edit', { vm_nic_id: 'vm-nic', enabled: false }],
    ['vm.hardware.nic.remove', { vm_nic_id: 'vm-nic' }],
    ['vm.snapshots.delete', { snapshot_id: 'restore-point' }],
  ]) {
    rejects(() => build(action, { ...values, where: {} }), 'INVALID_FORM_VALUES');
    rejects(() => build(action, values, { hasActiveTask: true }), 'VM_PRECONDITION_busy');
  }
});

test('explicit choices supply lists without replacing authoritative VM identity or state', () => {
  const choices = { id: 'forged-vm', type: 'vm', status: 'RUNNING', cluster: { id: 'forged-cluster' },
    vm_disks: [{ ...snapshot.vm_disks[0], id: 'fresh-disk' }] };
  const result = buildActionRequest({ actionId: 'vm.hardware.disk.edit', resource, snapshot, choices, values: { vm_disk_id: 'fresh-disk', bus: 'SCSI' } });
  assert.deepEqual(result.body, { where: { id: resource.id }, data: { vm_disk_id: 'fresh-disk', bus: 'SCSI' } });
  assert.equal(snapshot.status, 'STOPPED');
  rejects(() => buildActionRequest({ actionId: 'vm.hardware.disk.edit', resource, snapshot: { ...snapshot, status: 'RUNNING' }, choices: { ...choices, status: 'STOPPED' }, values: { vm_disk_id: 'fresh-disk', bus: 'SCSI' } }), 'VM_PRECONDITION_state');
  rejects(() => buildActionRequest({ actionId: 'vm.hardware.disk.edit', resource, snapshot: { ...snapshot, protected: true }, choices: { ...choices, protected: false }, values: { vm_disk_id: 'fresh-disk', bus: 'SCSI' } }), 'VM_PRECONDITION_protected');
});

test('explicit empty or null choices never reuse stale device, snapshot or host lists', () => {
  for (const choices of [{}, null, { vm_disks: [], vm_nics: [], snapshots: [], availableHosts: [] }]) {
    assert.throws(() => buildActionRequest({ actionId: 'vm.hardware.disk.remove', resource, snapshot, choices, values: { vm_disk_id: 'vm-disk' } }));
    assert.throws(() => buildActionRequest({ actionId: 'vm.hardware.nic.remove', resource, snapshot, choices, values: { vm_nic_id: 'vm-nic' } }));
    assert.throws(() => buildActionRequest({ actionId: 'vm.snapshots.restore', resource, snapshot, choices, values: { snapshot_id: 'restore-point' } }));
    assert.throws(() => buildActionRequest({ actionId: 'vm.migration.withinCluster', resource, snapshot, choices, values: { host_id: 'target-host' } }));
  }
});

test('choices identity and cluster fields cannot make foreign child devices or networks eligible', () => {
  const choices = { id: 'other-vm', cluster: { id: 'other-cluster' }, status: 'STOPPED',
    vm_disks: [{ id: 'foreign-disk', type: 'DISK', vm: { id: 'other-vm' } }],
    vm_nics: [{ id: 'foreign-nic', type: 'VLAN', nic_index: 0, vm: { id: 'other-vm' } }],
    snapshots: [{ id: 'foreign-snapshot', vm: { id: 'other-vm' } }],
    availableVlans: [{ id: 'foreign-vlan', cluster: { id: 'other-cluster' } }],
    availableHosts: [{ id: 'foreign-host', cluster: { id: 'other-cluster' }, status: 'CONNECTED_HEALTHY' }],
  };
  for (const [actionId, values] of [['vm.hardware.disk.remove', { vm_disk_id: 'foreign-disk' }], ['vm.hardware.nic.remove', { vm_nic_id: 'foreign-nic' }], ['vm.snapshots.delete', { snapshot_id: 'foreign-snapshot' }]]) {
    rejects(() => buildActionRequest({ actionId, resource, snapshot, choices, values }), 'DEVICE_NOT_OWNED_OR_READY');
  }
  rejects(() => buildActionRequest({ actionId: 'vm.hardware.nic.add', resource, snapshot, choices, values: { connect_vlan_id: 'foreign-vlan', model: 'VIRTIO', enabled: true } }), 'CHOICE_NOT_IN_VM_CLUSTER');
  rejects(() => buildActionRequest({ actionId: 'vm.migration.withinCluster', resource, snapshot, choices, values: { host_id: 'foreign-host' } }), 'HOST_NOT_ELIGIBLE');
});

test('fresh NIC and snapshot IDs come only from explicit choices, not old snapshot relations', () => {
  const choices = { vm_nics: [{ ...snapshot.vm_nics[0], id: 'fresh-nic' }], snapshots: [{ id: 'fresh-snapshot', vm: { id: resource.id } }] };
  assert.deepEqual(buildActionRequest({ actionId: 'vm.hardware.nic.remove', resource, snapshot, choices, values: { vm_nic_id: 'fresh-nic' } }).body, { where: { id: 'fresh-nic', vm: { id: resource.id } }, effect: { vm_ids: [resource.id] } });
  rejects(() => buildActionRequest({ actionId: 'vm.hardware.nic.remove', resource, snapshot, choices, values: { vm_nic_id: 'vm-nic' } }), 'DEVICE_NOT_OWNED_OR_READY');
  assert.equal(buildActionRequest({ actionId: 'vm.snapshots.restore', resource, snapshot, choices, values: { snapshot_id: 'fresh-snapshot' } }).body.data.snapshot_id, 'fresh-snapshot');
  rejects(() => buildActionRequest({ actionId: 'vm.snapshots.restore', resource, snapshot, choices, values: { snapshot_id: 'restore-point' } }), 'DEVICE_NOT_OWNED_OR_READY');
});

test('choices cannot override VM host identity for migration or source cluster for clone', () => {
  const choices = { cluster: { id: 'other-cluster' }, host: { id: 'different-current' }, availableHosts: [{ id: 'source-host', cluster: snapshot.cluster, status: 'CONNECTED_HEALTHY' }] };
  rejects(() => buildActionRequest({ actionId: 'vm.migration.withinCluster', resource, snapshot, choices, values: { host_id: 'source-host' } }), 'MIGRATION_TARGET_IS_CURRENT_HOST');
  assert.equal(buildActionRequest({ actionId: 'vm.clone', resource, snapshot, choices, values: { name: 'Demo copy' } }).body[0].cluster_id, snapshot.cluster.id);
});
