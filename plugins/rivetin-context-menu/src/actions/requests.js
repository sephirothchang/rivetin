import { buildActionTree } from './catalog.js';

// Pure builders/parsers, verified against the primary SDK v2.23.0 (Tower 4.9):
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/Vm.ts
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/VmSnapshot.ts
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/Task.ts
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/data-contracts.ts
// This module neither authorizes nor submits. The framework must independently
// authorize and freshly read the object immediately before confirmed execution.
// Production passes choices separately from the authoritative snapshot; do not
// merge them. choices.availableHosts is our normalized fresh GetHosts result,
// NOT a Vm API property: [{id,cluster:{id},status,entityAsyncStatus?}].
// choices.snapshots is the freshly read VM-owned snapshot relation.
// New hardware normalized choices (all re-read/verified by the host):
// vm_disks:[{id,type:'DISK',vm:{id},bus,vm_volume:{id,size}}]; size is bytes,
// resolved from the full VmVolume, not invented on SDK NestedVmVolume.
// vm_nics:[{id,type:'VLAN',vm:{id},model,enabled,mac_address?}]; NIC edits and
// removals select exact child and parent IDs, never an index or order value.
// availableVolumes:[{id,cluster:{id},vm_disks:[]}]
// and availableVlans:[{id,cluster:{id}}] are independently scope-checked choices,
// not raw Vm response fields. Busy, non-owned or ambiguous choices are rejected.

const power = {
  'vm.power.start': 'StartVm', 'vm.power.shutdown': 'ShutDownVm', 'vm.power.poweroff': 'PoweroffVm',
  'vm.power.restart': 'RestartVm', 'vm.power.forceRestart': 'ForceRestartVm',
  'vm.power.suspend': 'SuspendVm', 'vm.power.resume': 'ResumeVm',
};
export const REQUEST_OPERATIONS = Object.freeze({ ...power,
  'vm.general.edit': 'UpdateVm', 'vm.hardware.cpu': 'UpdateVm', 'vm.hardware.memory': 'UpdateVm',
  'vm.snapshots.create': 'CreateVmSnapshot', 'vm.snapshots.restore': 'RollbackVm',
  'vm.migration.withinCluster': 'MigrateVm', 'vm.clone': 'CloneVm',
  'vm.hardware.disk.add': 'AddVmDisk', 'vm.hardware.disk.edit': 'UpdateVmDisk',
  'vm.hardware.disk.expand': 'ExpandVmDisk', 'vm.hardware.disk.remove': 'RemoveVmDisk',
  'vm.hardware.nic.add': 'AddVmNic', 'vm.hardware.nic.edit': 'UpdateVmNicAdvanceInfo',
  'vm.hardware.nic.remove': 'RemoveVmNicByWhere', 'vm.snapshots.delete': 'DeleteVmSnapshot',
});
const ids = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function fields(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) fail('INVALID_FORM_VALUES');
}
function string(value, { empty = false, max = 255 } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('INVALID_TEXT');
  return value;
}
function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) fail('INVALID_POSITIVE_INTEGER');
  return value;
}
function nonnegativeInteger(value, max = 2147483647) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_NONNEGATIVE_INTEGER');
  return value;
}
function byteUnit(value) { if (value !== 'B') fail('INVALID_SIZE_UNIT'); return value; }
function diskBus(value) { if (!['IDE', 'SCSI', 'USB', 'VIRTIO'].includes(value)) fail('INVALID_DISK_BUS'); return value; }
function nicModel(value) { if (!['E1000', 'VIRTIO'].includes(value)) fail('NIC_MODEL_UNSUPPORTED'); return value; }
function boolean(value) { if (typeof value !== 'boolean') fail('INVALID_BOOLEAN'); return value; }
function records(choices, key) {
  if (!object(choices) || !Array.isArray(choices[key]) || choices[key].length > 5000) fail('DEVICE_PREFLIGHT_REQUIRED');
  return choices[key];
}
function owned(snapshot, choices, key, id, type) {
  if (!ids(id) || id === snapshot.id) fail('DEVICE_PREFLIGHT_REQUIRED');
  const found = records(choices, key).filter(item => item?.id === id);
  if (found.length !== 1 || found[0].vm?.id !== snapshot.id || found[0].entityAsyncStatus ||
    (type && found[0].type !== type)) fail('DEVICE_NOT_OWNED_OR_READY');
  return found[0];
}
function clusterChoice(snapshot, choices, key, id) {
  if (!ids(id) || id === snapshot.id || !ids(snapshot.cluster?.id)) fail('DEVICE_PREFLIGHT_REQUIRED');
  const found = records(choices, key).filter(item => item?.id === id);
  if (found.length !== 1 || found[0].cluster?.id !== snapshot.cluster.id || found[0].entityAsyncStatus) fail('CHOICE_NOT_IN_VM_CLUSTER');
  return found[0];
}
function network(snapshot, choices, id) { clusterChoice(snapshot, choices, 'availableVlans', id); return id; }
function selectedNic(snapshot, choices, id) {
  const nic = owned(snapshot, choices, 'vm_nics', id, 'VLAN');
  if (nic.model === 'SRIOV' || nic.vpc_nic) fail('NIC_TYPE_UNSUPPORTED');
  return nic;
}
function macAddress(value, choices, selectedId = null) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) ||
    (Number.parseInt(value.slice(0, 2), 16) & 1) || /^00(?::00){5}$/i.test(value)) fail('INVALID_MAC_ADDRESS');
  if (records(choices, 'vm_nics').some(item => item?.id !== selectedId && typeof item?.mac_address === 'string' && item.mac_address.toLowerCase() === value.toLowerCase())) fail('DUPLICATE_MAC_ADDRESS');
  return value;
}
function hostId(value, snapshot, choices) {
  if (!ids(value) || value === snapshot.id || !ids(snapshot.cluster?.id) || !object(choices) || !Array.isArray(choices.availableHosts) || choices.availableHosts.length > 5000) fail('HOST_PREFLIGHT_REQUIRED');
  const matches = choices.availableHosts.filter(host => host?.id === value);
  if (matches.length !== 1 || matches[0].cluster?.id !== snapshot.cluster.id ||
    matches[0].status !== 'CONNECTED_HEALTHY' || matches[0].entityAsyncStatus) fail('HOST_NOT_ELIGIBLE');
  return value;
}
function optionalHost(values, snapshot, choices) { return own(values, 'host_id') ? { host_id: hostId(values.host_id, snapshot, choices) } : {}; }
function preflight(actionId, resource, snapshot) {
  if (!own(REQUEST_OPERATIONS, actionId)) fail('ACTION_REQUEST_UNSUPPORTED');
  if (!resource || resource.type !== 'vm' || !ids(resource.id) || !snapshot || snapshot.id !== resource.id) fail('VM_PREFLIGHT_MISMATCH');
  if (snapshot.hasActiveTask === true) fail('VM_PRECONDITION_busy');
  // This synthetic permission ONLY asks the pure catalog to check object
  // preconditions. It is not passed to transport or treated as authorization.
  const item = buildActionTree({ resource, snapshot, capabilities: { [actionId]: { allowed: true } } })
    .flatMap(group => group.items).find(entry => entry.id === actionId);
  if (!item?.enabled) fail(`VM_PRECONDITION_${item?.reasonCode || 'UNKNOWN'}`);
}

// choices=snapshot retains the standalone pure-builder call shape. Production
// must explicitly supply the independent fresh choices response. An empty/null
// choices object never falls back to stale lists embedded in snapshot.
export function buildActionRequest({ actionId, resource, snapshot, values = {}, choices = snapshot } = {}) {
  preflight(actionId, resource, snapshot);
  const where = { id: resource.id }, operationId = REQUEST_OPERATIONS[actionId];
  if (own(power, actionId)) {
    fields(values, actionId === 'vm.power.start' ? ['host_id'] : []);
    const data = optionalHost(values, snapshot, choices);
    return { operationId, body: Object.keys(data).length ? { where, data } : { where } };
  }
  if (actionId === 'vm.general.edit') {
    fields(values, ['name', 'description']);
    if (!Object.keys(values).length) fail('EMPTY_UPDATE');
    const data = {};
    if (own(values, 'name')) {
      data.name = string(values.name, { max: 256 });
      if (data.name.trim() !== data.name) fail('INVALID_TEXT');
    }
    if (own(values, 'description')) data.description = string(values.description, { empty: true, max: 8192 });
    return { operationId, body: { where, data } };
  }
  if (actionId === 'vm.hardware.cpu') {
    fields(values, ['cpu_sockets', 'cpu_cores', 'vcpu'], ['cpu_sockets', 'cpu_cores', 'vcpu']);
    // The SDK does not define a product relationship; Tower validates topology.
    const cpu_sockets = positiveInteger(values.cpu_sockets, 2147483647), cpu_cores = positiveInteger(values.cpu_cores, 2147483647);
    const vcpu = positiveInteger(values.vcpu, 2147483647);
    return { operationId, body: { where, data: { cpu_sockets, cpu_cores, vcpu } } };
  }
  if (actionId === 'vm.hardware.memory') {
    fields(values, ['memory', 'memory_unit'], ['memory', 'memory_unit']);
    const memory = positiveInteger(values.memory);
    if (values.memory_unit !== 'B') fail('INVALID_MEMORY_UNIT');
    return { operationId, body: { where, data: { memory, memory_unit: values.memory_unit } } };
  }
  if (actionId === 'vm.hardware.disk.add') {
    fields(values, ['mode', 'bus', 'boot', 'name', 'size', 'size_unit', 'vm_volume_id'], ['mode', 'bus', 'boot']);
    const disk = { bus: diskBus(values.bus), boot: nonnegativeInteger(values.boot) };
    let vm_disks;
    if (values.mode === 'new') {
      fields(values, ['mode', 'bus', 'boot', 'name', 'size', 'size_unit'], ['mode', 'bus', 'boot', 'name', 'size', 'size_unit']);
      vm_disks = { mount_new_create_disks: [{ ...disk, vm_volume: { name: string(values.name), size: positiveInteger(values.size), size_unit: byteUnit(values.size_unit) } }] };
    } else if (values.mode === 'existing') {
      fields(values, ['mode', 'bus', 'boot', 'vm_volume_id'], ['mode', 'bus', 'boot', 'vm_volume_id']);
      const volume = clusterChoice(snapshot, choices, 'availableVolumes', values.vm_volume_id);
      if (!Array.isArray(volume.vm_disks) || volume.vm_disks.length !== 0) fail('VOLUME_NOT_CONFIRMED_UNATTACHED');
      if (Array.isArray(choices.vm_disks) && choices.vm_disks.some(item => item?.vm_volume?.id === volume.id)) fail('VOLUME_ALREADY_ATTACHED');
      vm_disks = { mount_disks: [{ ...disk, vm_volume_id: volume.id }] };
    } else fail('DISK_ADD_MODE_UNSUPPORTED');
    return { operationId, body: { where, data: { vm_disks } } };
  }
  if (actionId === 'vm.hardware.disk.edit') {
    fields(values, ['vm_disk_id', 'bus'], ['vm_disk_id', 'bus']);
    const disk = owned(snapshot, choices, 'vm_disks', values.vm_disk_id, 'DISK');
    return { operationId, body: { where, data: { vm_disk_id: disk.id, bus: diskBus(values.bus) } } };
  }
  if (actionId === 'vm.hardware.disk.expand') {
    fields(values, ['vm_disk_id', 'size', 'size_unit'], ['vm_disk_id', 'size', 'size_unit']);
    const disk = owned(snapshot, choices, 'vm_disks', values.vm_disk_id, 'DISK'), size = positiveInteger(values.size);
    // ByteUnit names do not document conversion semantics. The first expansion
    // form uses exact bytes so its no-shrink precondition never guesses a scale.
    if (values.size_unit !== 'B') fail('DISK_EXPANSION_BYTES_REQUIRED');
    if (!ids(disk.vm_volume?.id) || disk.vm_volume.id === snapshot.id || !Number.isSafeInteger(disk.vm_volume.size) || disk.vm_volume.size < 0) fail('DISK_CURRENT_SIZE_REQUIRED');
    if (size <= disk.vm_volume.size) fail('DISK_SIZE_MUST_INCREASE');
    return { operationId, body: { where: { id: disk.id, vm: { id: resource.id } }, size, size_unit: 'B' } };
  }
  if (actionId === 'vm.hardware.disk.remove') {
    fields(values, ['vm_disk_id'], ['vm_disk_id']);
    const disk = owned(snapshot, choices, 'vm_disks', values.vm_disk_id, 'DISK');
    return { operationId, body: { where, data: { disk_ids: [disk.id] } } };
  }
  if (actionId === 'vm.hardware.nic.add') {
    fields(values, ['connect_vlan_id', 'model', 'enabled', 'mac_address'], ['connect_vlan_id', 'model', 'enabled']);
    const nic = { type: 'VLAN', connect_vlan_id: network(snapshot, choices, values.connect_vlan_id), model: nicModel(values.model), enabled: boolean(values.enabled) };
    if (own(values, 'mac_address')) nic.mac_address = macAddress(values.mac_address, choices);
    return { operationId, body: { where, data: { vm_nics: [nic] } } };
  }
  if (actionId === 'vm.hardware.nic.edit') {
    fields(values, ['vm_nic_id', 'connect_vlan_id', 'enabled', 'mac_address'], ['vm_nic_id']);
    if (Object.keys(values).length === 1) fail('EMPTY_UPDATE');
    const nic = selectedNic(snapshot, choices, values.vm_nic_id), data = {};
    if (own(values, 'connect_vlan_id')) data.connect_vlan_id = network(snapshot, choices, values.connect_vlan_id);
    if (own(values, 'enabled')) data.enabled = boolean(values.enabled);
    if (own(values, 'mac_address')) data.mac_address = macAddress(values.mac_address, choices, nic.id);
    return { operationId, body: { where: { id: nic.id, vm: { id: resource.id } }, data } };
  }
  if (actionId === 'vm.hardware.nic.remove') {
    fields(values, ['vm_nic_id'], ['vm_nic_id']);
    const nic = selectedNic(snapshot, choices, values.vm_nic_id);
    return { operationId, body: { where: { id: nic.id, vm: { id: resource.id } }, effect: { vm_ids: [resource.id] } } };
  }
  if (actionId === 'vm.snapshots.create') {
    fields(values, ['name', 'consistent_type'], ['name']);
    const consistent_type = own(values, 'consistent_type') ? values.consistent_type : 'CRASH_CONSISTENT';
    if (!['CRASH_CONSISTENT', 'FILE_SYSTEM_CONSISTENT'].includes(consistent_type)) fail('INVALID_SNAPSHOT_CONSISTENCY');
    if (consistent_type === 'FILE_SYSTEM_CONSISTENT' && (snapshot.status !== 'RUNNING' || snapshot.vm_tools_status !== 'RUNNING')) fail('SNAPSHOT_GUEST_AGENT_REQUIRED');
    return { operationId, body: { data: [{ vm_id: resource.id, name: string(values.name), consistent_type }] } };
  }
  if (actionId === 'vm.snapshots.restore') {
    fields(values, ['snapshot_id'], ['snapshot_id']);
    const selected = owned(snapshot, choices, 'snapshots', values.snapshot_id);
    return { operationId, body: { where, data: { snapshot_id: selected.id } } };
  }
  if (actionId === 'vm.snapshots.delete') {
    fields(values, ['snapshot_id'], ['snapshot_id']);
    const selected = owned(snapshot, choices, 'snapshots', values.snapshot_id);
    return { operationId, body: { where: { id: selected.id, vm: { id: resource.id } } } };
  }
  if (actionId === 'vm.migration.withinCluster') {
    fields(values, ['host_id'], ['host_id']);
    const host_id = hostId(values.host_id, snapshot, choices);
    if (snapshot.host?.id === host_id) fail('MIGRATION_TARGET_IS_CURRENT_HOST');
    return { operationId, body: { where, data: { host_id } } };
  }
  if (actionId === 'vm.clone') {
    fields(values, ['name', 'description', 'is_full_copy', 'host_id'], ['name']);
    if (!ids(snapshot.cluster?.id)) fail('CLONE_SOURCE_CLUSTER_REQUIRED');
    // This first form does not implement passthrough-device or cross-cluster
    // network/storage remapping. Do not silently clone incomplete mappings.
    for (const key of ['gpu_devices', 'pci_nics', 'usb_devices']) {
      if (!Array.isArray(snapshot[key])) fail('CLONE_DEVICE_PREFLIGHT_REQUIRED');
      if (snapshot[key].length) fail('CLONE_DEVICE_MAPPING_UNSUPPORTED');
    }
    const data = { src_vm_id: resource.id, name: string(values.name), status: 'STOPPED', cluster_id: snapshot.cluster.id, ...optionalHost(values, snapshot, choices) };
    if (own(values, 'description')) data.description = string(values.description, { empty: true, max: 8192 });
    if (own(values, 'is_full_copy')) { if (typeof values.is_full_copy !== 'boolean') fail('INVALID_FULL_COPY_FLAG'); data.is_full_copy = values.is_full_copy; }
    return { operationId, body: [data] };
  }
  fail('ACTION_REQUEST_UNSUPPORTED');
}

const unconfirmed = extras => ({ state: 'unconfirmed', taskIds: [], resourceIds: [], requiresReadback: true, retrySubmission: false, ...extras });
// Accept the decoded REST BODY, not an Axios response or GraphQL envelope.
// Supported mutations return WithTaskVm[], WithTaskVmSnapshot[] or (snapshot
// deletion) WithTaskDeleteVmSnapshot[]. Delete responses require the exact
// selected snapshot targetId in addition to the parent VM resourceId.
// ExpandVmDisk selects a disk in its request but v2.23.0 Vm.ts explicitly
// declares WithTaskVm[] as its response. A child disk ID alone is not accepted
// as a VM response; a differing server contract needs separate verification.
// Because every request is exactly one VM/new object, more than one response is
// an identity/count mismatch. Only an explicit null proves a synchronous call.
export function parseSubmission(body, { operationId, resourceId, targetId } = {}) {
  if (!Object.values(REQUEST_OPERATIONS).includes(operationId) || !ids(resourceId) || !Array.isArray(body) || body.length !== 1) return unconfirmed();
  const item = body[0];
  if (!object(item) || !object(item.data) || !ids(item.data.id) || !own(item, 'task_id')) return unconfirmed();
  const createsObject = operationId === 'CloneVm' || operationId === 'CreateVmSnapshot';
  if (operationId === 'DeleteVmSnapshot') {
    if (!ids(targetId) || targetId === resourceId || item.data.id !== targetId) return unconfirmed();
  } else if (createsObject ? item.data.id === resourceId : item.data.id !== resourceId) return unconfirmed();
  if (operationId === 'CreateVmSnapshot' && item.data.vm?.id && item.data.vm.id !== resourceId) return unconfirmed();
  if (item.task_id === null) return { state: 'synchronous', taskIds: [], resourceIds: [item.data.id], requiresReadback: true, retrySubmission: false };
  if (!ids(item.task_id) || item.task_id === resourceId || item.task_id === item.data.id) return unconfirmed();
  return { state: 'pending', taskIds: [item.task_id], resourceIds: [item.data.id], requiresReadback: true, retrySubmission: false };
}

export function buildTaskQuery(taskId) {
  if (!ids(taskId)) fail('INVALID_TASK_ID');
  return { operationId: 'GetTasks', body: { where: { id: taskId }, first: 1 } };
}
// Parser output never requests resubmission. PAUSED is not success. Even a
// SUCCESSED task requires fresh resource readback by the framework. Error text
// is bounded diagnostic data; the host must redact it before logging/display.
export function parseTask(body, { taskId } = {}) {
  const base = { taskId: ids(taskId) ? taskId : null, retrySubmission: false, requiresReadback: true };
  if (!ids(taskId) || !Array.isArray(body) || body.length !== 1 || !object(body[0]) || body[0].id !== taskId) return { ...base, state: 'unconfirmed' };
  const task = body[0];
  const states = { PENDING: 'pending', EXECUTING: 'pending', PAUSED: 'paused', SUCCESSED: 'succeeded', FAILED: 'failed' };
  if (typeof task.status !== 'string' || !own(states, task.status)) return { ...base, state: 'unconfirmed' };
  const state = states[task.status];
  const result = { ...base, state };
  if (state === 'failed') {
    if (typeof task.error_code === 'string') result.errorCode = task.error_code.slice(0, 200);
    if (typeof task.error_message === 'string') result.errorMessage = task.error_message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 2048);
  }
  return result;
}
