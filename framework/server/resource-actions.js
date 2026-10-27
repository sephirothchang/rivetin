import path from 'node:path';
import { opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { storage, atomic, json } from './storage.js';
import { validId } from '../shared/identity.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const plainText = (value, max, empty = false) => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestIdentifier = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const reads = { vm: '/get-vms', host: '/get-hosts', cluster: '/get-clusters', disk: '/get-disks', vmVolume: '/get-vm-volumes' };
const actions = {
  'vm.general.edit': { path: '/update-vm-basic-info', states: ['RUNNING', 'STOPPED', 'SUSPENDED'] },
  'vm.power.start': { path: '/start-vm', states: ['STOPPED'], after: 'RUNNING' },
  'vm.power.shutdown': { path: '/shutdown-vm', states: ['RUNNING'], tools: true, after: 'STOPPED' },
  'vm.power.poweroff': { path: '/poweroff-vm', states: ['RUNNING', 'SUSPENDED'], after: 'STOPPED' },
  'vm.power.restart': { path: '/restart-vm', states: ['RUNNING'], tools: true, after: 'RUNNING' },
  'vm.power.forceRestart': { path: '/force-restart-vm', states: ['RUNNING'], after: 'RUNNING' },
  'vm.power.suspend': { path: '/suspend-vm', states: ['RUNNING'], after: 'SUSPENDED' },
  'vm.power.resume': { path: '/resume-vm', states: ['SUSPENDED'], after: 'RUNNING' },
};
// Explicitly unsupported entries from the 4.9 context-menu catalog, not API guesses.
const unsupported = ['vm.console.open', 'vm.guest.installTools', 'vm.guest.toolsImage.mount', 'vm.guest.toolsImage.unmount', 'vm.network.links', 'vm.guest.hostOptions', 'vm.guest.resetPassword',
  'vm.hardware.cpu', 'vm.hardware.memory', 'vm.hardware.disk.add', 'vm.hardware.disk.edit', 'vm.hardware.disk.expand', 'vm.hardware.disk.cache', 'vm.hardware.disk.remove', 'vm.hardware.nic.add', 'vm.hardware.nic.edit', 'vm.hardware.nic.remove', 'vm.hardware.nic.qos', 'vm.hardware.cdrom.add', 'vm.hardware.cdrom.mount', 'vm.hardware.cdrom.eject', 'vm.hardware.cdrom.toggle', 'vm.hardware.cdrom.remove', 'vm.hardware.gpu.add', 'vm.hardware.gpu.remove', 'vm.hardware.pciNic.add', 'vm.hardware.pciNic.remove', 'vm.hardware.usb.mount', 'vm.hardware.usb.unmount', 'vm.hardware.advanced', 'vm.hardware.bootOrder', 'vm.hardware.firmware', 'vm.hardware.tpm',
  'vm.snapshots.list', 'vm.snapshots.create', 'vm.snapshots.restore', 'vm.snapshots.rebuild', 'vm.snapshots.delete', 'vm.clone', 'vm.template.create', 'vm.export', 'vm.backup', 'vm.migration.withinCluster', 'vm.migration.acrossCluster', 'vm.migration.cutover', 'vm.migration.abort', 'vm.availability.ha', 'vm.placementGroup', 'vm.hostAutostart', 'vm.vmGroup', 'vm.ownership', 'vm.folder.add', 'vm.folder.remove', 'vm.ioPolicy', 'vm.labels', 'vm.protection', 'vm.recycle.move', 'vm.recycle.recover', 'vm.delete'];
const codes = new Set(['RESOURCE_ACTION_OUTCOME_UNKNOWN', 'RESOURCE_ACTION_RESPONSE_INVALID', 'RESOURCE_ACTION_REJECTED', 'RESOURCE_ACTION_PERMISSION_DENIED', 'RESOURCE_ACTION_TASK_FAILED', 'RESOURCE_ACTION_TASK_UNAVAILABLE', 'RESOURCE_ACTION_TASK_MISMATCH', 'RESOURCE_ACTION_AUDIT_UNAVAILABLE', 'RESOURCE_ACTION_READBACK_UNVERIFIED', 'RESOURCE_ACTION_PLUGIN_UNAVAILABLE']);
function publicMethod(method, keys) {
  return async input => {
    try {
      if (!exact(input, keys)) throw new Error('RESOURCE_ACTION_REQUEST_INVALID');
      return await method(input);
    } catch (error) {
      const code = /^(?:RESOURCE_ACTION_[A-Z_]+|AUTHENTICATION_REQUIRED|INVALID_PLUGIN_ID|STORE_BUSY)$/.test(error?.message || '') ? error.message : 'RESOURCE_ACTION_FAILED';
      const failure = new Error(code);
      failure.status = code === 'AUTHENTICATION_REQUIRED' ? 401 : /PERMISSION_(?:DENIED|REQUIRED|UNVERIFIED)$/.test(code) ? 403 : /(?:NOT_FOUND)$/.test(code) ? 404 :
        /(?:REQUEST_CONFLICT|STATE_REJECTED|PLUGIN_UNAVAILABLE|TOWER_UNSUPPORTED)$/.test(code) ? 409 :
          /(?:FAILED|UNAVAILABLE|JOURNAL_INVALID|JOURNAL_LIMIT|RESPONSE_INVALID)$/.test(code) || code === 'STORE_BUSY' ? 503 : 400;
      throw failure;
    }
  };
}
function resourceValue(value) {
  if (!exact(value, ['type', 'id', 'name']) || !Object.hasOwn(reads, value.type) || !identifier(value.id) || value.name !== undefined && !plainText(value.name, 256)) throw new Error('RESOURCE_ACTION_RESOURCE_INVALID');
  return { type: value.type, id: value.id };
}
function valuesFor(actionId, values) {
  if (!Object.hasOwn(actions, actionId)) throw new Error('RESOURCE_ACTION_UNSUPPORTED');
  if (actionId !== 'vm.general.edit') {
    if (!exact(values, []) || Object.keys(values).length) throw new Error('RESOURCE_ACTION_VALUES_INVALID');
    return {};
  }
  if (!exact(values, ['name', 'description']) || !Object.keys(values).length) throw new Error('RESOURCE_ACTION_VALUES_INVALID');
  const result = {};
  if (Object.hasOwn(values, 'name')) {
    if (!plainText(values.name, 256) || values.name.trim() !== values.name) throw new Error('RESOURCE_ACTION_VALUES_INVALID');
    result.name = values.name;
  }
  if (Object.hasOwn(values, 'description')) {
    if (typeof values.description !== 'string' || values.description.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(values.description)) throw new Error('RESOURCE_ACTION_VALUES_INVALID');
    result.description = values.description;
  }
  return result;
}
function actorValue(actor) {
  if (!identifier(actor?.id) || actor.source !== 'tower' || !object(actor.auth) || !['Authorization', 'Cookie'].some(key => plainText(actor.auth[key], key === 'Cookie' ? 16384 : 8192))) throw new Error('AUTHENTICATION_REQUIRED');
  return actor;
}
function responseItem(value, id) {
  if (!Array.isArray(value) || Object.hasOwn(value, 'errors') || value.length !== 1 || !object(value[0]) || value[0].id !== id) throw new Error(value?.length === 0 ? 'RESOURCE_ACTION_NOT_FOUND' : 'RESOURCE_ACTION_RESPONSE_INVALID');
  return value[0];
}
function snapshotOf(resource, item) {
  const snapshot = { id: resource.id, type: resource.type };
  if (!plainText(item.name, 256)) throw new Error('RESOURCE_ACTION_RESPONSE_INVALID');
  snapshot.name = item.name;
  if (resource.type === 'vm') {
    if (!plainText(item.status, 64) || ['protected', 'internal', 'in_recycle_bin'].some(key => typeof item[key] !== 'boolean') ||
        typeof item.description !== 'string' || item.description.length > 4096 || item.vm_tools_status != null && !plainText(item.vm_tools_status, 64) ||
        item.entityAsyncStatus != null && !['CREATING', 'DELETING', 'UPDATING'].includes(item.entityAsyncStatus)) throw new Error('RESOURCE_ACTION_RESPONSE_INVALID');
    Object.assign(snapshot, { status: ['RUNNING', 'STOPPED', 'SUSPENDED', 'UNKNOWN', 'DELETED'].includes(item.status) ? item.status : 'UNKNOWN', description: item.description, protected: item.protected, internal: item.internal, in_recycle_bin: item.in_recycle_bin,
      vm_tools_status: ['NOT_INSTALLED', 'NOT_RUNNING', 'RESTRICTION', 'RUNNING'].includes(item.vm_tools_status) ? item.vm_tools_status : 'UNKNOWN', entityAsyncStatus: item.entityAsyncStatus ?? null });
  }
  return snapshot;
}
function capability(actionId, snapshot, actor) {
  if (!Object.hasOwn(actions, actionId) || snapshot.type !== 'vm') return { allowed: false, reason: 'RESOURCE_ACTION_UNSUPPORTED' };
  if (actor.role !== 'ROOT') return { allowed: null, reason: 'RESOURCE_ACTION_PERMISSION_UNVERIFIED' };
  if (snapshot.protected || snapshot.internal || snapshot.in_recycle_bin || snapshot.entityAsyncStatus || snapshot.hasActiveTask || !actions[actionId].states.includes(snapshot.status) || actions[actionId].tools && snapshot.vm_tools_status !== 'RUNNING') return { allowed: false, reason: 'RESOURCE_ACTION_STATE_REJECTED' };
  return { allowed: true };
}
function publicResult(record) {
  return { status: record.status, operationId: record.operationId, ...(record.taskId ? { taskId: record.taskId } : {}), ...(record.code ? { code: record.code } : {}) };
}
function verifiedReadback(record, snapshot) {
  if (snapshot.hasActiveTask || snapshot.entityAsyncStatus) return false;
  if (record.actionId !== 'vm.general.edit') return snapshot.status === actions[record.actionId].after;
  const values = Object.fromEntries(record.expectedKeys.map(key => [key, snapshot[key]]));
  return record.expectedKeys.every(key => typeof snapshot[key] === 'string') && hash([record.resource, record.actionId, values]) === record.fingerprint;
}

export function createResourceActions(directory, { request, pluginStatus, towerBuildProvider, audit = async () => {} } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof request !== 'function' || typeof pluginStatus !== 'function' || towerBuildProvider !== undefined && typeof towerBuildProvider !== 'function' || typeof audit !== 'function') throw new Error('RESOURCE_ACTION_PROVIDER_INVALID');
  const root = path.join(directory, 'resource-actions'), disk = storage(root);
  async function gate(pluginId, actor) {
    actorValue(actor);
    if (!validId(pluginId)) throw new Error('INVALID_PLUGIN_ID');
    const status = await pluginStatus(pluginId, actor);
    if (!status || status.frameworkEnabled !== true || status.installed !== true || status.enabled !== true || status.compatible !== true) throw new Error('RESOURCE_ACTION_PLUGIN_UNAVAILABLE');
    if (!['ui.context-menu', 'resource.actions'].every(permission => status.manifest?.permissions?.includes(permission))) throw new Error('RESOURCE_ACTION_PERMISSION_REQUIRED');
    let build; try { build = await towerBuildProvider?.({ fresh: true }); } catch { /* Unknown versions never authorize resource actions. */ }
    if (build !== '4.9.0') throw new Error('RESOURCE_ACTION_TOWER_UNSUPPORTED');
  }
  async function readSnapshot(resource, actor) {
    let value;
    try { value = await request('/v2/api' + reads[resource.type], { where: { id: resource.id }, first: 2 }, actor); }
    catch (error) { throw new Error([401, 403].includes(error?.status) ? 'RESOURCE_ACTION_PERMISSION_DENIED' : 'RESOURCE_ACTION_READ_FAILED'); }
    const snapshot = snapshotOf(resource, responseItem(value, resource.id));
    if (resource.type === 'vm') {
      let tasks;
      try { tasks = await request('/v2/api/get-tasks', { where: { resource_id: resource.id, status_in: ['EXECUTING', 'PENDING', 'PAUSED'] }, first: 2 }, actor); }
      catch (error) { throw new Error([401, 403].includes(error?.status) ? 'RESOURCE_ACTION_PERMISSION_DENIED' : 'RESOURCE_ACTION_READ_FAILED'); }
      if (!Array.isArray(tasks) || Object.hasOwn(tasks, 'errors') || tasks.length > 2 || tasks.some(item => !object(item) || !identifier(item.id) || item.resource_id !== resource.id || !['EXECUTING', 'PENDING', 'PAUSED'].includes(item.status))) throw new Error('RESOURCE_ACTION_RESPONSE_INVALID');
      snapshot.hasActiveTask = tasks.length > 0;
    }
    return snapshot;
  }
  async function emit(record, actor, result) {
    await audit({ actor: { id: actor.id, name: plainText(actor.name, 256) ? actor.name : actor.id, source: 'tower' }, action: `resource.${record.actionId}`, pluginId: record.pluginId, result, code: record.code || null }, actor);
  }
  async function save(record) { try { await atomic(path.join(root, record.operationId + '.json'), record); } catch { throw new Error('RESOURCE_ACTION_JOURNAL_UNAVAILABLE'); } }
  async function load(operationId) {
    let record; try { record = await json(path.join(root, operationId + '.json'), null); } catch { throw new Error('RESOURCE_ACTION_JOURNAL_UNAVAILABLE'); }
    if (record !== null && (!object(record) || record.version !== 1 || record.operationId !== operationId || !identifier(record.actorId) || !validId(record.pluginId) ||
        !Object.hasOwn(actions, record.actionId) || !/^[a-f0-9]{64}$/.test(record.fingerprint || '') || !['running', 'succeeded', 'failed', 'unknown'].includes(record.status) ||
        record.taskId !== null && !identifier(record.taskId) || record.code !== null && !codes.has(record.code) || !Array.isArray(record.expectedKeys) ||
        JSON.stringify(record.expectedKeys) !== JSON.stringify(record.actionId === 'vm.general.edit' ? ['name', 'description'].filter(key => record.expectedKeys.includes(key)) : []) ||
        record.actionId === 'vm.general.edit' && record.expectedKeys.length === 0)) throw new Error('RESOURCE_ACTION_JOURNAL_INVALID');
    if (record) resourceValue(record.resource);
    return record;
  }
  async function capacity() {
    let count = 0;
    for await (const entry of await opendir(root)) if (/^[a-f0-9]{64}\.json$/.test(entry.name) && ++count >= 1000) throw new Error('RESOURCE_ACTION_JOURNAL_LIMIT');
  }
  async function read({ pluginId, resource: input, actor } = {}) {
    const resource = resourceValue(input); await gate(pluginId, actor);
    const snapshot = await readSnapshot(resource, actor), capabilities = {};
    for (const id of [...Object.keys(actions), ...unsupported]) capabilities[id] = capability(id, snapshot, actor);
    return { snapshot, capabilities };
  }
  async function execute({ pluginId, resource: input, actionId, values = {}, requestId, actor } = {}) {
    const resource = resourceValue(input), normalized = valuesFor(actionId, values);
    if (resource.type !== 'vm') throw new Error('RESOURCE_ACTION_UNSUPPORTED');
    if (!requestIdentifier(requestId)) throw new Error('RESOURCE_ACTION_REQUEST_ID_INVALID');
    await gate(pluginId, actor);
    const operationId = hash([pluginId, actor.id, requestId]), fingerprint = hash([resource, actionId, normalized]);
    return disk.locked(async () => {
      const previous = await load(operationId), snapshot = await readSnapshot(resource, actor);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.actorId !== actor.id || previous.pluginId !== pluginId) throw new Error('RESOURCE_ACTION_REQUEST_CONFLICT');
        return publicResult(previous);
      }
      const permitted = capability(actionId, snapshot, actor);
      if (permitted.allowed !== true) throw new Error(permitted.reason);
      await capacity(); await gate(pluginId, actor);
      const record = { version: 1, operationId, fingerprint, expectedKeys: actionId === 'vm.general.edit' ? Object.keys(normalized) : [], actorId: actor.id, pluginId, resource, actionId, status: 'unknown', taskId: null, code: 'RESOURCE_ACTION_OUTCOME_UNKNOWN' };
      // The durable unknown marker precedes the one mutation. A crash cannot authorize replay.
      await save(record);
      try { await emit(record, actor, 'started'); }
      catch { record.status = 'failed'; record.code = 'RESOURCE_ACTION_AUDIT_UNAVAILABLE'; await save(record); return publicResult(record); }
      try { await gate(pluginId, actor); }
      catch {
        record.status = 'failed'; record.code = 'RESOURCE_ACTION_PLUGIN_UNAVAILABLE'; await save(record);
        try { await emit(record, actor, 'failed'); } catch { /* The mutation was never submitted. */ }
        return publicResult(record);
      }
      let result;
      try { result = await request('/v2/api' + actions[actionId].path, { where: { id: resource.id }, ...(actionId === 'vm.general.edit' ? { data: normalized } : {}) }, actor); }
      catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && error.status !== 408) { record.status = 'failed'; record.code = [401, 403].includes(error.status) ? 'RESOURCE_ACTION_PERMISSION_DENIED' : 'RESOURCE_ACTION_REJECTED'; }
      }
      if (result !== undefined) {
        const item = Array.isArray(result) && result.length === 1 && !Object.hasOwn(result, 'errors') ? result[0] : null;
        if (!object(item) || !object(item.data) || item.data.id !== resource.id || !Object.hasOwn(item, 'task_id') || item.task_id !== null && !identifier(item.task_id)) record.code = 'RESOURCE_ACTION_RESPONSE_INVALID';
        else if (item.task_id !== null) { record.status = 'running'; record.taskId = item.task_id; record.code = null; }
        else {
          try {
            const after = await readSnapshot(resource, actor);
            if (verifiedReadback(record, after)) { record.status = 'succeeded'; record.code = null; }
            else record.code = 'RESOURCE_ACTION_READBACK_UNVERIFIED';
          } catch { record.code = 'RESOURCE_ACTION_READBACK_UNVERIFIED'; }
        }
      }
      try { await save(record); } catch { return { status: 'unknown', operationId, code: 'RESOURCE_ACTION_OUTCOME_UNKNOWN' }; }
      try { await emit(record, actor, record.status === 'failed' ? 'failed' : record.status === 'succeeded' ? 'success' : 'started'); } catch { /* The durable journal remains authoritative if an audit mirror fails. */ }
      return publicResult(record);
    });
  }
  async function task({ pluginId, operationId, actor } = {}) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId)) throw new Error('RESOURCE_ACTION_OPERATION_INVALID');
    await gate(pluginId, actor);
    return disk.locked(async () => {
      const record = await load(operationId);
      if (!record || record.actorId !== actor.id || record.pluginId !== pluginId) throw new Error('RESOURCE_ACTION_OPERATION_NOT_FOUND');
      await readSnapshot(record.resource, actor);
      if (!['running', 'unknown'].includes(record.status) || !record.taskId) return publicResult(record);
      let value;
      try { value = await request('/v2/api/get-tasks', { where: { id: record.taskId }, first: 2 }, actor); }
      catch { return { ...publicResult(record), status: 'unknown', code: 'RESOURCE_ACTION_TASK_UNAVAILABLE' }; }
      let current; try { current = responseItem(value, record.taskId); } catch { return { ...publicResult(record), status: 'unknown', code: 'RESOURCE_ACTION_TASK_UNAVAILABLE' }; }
      if (current.resource_id !== record.resource.id || !['EXECUTING', 'FAILED', 'PAUSED', 'PENDING', 'SUCCESSED'].includes(current.status)) return { ...publicResult(record), status: 'unknown', code: 'RESOURCE_ACTION_TASK_MISMATCH' };
      if (current.status === 'FAILED') { record.status = 'failed'; record.code = 'RESOURCE_ACTION_TASK_FAILED'; }
      if (current.status === 'SUCCESSED') {
        let after; try { after = await readSnapshot(record.resource, actor); } catch { /* A successful task alone is not a business postcondition. */ }
        if (after && verifiedReadback(record, after)) { record.status = 'succeeded'; record.code = null; }
        else { record.status = 'unknown'; record.code = 'RESOURCE_ACTION_READBACK_UNVERIFIED'; }
      }
      await save(record);
      if (['failed', 'succeeded'].includes(record.status)) { try { await emit(record, actor, record.status === 'failed' ? 'failed' : 'success'); } catch { /* No API replay for an audit failure. */ } }
      return publicResult(record);
    });
  }
  async function openConsole({ pluginId, resource: input, actor } = {}) {
    const resource = resourceValue(input); await gate(pluginId, actor); await readSnapshot(resource, actor);
    throw new Error('RESOURCE_ACTION_UNSUPPORTED');
  }
  return { read: publicMethod(read, ['pluginId', 'resource', 'actor']), execute: publicMethod(execute, ['pluginId', 'resource', 'actionId', 'values', 'requestId', 'actor']),
    task: publicMethod(task, ['pluginId', 'operationId', 'actor']), openConsole: publicMethod(openConsole, ['pluginId', 'resource', 'actor']) };
}
