import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFields, initialValues, fieldValues } from '../src/actions/forms.js';
import { buildActionRequest } from '../src/actions/requests.js';

const resource = { type: 'vm', id: 'vm-a' };
function state() {
  return {
    id: 'vm-a', name: 'VM A', status: 'STOPPED', protected: false, internal: false, in_recycle_bin: false,
    cluster: { id: 'cluster-a' }, host: { id: 'host-current' }, gpu_devices: [], pci_nics: [], usb_devices: [],
    vm_disks: [
      { id: 'disk-a', type: 'DISK', bus: 'VIRTIO', vm: { id: 'vm-a' }, vm_volume: { id: 'volume-a', size: 4096 } },
      { id: 'disk-b', type: 'DISK', bus: 'SCSI', vm: { id: 'vm-a' }, vm_volume: { id: 'volume-b', size: 9000 } },
    ],
    vm_nics: [
      { id: 'nic-a', type: 'VLAN', vm: { id: 'vm-a' }, vlan: { id: 'vlan-a' }, model: 'E1000', enabled: false, mac_address: '02:00:00:00:00:01' },
      { id: 'nic-b', type: 'VLAN', vm: { id: 'vm-a' }, vlan: { id: 'vlan-b' }, model: 'VIRTIO', enabled: true, mac_address: '02:00:00:00:00:02' },
    ],
    availableVolumes: [{ id: 'spare-volume', name: 'Spare', cluster: { id: 'cluster-a' }, vm_disks: [] }],
    availableVlans: [{ id: 'vlan-a', name: 'VLAN A', cluster: { id: 'cluster-a' } }, { id: 'vlan-b', name: 'VLAN B', cluster: { id: 'cluster-a' } }],
    snapshots: [{ id: 'snapshot-a', vm: { id: 'vm-a' }, name: 'Checkpoint' }],
    diskAddModes: ['new', 'existing'],
  };
}
const schema = (action, snapshot = state(), values = {}) => actionFields(action, snapshot, 'zh-CN', values);
const options = (fields, id) => fields.find(field => field.id === id).options.map(option => option.value);
function submission(actionId, input, snapshot = state()) {
  const fields = schema(actionId, snapshot, input), values = fieldValues(fields, { ...initialValues(fields), ...input });
  return { values, request: buildActionRequest({ actionId, resource, snapshot, values }) };
}

test('memory prefill preserves exact bytes without assuming API conversion factors', () => {
  for (const memory of [4000000000, '4000000000', 4294967296, '4294967296', Number.MAX_SAFE_INTEGER]) assert.deepEqual(initialValues(schema('vm.hardware.memory', { memory })), { memory: Number(memory), memory_unit: 'B' });
  for (const memory of [null, '', ' ', 0, -1, 1.5, NaN, Infinity, '9007199254740993', Number.MAX_SAFE_INTEGER + 1, true, '4GB']) {
    assert.deepEqual(initialValues(schema('vm.hardware.memory', { memory })), { memory_unit: 'B' });
  }
});

test('new disk form emits a precise mount-new request; switching source excludes obsolete new-volume fields', () => {
  const input = { mode: 'new', name: 'Data disk', size: '32', size_unit: 'B', bus: 'SCSI', boot: '0' };
  assert.deepEqual(submission('vm.hardware.disk.add', input).request, {
    operationId: 'AddVmDisk', body: { where: { id: 'vm-a' }, data: { vm_disks: { mount_new_create_disks: [{ bus: 'SCSI', boot: 0, vm_volume: { name: 'Data disk', size: 32, size_unit: 'B' } }] } } },
  });
  const existing = submission('vm.hardware.disk.add', { ...input, mode: 'existing', vm_volume_id: 'spare-volume' });
  assert.deepEqual(existing.values, { mode: 'existing', bus: 'SCSI', boot: 0, vm_volume_id: 'spare-volume' });
  assert.deepEqual(existing.request.body.data.vm_disks, { mount_disks: [{ bus: 'SCSI', boot: 0, vm_volume_id: 'spare-volume' }] });
  assert.throws(() => fieldValues(schema('vm.hardware.disk.add'), { ...input, mode: 'existing', vm_volume_id: 'spare-volume' }), /INVALID_FORM_VALUE/, 'a mode change must rebuild dependent fields before submission');
});

test('disk attachment choices require an idle unique unattached same-cluster volume, not only a matching label', () => {
  const snapshot = state(); snapshot.availableVolumes.push(
    { id: 'foreign', name: 'Spare', cluster: { id: 'cluster-b' }, vm_disks: [] },
    { id: 'attached', cluster: { id: 'cluster-a' }, vm_disks: [{ id: 'some-disk' }] },
    { id: 'unknown-attachment', cluster: { id: 'cluster-a' } },
    { id: 'busy', cluster: { id: 'cluster-a' }, vm_disks: [], entityAsyncStatus: 'UPDATING' },
    { id: 'volume-a', cluster: { id: 'cluster-a' }, vm_disks: [] },
    { id: 'duplicate', cluster: { id: 'cluster-a' }, vm_disks: [] }, { id: 'duplicate', cluster: { id: 'cluster-a' }, vm_disks: [] },
  );
  const fields = schema('vm.hardware.disk.add', snapshot, { mode: 'existing' });
  assert.deepEqual(options(fields, 'vm_volume_id'), ['spare-volume']);
  for (const vm_volume_id of ['foreign', 'attached', 'busy', 'unknown-attachment', 'volume-a', 'duplicate', 'Spare']) {
    assert.throws(() => fieldValues(fields, { mode: 'existing', bus: 'VIRTIO', boot: 0, vm_volume_id }), /INVALID_FORM_VALUE/);
  }
});

test('disk edit and expansion bind dependency defaults and bounds to the selected disk, not its predecessor', () => {
  const snapshot = state(), first = schema('vm.hardware.disk.edit', snapshot, { vm_disk_id: 'disk-a' }), second = schema('vm.hardware.disk.edit', snapshot, { vm_disk_id: 'disk-b' });
  assert.deepEqual(initialValues(first), { vm_disk_id: 'disk-a', bus: 'VIRTIO' });
  assert.deepEqual(initialValues(second), { vm_disk_id: 'disk-b', bus: 'SCSI' });
  assert.throws(() => fieldValues(first, { vm_disk_id: 'disk-b', bus: 'VIRTIO' }), /INVALID_FORM_VALUE/);
  assert.deepEqual(submission('vm.hardware.disk.edit', { vm_disk_id: 'disk-b', bus: 'USB' }).request.body, { where: { id: 'vm-a' }, data: { vm_disk_id: 'disk-b', bus: 'USB' } });
  const expansion = schema('vm.hardware.disk.expand', snapshot, { vm_disk_id: 'disk-b' });
  assert.deepEqual(initialValues(expansion), { vm_disk_id: 'disk-b', size: 9000, size_unit: 'B' });
  for (const size of [1, 4097, 9000, '9000', '9000.5']) assert.throws(() => fieldValues(expansion, { vm_disk_id: 'disk-b', size, size_unit: 'B' }), /INVALID_FORM_VALUE/);
  assert.throws(() => fieldValues(expansion, { vm_disk_id: 'disk-b', size: 10000, size_unit: 'GB' }), /INVALID_FORM_VALUE/);
  assert.deepEqual(submission('vm.hardware.disk.expand', { vm_disk_id: 'disk-b', size: '10000', size_unit: 'B' }).request.body, { where: { id: 'disk-b', vm: { id: 'vm-a' } }, size: 10000, size_unit: 'B' });
});

test('disk choices reject foreign, orphan, busy, duplicate and non-disk children; expansion needs exact fresh size', () => {
  const snapshot = state(); snapshot.vm_disks.push(
    { id: 'foreign', type: 'DISK', vm: { id: 'vm-b' } }, { id: 'orphan', type: 'DISK' },
    { id: 'cdrom', type: 'CD_ROM', vm: { id: 'vm-a' } },
    { ...snapshot.vm_disks[0], id: 'busy', entityAsyncStatus: 'UPDATING' },
    { ...snapshot.vm_disks[0], id: 'duplicate' }, { ...snapshot.vm_disks[0], id: 'duplicate' },
  );
  assert.deepEqual(options(schema('vm.hardware.disk.remove', snapshot), 'vm_disk_id'), ['disk-a', 'disk-b']);
  for (const size of [undefined, null, '4096', -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const current = state(); current.vm_disks = [{ ...current.vm_disks[0], vm_volume: { id: 'volume-a', size } }];
    assert.deepEqual(options(schema('vm.hardware.disk.expand', current), 'vm_disk_id'), []);
  }
  assert.deepEqual(submission('vm.hardware.disk.remove', { vm_disk_id: 'disk-a', id: 'foreign' }).request.body, { where: { id: 'vm-a' }, data: { disk_ids: ['disk-a'] } });
});

test('NIC edit pre-fills mutable fields and targets the exact owned NIC ID without requiring an index', () => {
  const snapshot = state(), first = schema('vm.hardware.nic.edit', snapshot, { vm_nic_id: 'nic-a' }), second = schema('vm.hardware.nic.edit', snapshot, { vm_nic_id: 'nic-b' });
  assert.deepEqual(initialValues(first), { vm_nic_id: 'nic-a', connect_vlan_id: 'vlan-a', enabled: false, mac_address: '02:00:00:00:00:01' });
  assert.deepEqual(initialValues(second), { vm_nic_id: 'nic-b', connect_vlan_id: 'vlan-b', enabled: true, mac_address: '02:00:00:00:00:02' });
  assert.ok(!first.some(field => field.id === 'model'), 'the verified NIC edit operation does not accept model changes');
  assert.throws(() => fieldValues(first, { ...initialValues(first), vm_nic_id: 'nic-b' }), /INVALID_FORM_VALUE/);
  assert.deepEqual(submission('vm.hardware.nic.edit', { vm_nic_id: 'nic-b', enabled: false, mac_address: '', model: 'E1000' }).request, { operationId: 'UpdateVmNicAdvanceInfo', body: { where: { id: 'nic-b', vm: { id: 'vm-a' } }, data: { connect_vlan_id: 'vlan-b', enabled: false } } });
  assert.deepEqual(submission('vm.hardware.nic.remove', { vm_nic_id: 'nic-b', nic_index: 0 }).request, { operationId: 'RemoveVmNicByWhere', body: { where: { id: 'nic-b', vm: { id: 'vm-a' } }, effect: { vm_ids: ['vm-a'] } } });
});

test('NIC add emits a VLAN request, with explicit boolean false and blank optional MAC omitted', () => {
  const result = submission('vm.hardware.nic.add', { connect_vlan_id: 'vlan-a', model: 'E1000', enabled: false, mac_address: '' });
  assert.deepEqual(result.values, { connect_vlan_id: 'vlan-a', model: 'E1000', enabled: false });
  assert.deepEqual(result.request.body.data, { vm_nics: [{ type: 'VLAN', connect_vlan_id: 'vlan-a', model: 'E1000', enabled: false }] });
  for (const enabled of [undefined, 'false', 0, 1, null]) assert.throws(() => fieldValues(schema('vm.hardware.nic.add'), { connect_vlan_id: 'vlan-a', model: 'VIRTIO', enabled }), /INVALID_FORM_VALUE/);
  for (const model of ['SRIOV', 'virtio', 'VPC', '']) assert.throws(() => fieldValues(schema('vm.hardware.nic.add'), { connect_vlan_id: 'vlan-a', model, enabled: true }), /INVALID_FORM_VALUE/);
});

test('MAC values require unicast format and exclude other NICs case-insensitively, while retaining the selected NIC address', () => {
  const snapshot = state(); snapshot.vm_nics[0].mac_address = '0A:BC:DE:00:00:01';
  const fields = schema('vm.hardware.nic.add', snapshot), base = { connect_vlan_id: 'vlan-a', model: 'VIRTIO', enabled: true };
  for (const mac_address of ['0a:bc:de:00:00:01', '01:00:00:00:00:03', 'ff:ff:ff:ff:ff:ff', '00:00:00:00:00:00', '020000000003', '02-00-00-00-00-03', ' ', null]) {
    assert.throws(() => fieldValues(fields, { ...base, mac_address }), /INVALID_FORM_VALUE/);
  }
  assert.equal(fieldValues(fields, { ...base, mac_address: '02:00:00:00:00:03' }).mac_address, '02:00:00:00:00:03');
  assert.equal(submission('vm.hardware.nic.edit', { vm_nic_id: 'nic-a' }, snapshot).values.mac_address, '0A:BC:DE:00:00:01');
});

test('NIC selectors require unique owned VLAN identities, with no dependency on indices or order', () => {
  for (const change of [{ vm: { id: 'vm-b' } }, { vm: undefined }, { type: 'VPC' }, { model: 'SRIOV' }, { vpc_nic: { id: 'vpc-a' } }, { entityAsyncStatus: 'UPDATING' }]) {
    const snapshot = state(); snapshot.vm_nics = [{ ...snapshot.vm_nics[0], ...change }];
    assert.deepEqual(options(schema('vm.hardware.nic.remove', snapshot), 'vm_nic_id'), []);
  }
  const snapshot = state(); snapshot.vm_nics[1].id = 'nic-a';
  assert.deepEqual(options(schema('vm.hardware.nic.remove', snapshot), 'vm_nic_id'), []);
  for (const change of [{}, { nic_index: -1 }, { nic_index: 0.5 }, { nic_index: 0, order: 99 }]) {
    const fresh = state(); fresh.vm_nics = [{ ...fresh.vm_nics[0], ...change }];
    assert.deepEqual(options(schema('vm.hardware.nic.remove', fresh), 'vm_nic_id'), ['nic-a']);
  }
});

test('empty or unverified choices cannot submit disk, NIC, VLAN, snapshot, or migration selections', () => {
  const snapshot = { ...state(), vm_disks: [], vm_nics: [], availableVolumes: [], availableVlans: [], snapshots: [], availableHosts: [] };
  const cases = [
    ['vm.hardware.disk.add', { mode: 'existing', bus: 'VIRTIO', boot: 0, vm_volume_id: 'unread' }],
    ['vm.hardware.disk.edit', { vm_disk_id: 'unread', bus: 'SCSI' }], ['vm.hardware.disk.expand', { vm_disk_id: 'unread', size: 9000, size_unit: 'B' }], ['vm.hardware.disk.remove', { vm_disk_id: 'unread' }],
    ['vm.hardware.nic.add', { connect_vlan_id: 'unread', model: 'VIRTIO', enabled: true }], ['vm.hardware.nic.edit', { vm_nic_id: 'unread', connect_vlan_id: 'unread', enabled: true }], ['vm.hardware.nic.remove', { vm_nic_id: 'unread' }],
    ['vm.snapshots.delete', { snapshot_id: 'unread' }], ['vm.snapshots.restore', { snapshot_id: 'unread' }], ['vm.migration.withinCluster', { host_id: 'unread' }],
  ];
  for (const [action, values] of cases) assert.throws(() => fieldValues(schema(action, snapshot, values), values), /INVALID_FORM_VALUE/, action);
  for (const availableVlans of [undefined, [{ id: 'vlan-a' }], [{ id: 'vlan-a', cluster: { id: 'cluster-b' } }], [{ id: 'vlan-a', cluster: snapshot.cluster, entityAsyncStatus: 'UPDATING' }]]) {
    assert.deepEqual(options(schema('vm.hardware.nic.add', { ...snapshot, availableVlans }), 'connect_vlan_id'), []);
  }
});

test('snapshot deletion presents only unique idle explicitly owned snapshots and sends the child identity', () => {
  const snapshot = state(); snapshot.snapshots.push({ id: 'foreign', vm: { id: 'vm-b' } }, { id: 'orphan' }, { id: 'busy', vm: { id: 'vm-a' }, entityAsyncStatus: 'DELETING' }, { id: 'duplicate', vm: { id: 'vm-a' } }, { id: 'duplicate', vm: { id: 'vm-a' } });
  assert.deepEqual(options(schema('vm.snapshots.delete', snapshot), 'snapshot_id'), ['snapshot-a']);
  assert.deepEqual(submission('vm.snapshots.delete', { snapshot_id: 'snapshot-a' }, snapshot).request, { operationId: 'DeleteVmSnapshot', body: { where: { id: 'snapshot-a', vm: { id: resource.id } } } });
});

test('numeric fields reject ambiguous coercions and names remain bounded instead of silently truncated', () => {
  const base = { mode: 'new', name: 'Data', size: 8, size_unit: 'B', bus: 'VIRTIO', boot: 0 }, fields = schema('vm.hardware.disk.add');
  for (const boot of [true, false, null, -1, 0.5, '1e2', '0x10', 2147483648]) assert.throws(() => fieldValues(fields, { ...base, boot }), /INVALID_FORM_VALUE/);
  for (const size of ['', true, [], 0, -1, 1.5, '1e3', '0x10', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => fieldValues(fields, { ...base, size }), /INVALID_FORM_VALUE/);
  for (const bus of ['virtio', 'NVME', '', true]) assert.throws(() => fieldValues(fields, { ...base, bus }), /INVALID_FORM_VALUE/);
  assert.equal(fieldValues(fields, { ...base, name: 'A'.repeat(128) }).name.length, 128);
  assert.throws(() => fieldValues(fields, { ...base, name: 'A'.repeat(129) }), /INVALID_FORM_VALUE/);
  assert.throws(() => fieldValues(fields, { ...base, name: '  ' }), /INVALID_FORM_VALUE/);
  assert.deepEqual(options(fields, 'size_unit'), ['B'], 'first-stage form intentionally narrows the wider SDK ByteUnit enum');
  for (const size_unit of ['KB', 'MB', 'GB', 'TB', 'PB']) assert.throws(() => fieldValues(fields, { ...base, size_unit }), /INVALID_FORM_VALUE/);
});

test('independent choices cannot overwrite snapshot identity, hardware fields or VM/cluster ownership', () => {
  const snapshot = { ...state(), vcpu: 8, cpu: { sockets: 2, cores: 4 }, memory: 4000000000 }, before = JSON.stringify(snapshot);
  const choices = {
    id: 'vm-b', type: 'host', status: 'RUNNING', vm: { id: 'vm-b' }, cluster: { id: 'cluster-b' }, name: 'Forged VM', vcpu: 99, cpu: { sockets: 99, cores: 99 }, memory: 1,
    vm_disks: [{ ...snapshot.vm_disks[1], id: 'fresh-own' }, { ...snapshot.vm_disks[0], id: 'foreign', vm: { id: 'vm-b' } }],
    snapshots: [{ id: 'fresh-snapshot', vm: { id: 'vm-a' } }, { id: 'foreign-snapshot', vm: { id: 'vm-b' } }],
    availableVlans: [{ id: 'fresh-vlan', cluster: { id: 'cluster-a' } }, { id: 'foreign-vlan', cluster: { id: 'cluster-b' } }],
  };
  const read = action => actionFields(action, snapshot, 'zh-CN', {}, choices);
  assert.deepEqual(options(read('vm.hardware.disk.remove'), 'vm_disk_id'), ['fresh-own']);
  assert.deepEqual(options(read('vm.snapshots.delete'), 'snapshot_id'), ['fresh-snapshot']);
  assert.deepEqual(options(read('vm.hardware.nic.add'), 'connect_vlan_id'), ['fresh-vlan']);
  assert.deepEqual(initialValues(read('vm.hardware.cpu')), { vcpu: 8, cpu_sockets: 2, cpu_cores: 4 });
  assert.deepEqual(initialValues(read('vm.hardware.memory')), { memory: 4000000000, memory_unit: 'B' });
  assert.equal(initialValues(read('vm.general.edit')).name, 'VM A');
  assert.equal(JSON.stringify(snapshot), before);
});

test('explicitly empty independent choices never fall back to stale snapshot lists', () => {
  const snapshot = state(); snapshot.availableHosts = [{ id: 'host-next', cluster: snapshot.cluster, status: 'CONNECTED_HEALTHY' }];
  const cases = [
    ['vm.hardware.disk.remove', 'vm_disk_id', {}], ['vm.hardware.nic.remove', 'vm_nic_id', {}],
    ['vm.hardware.nic.add', 'connect_vlan_id', {}], ['vm.snapshots.restore', 'snapshot_id', {}], ['vm.snapshots.delete', 'snapshot_id', {}],
    ['vm.migration.withinCluster', 'host_id', {}], ['vm.hardware.disk.add', 'vm_volume_id', { mode: 'existing' }],
  ];
  for (const choices of [{}, { vm_disks: [], vm_nics: [], snapshots: [], availableHosts: [], availableVolumes: [], availableVlans: [] }]) {
    for (const [action, id, draft] of cases) {
      const fields = actionFields(action, snapshot, 'zh-CN', draft, choices);
      assert.deepEqual(options(fields, id), [], action);
      assert.throws(() => fieldValues(fields, { ...initialValues(fields), [id]: 'unverified' }), /INVALID_FORM_VALUE/, action);
    }
  }
});

test('NIC ID uniqueness and MAC duplication are checked against independent choices rather than stale snapshot devices', () => {
  const snapshot = state(), duplicateId = { vm_nics: [snapshot.vm_nics[0], { ...snapshot.vm_nics[1], id: 'nic-a' }] };
  assert.deepEqual(options(actionFields('vm.hardware.nic.remove', snapshot, 'zh-CN', {}, duplicateId), 'vm_nic_id'), []);
  const choices = { vm_nics: [{ ...snapshot.vm_nics[0], mac_address: '02:00:00:00:00:AA' }], availableVlans: snapshot.availableVlans };
  snapshot.vm_nics = [{ id: 'stale-device', nic_index: 3 }];
  assert.deepEqual(options(actionFields('vm.hardware.nic.remove', snapshot, 'zh-CN', {}, choices), 'vm_nic_id'), ['nic-a']);
  const fields = actionFields('vm.hardware.nic.add', snapshot, 'zh-CN', {}, choices), base = { connect_vlan_id: 'vlan-a', model: 'VIRTIO', enabled: true };
  assert.throws(() => fieldValues(fields, { ...base, mac_address: '02:00:00:00:00:aa' }), /INVALID_FORM_VALUE/);
  assert.equal(fieldValues(fields, { ...base, mac_address: '02:00:00:00:00:01' }).mac_address, '02:00:00:00:00:01');
});

test('migration choices keep the authoritative current host and cluster boundary from the snapshot', () => {
  const snapshot = state(), choices = { cluster: { id: 'cluster-b' }, host: { id: 'host-next' }, availableHosts: [
    { id: 'host-current', cluster: { id: 'cluster-a' }, status: 'CONNECTED_HEALTHY' },
    { id: 'host-next', cluster: { id: 'cluster-a' }, status: 'CONNECTED_HEALTHY' },
    { id: 'host-foreign', cluster: { id: 'cluster-b' }, status: 'CONNECTED_HEALTHY' },
  ] };
  assert.deepEqual(options(actionFields('vm.migration.withinCluster', snapshot, 'zh-CN', {}, choices), 'host_id'), ['host-next']);
});

test('missing production disk modes default to existing volume attachment without inheriting demo modes from snapshot', () => {
  const snapshot = state(), choices = { availableVolumes: snapshot.availableVolumes, vm_disks: snapshot.vm_disks };
  const fields = actionFields('vm.hardware.disk.add', snapshot, 'zh-CN', {}, choices);
  assert.deepEqual(options(fields, 'mode'), ['existing']);
  assert.equal(initialValues(fields).mode, 'existing');
  assert.deepEqual(fields.map(field => field.id), ['mode', 'bus', 'boot', 'vm_volume_id']);
  assert.deepEqual(fieldValues(fields, { mode: 'existing', bus: 'VIRTIO', boot: 0, vm_volume_id: 'spare-volume' }), { mode: 'existing', bus: 'VIRTIO', boot: 0, vm_volume_id: 'spare-volume' });
  assert.deepEqual(options(actionFields('vm.hardware.disk.add', snapshot, 'zh-CN', {}, {}), 'mode'), ['existing']);
});

test('disk mode choices are whitelisted and unique; a removed or unsupported draft mode never silently changes intent', () => {
  const snapshot = state(), choices = { ...snapshot, diskAddModes: ['unknown', 'new', 'new', 'existing', 'existing', null] };
  const fields = actionFields('vm.hardware.disk.add', snapshot, 'zh-CN', {}, choices);
  assert.deepEqual(options(fields, 'mode'), ['new', 'existing']);
  assert.equal(initialValues(fields).mode, 'new', 'new is possible only because explicit choices include it');
  const draft = { mode: 'new', bus: 'VIRTIO', boot: 0, name: 'Unsubmitted disk', size: 4096, size_unit: 'B' };
  const narrowed = actionFields('vm.hardware.disk.add', snapshot, 'zh-CN', draft, { ...snapshot, diskAddModes: ['existing'] });
  assert.equal(initialValues(narrowed).mode, 'new');
  assert.deepEqual(options(narrowed, 'mode'), ['existing']);
  assert.throws(() => fieldValues(narrowed, draft), /INVALID_FORM_VALUE/);
  for (const diskAddModes of [[], ['unknown'], null, 'new', [true]]) {
    const denied = actionFields('vm.hardware.disk.add', snapshot, 'zh-CN', {}, { ...snapshot, diskAddModes });
    assert.deepEqual(options(denied, 'mode'), []);
    assert.throws(() => fieldValues(denied, draft), /INVALID_FORM_VALUE/);
  }
});

test('snapshot consistency options default to crash, filter unknown values and reject previously selected unsupported intent', () => {
  const snapshot = state(), read = (choices, values = {}) => actionFields('vm.snapshots.create', snapshot, 'zh-CN', values, choices);
  assert.deepEqual(options(read({}), 'consistent_type'), ['CRASH_CONSISTENT']);
  assert.deepEqual(initialValues(read({})), { consistent_type: 'CRASH_CONSISTENT' });
  const explicit = read({ consistentTypes: ['unknown', 'FILE_SYSTEM_CONSISTENT', 'FILE_SYSTEM_CONSISTENT', 'CRASH_CONSISTENT', null] });
  assert.deepEqual(options(explicit, 'consistent_type'), ['FILE_SYSTEM_CONSISTENT', 'CRASH_CONSISTENT']);
  assert.deepEqual(fieldValues(explicit, { name: 'Test checkpoint', consistent_type: 'FILE_SYSTEM_CONSISTENT' }), { name: 'Test checkpoint', consistent_type: 'FILE_SYSTEM_CONSISTENT' });
  const draft = { name: 'Test checkpoint', consistent_type: 'FILE_SYSTEM_CONSISTENT' };
  const narrowed = read({ consistentTypes: ['CRASH_CONSISTENT'] }, draft);
  assert.equal(initialValues(narrowed).consistent_type, 'FILE_SYSTEM_CONSISTENT');
  assert.throws(() => fieldValues(narrowed, draft), /INVALID_FORM_VALUE/);
  for (const consistentTypes of [[], ['unknown'], null, 'CRASH_CONSISTENT']) {
    const denied = read({ consistentTypes });
    assert.deepEqual(options(denied, 'consistent_type'), []);
    assert.throws(() => fieldValues(denied, { name: 'Test checkpoint', consistent_type: 'CRASH_CONSISTENT' }), /INVALID_FORM_VALUE/);
  }
});
