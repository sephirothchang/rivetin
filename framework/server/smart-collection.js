import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { atomic, storage } from './storage.js';
import { validId } from '../shared/identity.js';
import { smartFailureCode } from './smart-data.js';

const processToken = randomUUID(), liveInstances = new Set();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sshCommandId = value => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const codes = new Set(['SMART_COLLECTION_INTERRUPTED', 'SMART_COLLECTION_FAILED', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED', 'SMART_OUTPUT_INVALID', 'SMART_IDENTITY_MISMATCH', 'SMART_UNSUPPORTED', 'SMART_BINDING_CHANGED', 'SMART_GENERATION_CHANGED', 'SMART_PLUGIN_DISABLED', 'SMART_COLLECTION_SNAPSHOT_CHANGED']);
const error = (code, status = 503) => Object.assign(new Error(code), { status });
function admin(actor) {
  if (!actor || typeof actor.id !== 'string' || !actor.id.length || actor.id.length > 128 || !['tower', 'cli', 'demo'].includes(actor.source)) throw error('AUTHENTICATION_REQUIRED', 401);
  if (actor.admin !== true) throw error('ADMIN_REQUIRED', 403);
}
const response = row => ({ schemaVersion: 1, operationId: row.operationId, status: row.status, ...(row.code ? { code: row.code } : {}) });
const requestKey = (actor, requestId) => createHash('sha256').update(JSON.stringify({ id: actor.id, source: actor.source, requestId })).digest('hex');
const sameScope = (row, input) => row.pluginId === input.pluginId && row.diskId === input.diskId && row.generation === input.generation && row.actor.id === input.actor.id && row.actor.source === input.actor.source;
function knownFailure(failed) { return codes.has(failed?.message) ? failed.message : smartFailureCode(failed?.message); }
const resultFailure = code => ({ SSH_SMART_UNSUPPORTED: 'SMART_UNSUPPORTED', SSH_SMART_OUTPUT_INVALID: 'SMART_OUTPUT_INVALID', SSH_SMART_IDENTITY_MISMATCH: 'SMART_IDENTITY_MISMATCH' }[code] || smartFailureCode(code));

export function collectionSnapshotGuard(value) {
  const target = value?.target, selection = value?.selection;
  if (!exact(value, ['target', 'selection']) || !exact(target, ['profileHostId', 'deviceId', 'generation', 'bindingToken']) || !exact(selection, ['pluginId', 'commandId', 'hostId', 'deviceId', 'digest', 'approvalId']) ||
      ![target?.profileHostId, target?.deviceId, selection?.hostId, selection?.deviceId].every(identifier) || !sshCommandId(selection?.commandId) || !validId(selection?.pluginId) || !uuid(selection?.approvalId) ||
      ![target?.generation, target?.bindingToken, selection?.digest].every(hex) || target.profileHostId !== selection.hostId || target.deviceId !== selection.deviceId) throw error('SMART_COLLECTION_SNAPSHOT_INVALID', 400);
  return createHash('sha256').update(JSON.stringify({ target: { profileHostId: target.profileHostId, deviceId: target.deviceId, generation: target.generation, bindingToken: target.bindingToken },
    selection: { pluginId: selection.pluginId, commandId: selection.commandId, hostId: selection.hostId, deviceId: selection.deviceId, digest: selection.digest, approvalId: selection.approvalId } })).digest('hex');
}

export function createSmartCollection(directory, { provider, broker, now = Date.now, capacity = 10000 } = {}) {
  if (!provider || typeof provider.collectionTarget !== 'function' || !broker || typeof broker.selectSmartTarget !== 'function' || typeof broker.runTarget !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw error('SMART_COLLECTION_REQUIRED');
  const root = path.join(path.resolve(directory), 'smart-collection'), lock = storage(root), file = path.join(root, 'operations.json');
  const instance = randomUUID(), owner = { pid: process.pid, process: processToken, instance }, pending = new Set(), controllers = new Map();
  liveInstances.add(instance); let stopped = false;
  function validate(input, isSubmit) {
    const keys = ['pluginId', 'diskId', 'generation', 'actor', isSubmit ? 'requestId' : 'operationId'];
    if (!exact(input, keys) || !validId(input.pluginId) || !identifier(input.diskId) || !hex(input.generation) || !uuid(input[isSubmit ? 'requestId' : 'operationId'])) throw error('SMART_COLLECTION_REQUEST_INVALID', 400);
    admin(input.actor);
  }
  async function load() {
    let value;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || process.platform !== 'win32' && info.mode & 0o077) throw error('SMART_COLLECTION_CORRUPT');
      value = JSON.parse(await readFile(file, 'utf8'));
    } catch (failed) { if (failed.code === 'ENOENT') value = { version: 1, items: {} }; else throw error('SMART_COLLECTION_CORRUPT'); }
    if (!exact(value, ['version', 'items']) || value.version !== 1 || !object(value.items) || Object.keys(value.items).length > 10000) throw error('SMART_COLLECTION_CORRUPT');
    const operations = new Set();
    for (const [key, row] of Object.entries(value.items)) {
      if (!hex(key) || !exact(row, ['operationId', 'requestId', 'pluginId', 'diskId', 'generation', 'actor', 'owner', 'status', 'createdAt', 'updatedAt', 'code', 'guard']) || row.guard !== undefined && !hex(row.guard) ||
          !uuid(row.operationId) || operations.has(row.operationId) || !uuid(row.requestId) || !validId(row.pluginId) || !identifier(row.diskId) || !hex(row.generation) ||
          !exact(row.actor, ['id', 'source']) || typeof row.actor.id !== 'string' || !row.actor.id.length || row.actor.id.length > 128 || !['tower', 'cli', 'demo'].includes(row.actor.source) || requestKey(row.actor, row.requestId) !== key ||
          !exact(row.owner, ['pid', 'process', 'instance']) || !Number.isSafeInteger(row.owner.pid) || row.owner.pid < 1 || !uuid(row.owner.process) || !uuid(row.owner.instance) ||
          !['running', 'succeeded', 'failed', 'unknown'].includes(row.status) || !stamp(row.createdAt) || !stamp(row.updatedAt) ||
          (['running', 'succeeded'].includes(row.status) ? row.code !== undefined : !codes.has(row.code))) throw error('SMART_COLLECTION_CORRUPT');
      operations.add(row.operationId);
    }
    return value;
  }
  function ownerAlive(row) {
    if (row.owner.process === processToken) return liveInstances.has(row.owner.instance);
    if (row.owner.pid === process.pid) return false;
    try { process.kill(row.owner.pid, 0); return true; } catch (failed) { return failed.code === 'EPERM'; }
  }
  async function recover(value) {
    let changed = false;
    for (const row of Object.values(value.items)) if (row.status === 'running' && (!ownerAlive(row) || now() - Date.parse(row.createdAt) >= 120000)) {
      controllers.get(row.operationId)?.abort(); row.status = 'unknown'; row.code = 'SMART_COLLECTION_INTERRUPTED'; row.updatedAt = new Date(now()).toISOString(); changed = true;
    }
    if (changed) await atomic(file, value);
    return value;
  }
  async function fresh(input) { return provider.collectionTarget({ pluginId: input.pluginId, diskId: input.diskId, generation: input.generation, actor: input.actor }); }
  async function existing(input, guard) {
    return lock.locked(async () => {
      const value = await recover(await load()), row = value.items[requestKey(input.actor, input.requestId)];
      if (!row) return null;
      if (!sameScope(row, input) || (row.guard || null) !== guard) throw error('SMART_COLLECTION_REQUEST_CONFLICT', 409);
      return response(row);
    });
  }
  async function select(input, target) {
    try { return await broker.selectSmartTarget(input.pluginId, { hostId: target.profileHostId, deviceId: target.deviceId }, input.actor); }
    catch (failed) {
      if (['SSH_ADMIN_REQUIRED', 'SSH_APPROVAL_REQUIRED', 'SSH_CHANNEL_DISABLED', 'SSH_TARGET_NOT_APPROVED'].includes(failed.message)) throw error(failed.message, 403);
      if (['SSH_APPROVAL_REVOKED', 'SSH_SMART_COMMAND_AMBIGUOUS'].includes(failed.message)) throw error(failed.message, 409);
      throw error('SMART_COLLECTION_UNAVAILABLE');
    }
  }
  function launch(row, input, target, selection, externalSignal, guard) {
    const controller = new AbortController(); controllers.set(row.operationId, controller);
    const externalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', externalAbort, { once: true }); if (externalSignal?.aborted) externalAbort();
    const task = (async () => {
      let status = 'failed', code = 'SMART_COLLECTION_FAILED';
      try {
        if (stopped || controller.signal.aborted) throw error('SMART_EXECUTION_CANCELLED');
        const current = await fresh(input);
        if (current.bindingToken !== target.bindingToken || current.profileHostId !== target.profileHostId || current.deviceId !== target.deviceId || current.generation !== target.generation) throw error('SMART_BINDING_CHANGED');
        if (guard && collectionSnapshotGuard({ target: current, selection: await select(input, current) }) !== guard) throw error('SMART_COLLECTION_SNAPSHOT_CHANGED', 409);
        const result = await broker.runTarget(selection, input.actor, { signal: controller.signal, requireSample: true });
        if (!result || !Array.isArray(result.items) || result.items.length !== 1) throw error('SMART_COLLECTION_FAILED');
        if (result.items[0].result === 'success') { status = 'succeeded'; code = null; }
        else code = resultFailure(result.items[0].code);
      } catch (failed) { code = knownFailure(failed); }
      await lock.locked(async () => {
        const value = await load(), latest = value.items[requestKey(input.actor, input.requestId)];
        if (!latest || latest.operationId !== row.operationId || latest.status !== 'running' || latest.owner.instance !== instance) return;
        latest.status = stopped ? 'unknown' : status; latest.updatedAt = new Date(now()).toISOString();
        if (stopped) latest.code = 'SMART_COLLECTION_INTERRUPTED'; else if (code) latest.code = code;
        await atomic(file, value);
      });
    })();
    const cleanup = () => { pending.delete(task); controllers.delete(row.operationId); externalSignal?.removeEventListener('abort', externalAbort); };
    pending.add(task); task.then(cleanup, cleanup);
  }
  return {
    async submit(input, { expectedSnapshot, signal } = {}) {
      validate(input, true); if (stopped) throw error('SMART_COLLECTION_STOPPED');
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw error('SMART_COLLECTION_SIGNAL_INVALID', 400);
      if (signal?.aborted) throw error('SMART_EXECUTION_CANCELLED', 409);
      const guard = expectedSnapshot === undefined ? null : collectionSnapshotGuard(expectedSnapshot);
      const target = await fresh(input), repeated = await existing(input, guard); if (repeated) return repeated;
      const selection = await select(input, target);
      if (guard && (expectedSnapshot.selection.pluginId !== input.pluginId || expectedSnapshot.target.generation !== input.generation || collectionSnapshotGuard({ target, selection }) !== guard)) throw error('SMART_COLLECTION_SNAPSHOT_CHANGED', 409);
      const admitted = await lock.locked(async () => {
        if (stopped) throw error('SMART_COLLECTION_STOPPED');
        if (signal?.aborted) throw error('SMART_EXECUTION_CANCELLED', 409);
        const value = await recover(await load()), key = requestKey(input.actor, input.requestId), repeated = value.items[key];
        if (repeated) { if (!sameScope(repeated, input) || (repeated.guard || null) !== guard) throw error('SMART_COLLECTION_REQUEST_CONFLICT', 409); return { response: response(repeated) }; }
        const rows = Object.values(value.items), running = rows.filter(row => row.status === 'running');
        if (rows.length >= capacity) throw error('SMART_COLLECTION_CAPACITY_EXCEEDED');
        if (running.length >= 2 || running.some(row => row.diskId === input.diskId)) throw error('SMART_COLLECTION_CONCURRENCY_LIMIT', 429);
        const row = { operationId: randomUUID(), requestId: input.requestId, pluginId: input.pluginId, diskId: input.diskId, generation: input.generation, actor: { id: input.actor.id, source: input.actor.source }, owner,
          status: 'running', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
        if (guard) row.guard = guard;
        value.items[key] = row;
        if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > 8 * 1024 * 1024) throw error('SMART_COLLECTION_CAPACITY_EXCEEDED');
        await atomic(file, value); return { row, response: response(row) };
      });
      if (admitted.row) launch(admitted.row, input, target, selection, signal, guard);
      return admitted.response;
    },
    async get(input) {
      validate(input, false); await fresh(input);
      return lock.locked(async () => {
        const value = await recover(await load()), row = Object.values(value.items).find(item => item.operationId === input.operationId && sameScope(item, input));
        if (!row) throw error('SMART_COLLECTION_NOT_FOUND', 404);
        return response(row);
      });
    },
    async drain() { await Promise.allSettled([...pending]); },
    async stop() {
      stopped = true; liveInstances.delete(instance); for (const controller of controllers.values()) controller.abort();
      await lock.locked(async () => { await recover(await load()); });
      await Promise.allSettled([...pending]);
    },
  };
}
