import { buildActionTree } from './catalog.js';

// Pure builders/parsers, verified against the primary SDK v2.23.0 (Tower 4.9):
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/Vm.ts
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/VmSnapshot.ts
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/Task.ts
// https://github.com/smartxworks/cloudtower-node-sdk/blob/v2.23.0/src/generated/data-contracts.ts
// This module neither authorizes nor submits. The framework must independently
// authorize and freshly read the object immediately before confirmed execution.
// snapshot.availableHosts is our normalized fresh GetHosts result, NOT a Vm API
// property: [{id,cluster:{id},status,entityAsyncStatus?}]. snapshot.snapshots is
// the freshly read VM-owned snapshot relation; do not use an unfiltered list.

const power = {
  'vm.power.start': 'StartVm', 'vm.power.shutdown': 'ShutDownVm', 'vm.power.poweroff': 'PoweroffVm',
  'vm.power.restart': 'RestartVm', 'vm.power.forceRestart': 'ForceRestartVm',
  'vm.power.suspend': 'SuspendVm', 'vm.power.resume': 'ResumeVm',
};
export const REQUEST_OPERATIONS = Object.freeze({ ...power,
  'vm.general.edit': 'UpdateVm', 'vm.hardware.cpu': 'UpdateVm', 'vm.hardware.memory': 'UpdateVm',
  'vm.snapshots.create': 'CreateVmSnapshot', 'vm.snapshots.restore': 'RollbackVm',
  'vm.migration.withinCluster': 'MigrateVm', 'vm.clone': 'CloneVm',
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
function hostId(value, snapshot) {
  if (!ids(value) || value === snapshot.id || !ids(snapshot.cluster?.id) || !Array.isArray(snapshot.availableHosts) || snapshot.availableHosts.length > 5000) fail('HOST_PREFLIGHT_REQUIRED');
  const matches = snapshot.availableHosts.filter(host => host?.id === value);
  if (matches.length !== 1 || matches[0].cluster?.id !== snapshot.cluster.id ||
    matches[0].status !== 'CONNECTED_HEALTHY' || matches[0].entityAsyncStatus) fail('HOST_NOT_ELIGIBLE');
  return value;
}
function optionalHost(values, snapshot) { return own(values, 'host_id') ? { host_id: hostId(values.host_id, snapshot) } : {}; }
function preflight(actionId, resource, snapshot) {
  if (!own(REQUEST_OPERATIONS, actionId)) fail('ACTION_REQUEST_UNSUPPORTED');
  if (!resource || resource.type !== 'vm' || !ids(resource.id) || !snapshot || snapshot.id !== resource.id) fail('VM_PREFLIGHT_MISMATCH');
  // This synthetic permission ONLY asks the pure catalog to check object
  // preconditions. It is not passed to transport or treated as authorization.
  const item = buildActionTree({ resource, snapshot, capabilities: { [actionId]: { allowed: true } } })
    .flatMap(group => group.items).find(entry => entry.id === actionId);
  if (!item?.enabled) fail(`VM_PRECONDITION_${item?.reasonCode || 'UNKNOWN'}`);
}

export function buildActionRequest({ actionId, resource, snapshot, values = {} } = {}) {
  preflight(actionId, resource, snapshot);
  const where = { id: resource.id }, operationId = REQUEST_OPERATIONS[actionId];
  if (own(power, actionId)) {
    fields(values, actionId === 'vm.power.start' ? ['host_id'] : []);
    const data = optionalHost(values, snapshot);
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
    fields(values, ['cpu_sockets', 'cpu_cores', 'vcpu'], ['cpu_sockets', 'cpu_cores']);
    const cpu_sockets = positiveInteger(values.cpu_sockets, 2147483647), cpu_cores = positiveInteger(values.cpu_cores, 2147483647);
    const vcpu = positiveInteger(cpu_sockets * cpu_cores, 2147483647);
    if (own(values, 'vcpu') && values.vcpu !== vcpu) fail('CPU_TOPOLOGY_MISMATCH');
    return { operationId, body: { where, data: { cpu_sockets, cpu_cores, vcpu } } };
  }
  if (actionId === 'vm.hardware.memory') {
    fields(values, ['memory', 'memory_unit'], ['memory', 'memory_unit']);
    const memory = positiveInteger(values.memory);
    if (!['B', 'KB', 'MB', 'GB', 'TB', 'PB'].includes(values.memory_unit)) fail('INVALID_MEMORY_UNIT');
    return { operationId, body: { where, data: { memory, memory_unit: values.memory_unit } } };
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
    if (!ids(values.snapshot_id) || values.snapshot_id === resource.id || !Array.isArray(snapshot.snapshots) || snapshot.snapshots.length > 5000) fail('SNAPSHOT_OWNERSHIP_REQUIRED');
    const selected = snapshot.snapshots.filter(item => item?.id === values.snapshot_id);
    if (selected.length !== 1 || selected[0].entityAsyncStatus ||
      (own(selected[0], 'vm') && selected[0].vm?.id !== resource.id)) fail('SNAPSHOT_NOT_OWNED_OR_READY');
    return { operationId, body: { where, data: { snapshot_id: values.snapshot_id } } };
  }
  if (actionId === 'vm.migration.withinCluster') {
    fields(values, ['host_id'], ['host_id']);
    const host_id = hostId(values.host_id, snapshot);
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
    const data = { src_vm_id: resource.id, name: string(values.name), status: 'STOPPED', cluster_id: snapshot.cluster.id, ...optionalHost(values, snapshot) };
    if (own(values, 'description')) data.description = string(values.description, { empty: true, max: 8192 });
    if (own(values, 'is_full_copy')) { if (typeof values.is_full_copy !== 'boolean') fail('INVALID_FULL_COPY_FLAG'); data.is_full_copy = values.is_full_copy; }
    return { operationId, body: [data] };
  }
  fail('ACTION_REQUEST_UNSUPPORTED');
}

const unconfirmed = extras => ({ state: 'unconfirmed', taskIds: [], resourceIds: [], requiresReadback: true, retrySubmission: false, ...extras });
// Accept the decoded REST BODY, not an Axios response or GraphQL envelope.
// All supported mutation operations return WithTaskVm[] or WithTaskVmSnapshot[].
// Because every request is exactly one VM/new object, more than one response is
// an identity/count mismatch. Only an explicit null proves a synchronous call.
export function parseSubmission(body, { operationId, resourceId } = {}) {
  if (!Object.values(REQUEST_OPERATIONS).includes(operationId) || !ids(resourceId) || !Array.isArray(body) || body.length !== 1) return unconfirmed();
  const item = body[0];
  if (!object(item) || !object(item.data) || !ids(item.data.id) || !own(item, 'task_id')) return unconfirmed();
  const createsObject = operationId === 'CloneVm' || operationId === 'CreateVmSnapshot';
  if (createsObject ? item.data.id === resourceId : item.data.id !== resourceId) return unconfirmed();
  if (operationId === 'CreateVmSnapshot' && item.data.vm?.id && item.data.vm.id !== resourceId) return unconfirmed();
  if (item.task_id === null) return { state: 'synchronous', taskIds: [], resourceIds: [item.data.id], requiresReadback: true, retrySubmission: false };
  if (!ids(item.task_id) || item.task_id === resourceId) return unconfirmed();
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
