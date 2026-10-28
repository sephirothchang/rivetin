import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { storage, atomic } from './storage.js';
import { validId } from '../shared/identity.js';
import { collectionSnapshotGuard } from './smart-collection.js';

const processToken = randomUUID(), liveInstances = new Set(), MAX_TIME = 300000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const uuidV4 = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const error = (code, status = 503) => Object.assign(new Error(code), { status });
const itemStates = ['queued', 'running', 'succeeded', 'failed', 'unknown', 'skipped'];
const codes = new Set(['SMART_BATCH_NOT_APPROVED', 'SMART_BATCH_AMBIGUOUS_COMMAND', 'SMART_BATCH_SNAPSHOT_CHANGED', 'SMART_BATCH_FORBIDDEN', 'SMART_BATCH_TARGET_UNAVAILABLE', 'SMART_BATCH_CONFLICT', 'SMART_BATCH_DEADLINE', 'SMART_BATCH_INTERRUPTED', 'SMART_BATCH_CHILD_UNKNOWN',
  'SMART_COLLECTION_FAILED', 'SMART_COLLECTION_SNAPSHOT_CHANGED', 'SMART_COLLECTION_INTERRUPTED', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED', 'SMART_OUTPUT_INVALID', 'SMART_IDENTITY_MISMATCH', 'SMART_UNSUPPORTED', 'SMART_BINDING_CHANGED', 'SMART_GENERATION_CHANGED', 'SMART_PLUGIN_DISABLED']);
const requestKey = (actor, requestId) => createHash('sha256').update(JSON.stringify({ id: actor.id, source: actor.source, requestId })).digest('hex');
function admin(actor) {
  if (!actor || typeof actor.id !== 'string' || !actor.id.length || actor.id.length > 128 || !['tower', 'cli', 'demo'].includes(actor.source)) throw error('AUTHENTICATION_REQUIRED', 401);
  if (actor.admin !== true) throw error('ADMIN_REQUIRED', 403);
}
function summary(items) { const value = { total: items.length, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0, skipped: 0 }; for (const item of items) value[item.status]++; return value; }
function stateOf(items) { if (items.some(item => item.status === 'queued' || item.status === 'running')) return 'running'; if (items.some(item => item.status === 'unknown')) return 'unknown'; return items.length && items.every(item => item.status === 'succeeded') ? 'succeeded' : 'failed'; }
const response = row => ({ schemaVersion: 1, operationId: row.operationId, status: row.status, summary: summary(row.items), items: row.items.map(({ diskId, generation, status, code }) => ({ diskId, generation, status, ...(code ? { code } : {}) })) });
const scope = (row, input) => row.pluginId === input.pluginId && row.actor.id === input.actor.id && row.actor.source === input.actor.source;
function skipCode(failed) {
  if (failed?.message === 'SSH_SMART_COMMAND_AMBIGUOUS') return 'SMART_BATCH_AMBIGUOUS_COMMAND';
  if (['SSH_APPROVAL_REQUIRED', 'SSH_TARGET_NOT_APPROVED', 'SSH_CHANNEL_DISABLED', 'SSH_APPROVAL_REVOKED'].includes(failed?.message)) return 'SMART_BATCH_NOT_APPROVED';
  if (failed?.status === 401 || failed?.status === 403) return 'SMART_BATCH_FORBIDDEN';
  if (['SMART_BINDING_CHANGED', 'SMART_GENERATION_CHANGED', 'SMART_COLLECTION_SNAPSHOT_CHANGED'].includes(failed?.message)) return 'SMART_BATCH_SNAPSHOT_CHANGED';
  return 'SMART_BATCH_TARGET_UNAVAILABLE';
}
function pause(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error('SMART_BATCH_INTERRUPTED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 100);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
function cancellable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(error('SMART_BATCH_INTERRUPTED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, failed => { signal.removeEventListener('abort', abort); reject(failed); });
    if (signal.aborted) abort();
  });
}

export function createSmartBatch(directory, { provider, broker, collection, now = Date.now, capacity = 10000 } = {}) {
  if (!provider || !['collectionCandidates', 'collectionTarget'].every(name => typeof provider[name] === 'function') || !broker || !['snapshotSmartSelections', 'selectSmartTarget'].every(name => typeof broker[name] === 'function') || !collection || !['submit', 'get'].every(name => typeof collection[name] === 'function') || typeof now !== 'function' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw error('SMART_BATCH_REQUIRED');
  const root = path.join(path.resolve(directory), 'smart-batch'), lock = storage(root), file = path.join(root, 'operations.json');
  const instance = randomUUID(), owner = { pid: process.pid, process: processToken, instance }, pending = new Set(), controllers = new Map();
  liveInstances.add(instance); let stopped = false;
  function validate(input, submit) { if (!exact(input, ['pluginId', 'actor', submit ? 'requestId' : 'operationId']) || !validId(input.pluginId) || !(submit ? uuidV4(input.requestId) : uuid(input.operationId))) throw error('SMART_BATCH_REQUEST_INVALID', 400); admin(input.actor); }
  async function load() {
    let value;
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || process.platform !== 'win32' && info.mode & 0o077) throw error('SMART_BATCH_CORRUPT'); value = JSON.parse(await readFile(file, 'utf8')); }
    catch (failed) { if (failed.code === 'ENOENT') value = { version: 1, items: {} }; else throw error('SMART_BATCH_CORRUPT'); }
    if (!exact(value, ['version', 'items']) || value.version !== 1 || !object(value.items) || Object.keys(value.items).length > 10000) throw error('SMART_BATCH_CORRUPT');
    const operations = new Set();
    for (const [key, row] of Object.entries(value.items)) {
      if (!hex(key) || !exact(row, ['operationId', 'requestId', 'pluginId', 'actor', 'owner', 'createdAt', 'updatedAt', 'deadlineAt', 'status', 'items']) || !uuid(row.operationId) || operations.has(row.operationId) || !uuidV4(row.requestId) || !validId(row.pluginId) ||
          !exact(row.actor, ['id', 'source']) || typeof row.actor.id !== 'string' || !row.actor.id.length || row.actor.id.length > 128 || !['tower', 'cli', 'demo'].includes(row.actor.source) || requestKey(row.actor, row.requestId) !== key ||
          !exact(row.owner, ['pid', 'process', 'instance']) || !Number.isSafeInteger(row.owner.pid) || row.owner.pid < 1 || !uuid(row.owner.process) || !uuid(row.owner.instance) || !stamp(row.createdAt) || !stamp(row.updatedAt) || !Number.isSafeInteger(row.deadlineAt) || row.deadlineAt - Date.parse(row.createdAt) !== MAX_TIME ||
          !Array.isArray(row.items) || !row.items.length || row.items.length > 100 || !['running', 'succeeded', 'failed', 'unknown'].includes(row.status)) throw error('SMART_BATCH_CORRUPT');
      const disks = new Set();
      for (const item of row.items) {
        if (!exact(item, ['diskId', 'generation', 'status', 'code', 'guard', 'childRequestId', 'childOperationId']) || !identifier(item.diskId) || disks.has(item.diskId) || !hex(item.generation) || !itemStates.includes(item.status) ||
            (item.guard !== undefined && !hex(item.guard)) || (item.childRequestId !== undefined && !uuid(item.childRequestId)) || (item.childOperationId !== undefined && !uuid(item.childOperationId)) ||
            (['queued', 'running', 'succeeded'].includes(item.status) ? item.code !== undefined : !codes.has(item.code)) || (item.status !== 'skipped' && (!item.guard || !item.childRequestId))) throw error('SMART_BATCH_CORRUPT');
        disks.add(item.diskId);
      }
      if (row.status !== stateOf(row.items)) throw error('SMART_BATCH_CORRUPT'); operations.add(row.operationId);
    }
    return value;
  }
  function ownerAlive(row) { if (row.owner.process === processToken) return liveInstances.has(row.owner.instance); if (row.owner.pid === process.pid) return false; try { process.kill(row.owner.pid, 0); return true; } catch (failed) { return failed.code === 'EPERM'; } }
  function interrupt(row, deadline) {
    for (const item of row.items) if (item.status === 'queued' || item.status === 'running') { item.code = deadline && item.status === 'queued' ? 'SMART_BATCH_DEADLINE' : 'SMART_BATCH_INTERRUPTED'; item.status = deadline && item.status === 'queued' ? 'skipped' : 'unknown'; }
    row.status = stateOf(row.items); row.updatedAt = new Date(now()).toISOString();
  }
  async function recover(value) {
    let changed = false;
    for (const row of Object.values(value.items)) if (row.status === 'running' && (!ownerAlive(row) || now() >= row.deadlineAt)) { controllers.get(row.operationId)?.abort(); interrupt(row, ownerAlive(row) && now() >= row.deadlineAt); changed = true; }
    if (changed) await atomic(file, value); return value;
  }
  async function update(input, operationId, task) {
    return lock.locked(async () => { const value = await load(), row = value.items[requestKey(input.actor, input.requestId)]; if (!row || row.operationId !== operationId || row.owner.instance !== instance || row.status !== 'running') return null; task(row); row.status = stateOf(row.items); row.updatedAt = new Date(now()).toISOString(); await atomic(file, value); return structuredClone(row); });
  }
  async function authorize(row, actor) {
    const controller = new AbortController(); let timer, index = 0;
    try {
      await Promise.race([
        Promise.all([0, 1].map(async () => { while (index < row.items.length) { if (controller.signal.aborted) throw error('SMART_BATCH_ACCESS_TIMEOUT', 504); const item = row.items[index++]; await provider.collectionTarget({ pluginId: row.pluginId, diskId: item.diskId, generation: item.generation, actor, signal: controller.signal }); if (controller.signal.aborted) throw error('SMART_BATCH_ACCESS_TIMEOUT', 504); } })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(error('SMART_BATCH_ACCESS_TIMEOUT', 504)); }, 5000); }),
      ]);
    } catch (failed) { if (failed.message === 'SMART_BATCH_ACCESS_TIMEOUT') throw error('SMART_BATCH_ACCESS_TIMEOUT', 504); if ([401, 403].includes(failed.status)) throw error('SMART_BATCH_FORBIDDEN', failed.status); if ([404, 409].includes(failed.status)) throw error('SMART_BATCH_ACCESS_CHANGED', 409); throw error('SMART_BATCH_ACCESS_UNAVAILABLE'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function lookup(input, byRequest) {
    const row = await lock.locked(async () => { const value = await recover(await load()); return byRequest ? value.items[requestKey(input.actor, input.requestId)] || null : Object.values(value.items).find(item => item.operationId === input.operationId && scope(item, input)) || null; });
    if (row && !scope(row, input)) throw error('SMART_BATCH_REQUEST_CONFLICT', 409);
    return row;
  }
  function launch(row, input, snapshots) {
    const controller = new AbortController(); controllers.set(row.operationId, controller);
    const deadlineTimer = setTimeout(() => controller.abort(), Math.max(1, row.deadlineAt - now()));
    const task = (async () => {
      try {
        for (const queued of row.items.filter(item => item.status === 'queued')) {
          if (stopped || controller.signal.aborted || now() >= row.deadlineAt) { await update(input, row.operationId, current => interrupt(current, !stopped && now() >= row.deadlineAt)); break; }
          const snapshot = snapshots.get(queued.diskId), args = { pluginId: input.pluginId, diskId: queued.diskId, generation: queued.generation, actor: input.actor };
          try {
            const target = await cancellable(provider.collectionTarget({ ...args, signal: controller.signal }), controller.signal), selection = await cancellable(broker.selectSmartTarget(input.pluginId, { hostId: target.profileHostId, deviceId: target.deviceId }, input.actor), controller.signal);
            if (collectionSnapshotGuard({ target, selection }) !== queued.guard) throw error('SMART_COLLECTION_SNAPSHOT_CHANGED', 409);
          } catch (failed) {
            if (stopped || controller.signal.aborted || now() >= row.deadlineAt) { await update(input, row.operationId, current => interrupt(current, !stopped && now() >= row.deadlineAt)); break; }
            await update(input, row.operationId, current => { const item = current.items.find(item => item.diskId === queued.diskId); item.status = 'skipped'; item.code = skipCode(failed); }); continue;
          }
          if (stopped || controller.signal.aborted || now() >= row.deadlineAt) { await update(input, row.operationId, current => interrupt(current, !stopped && now() >= row.deadlineAt)); break; }
          await update(input, row.operationId, current => { current.items.find(item => item.diskId === queued.diskId).status = 'running'; });
          let child;
          try { child = await cancellable(collection.submit({ ...args, requestId: queued.childRequestId }, { expectedSnapshot: snapshot, signal: controller.signal }), controller.signal); }
          catch (failed) {
            if (stopped || controller.signal.aborted || now() >= row.deadlineAt) { await update(input, row.operationId, current => interrupt(current, !stopped && now() >= row.deadlineAt)); break; }
            if (failed.status && [400, 401, 403, 409, 429, 503].includes(failed.status)) { await update(input, row.operationId, current => { const item = current.items.find(item => item.diskId === queued.diskId); item.status = 'failed'; item.code = failed.status === 429 ? 'SMART_BATCH_CONFLICT' : skipCode(failed); }); continue; }
            await update(input, row.operationId, current => { interrupt(current, false); }); break;
          }
          if (!child || !uuid(child.operationId) || !['running', 'succeeded', 'failed', 'unknown'].includes(child.status)) { await update(input, row.operationId, current => interrupt(current, false)); break; }
          await update(input, row.operationId, current => { current.items.find(item => item.diskId === queued.diskId).childOperationId = child.operationId; });
          try { while (child.status === 'running') { if (controller.signal.aborted || now() >= row.deadlineAt) throw error('SMART_BATCH_INTERRUPTED'); await pause(controller.signal); child = await cancellable(collection.get({ ...args, operationId: child.operationId }), controller.signal); if (!child || !['running', 'succeeded', 'failed', 'unknown'].includes(child.status)) throw error('SMART_BATCH_CHILD_UNKNOWN'); } }
          catch { await update(input, row.operationId, current => interrupt(current, !stopped && now() >= row.deadlineAt)); break; }
          if (controller.signal.aborted || stopped || now() >= row.deadlineAt || child.status === 'unknown') { await update(input, row.operationId, current => interrupt(current, !stopped && now() >= row.deadlineAt)); break; }
          await update(input, row.operationId, current => { const item = current.items.find(item => item.diskId === queued.diskId); item.status = child.status; if (child.status === 'failed') item.code = codes.has(child.code) ? child.code : 'SMART_COLLECTION_FAILED'; });
        }
      } catch { await update(input, row.operationId, current => interrupt(current, !stopped && now() >= row.deadlineAt)); }
    })();
    const cleanup = () => { clearTimeout(deadlineTimer); pending.delete(task); controllers.delete(row.operationId); };
    pending.add(task); task.then(cleanup, cleanup);
  }
  return {
    async submit(input) {
      const startedAt = now();
      validate(input, true); if (stopped) throw error('SMART_BATCH_STOPPED');
      const repeated = await lookup(input, true); if (repeated) { await authorize(repeated, input.actor); return response(repeated); }
      await lock.locked(async () => { const value = await recover(await load()); if (Object.values(value.items).some(row => row.status === 'running')) throw error('SMART_BATCH_BUSY', 429); });
      const candidates = await provider.collectionCandidates({ pluginId: input.pluginId, actor: input.actor });
      if (!candidates || !Array.isArray(candidates.items)) throw error('SMART_BATCH_CANDIDATES_INVALID');
      if (candidates.items.length > 100) throw error('SMART_BATCH_TARGET_LIMIT', 409); if (!candidates.items.length) throw error('SMART_BATCH_NO_TARGETS', 409);
      const disks = new Set(); for (const item of candidates.items) { if (!identifier(item.diskId) || disks.has(item.diskId) || !hex(item.generation)) throw error('SMART_BATCH_CANDIDATES_INVALID'); disks.add(item.diskId); }
      // Authenticate the entire candidate set before exposing any disk identifier or
      // creating a durable batch. This is bounded parallel read-only validation.
      await authorize({ pluginId: input.pluginId, items: candidates.items }, input.actor);
      let approved; try { approved = await broker.snapshotSmartSelections(input.pluginId, input.actor); } catch (failed) { if (failed.message === 'SSH_TARGET_LIMIT') throw error('SMART_BATCH_TARGET_LIMIT', 409); throw error('SMART_BATCH_NO_APPROVED_TARGETS', 403); }
      if (!approved || !Array.isArray(approved.items) || approved.items.length > 100 || !Array.isArray(approved.rejected)) throw error('SMART_BATCH_SELECTIONS_INVALID');
      const selectedTargets = new Set();
      for (const item of approved.items) { const key = JSON.stringify([item.hostId, item.deviceId]); if (selectedTargets.has(key)) throw error('SMART_BATCH_SELECTIONS_INVALID'); selectedTargets.add(key); }
      const snapshots = new Map(), items = candidates.items.map(candidate => {
        const selection = approved.items.find(item => item.hostId === candidate.profileHostId && item.deviceId === candidate.deviceId), item = { diskId: candidate.diskId, generation: candidate.generation };
        if (!selection) return { ...item, status: 'skipped', code: approved.rejected.some(row => row.hostId === candidate.profileHostId && row.deviceId === candidate.deviceId) ? 'SMART_BATCH_AMBIGUOUS_COMMAND' : 'SMART_BATCH_NOT_APPROVED' };
        const expectedSnapshot = { target: { profileHostId: candidate.profileHostId, deviceId: candidate.deviceId, generation: candidate.generation, bindingToken: candidate.bindingToken }, selection };
        if (selection.pluginId !== input.pluginId) throw error('SMART_BATCH_SELECTIONS_INVALID');
        const guard = collectionSnapshotGuard(expectedSnapshot); snapshots.set(candidate.diskId, structuredClone(expectedSnapshot)); return { ...item, status: 'queued', guard, childRequestId: randomUUID() };
      });
      if (!snapshots.size) throw error('SMART_BATCH_NO_APPROVED_TARGETS', 403);
      const admitted = await lock.locked(async () => {
        if (stopped) throw error('SMART_BATCH_STOPPED');
        const value = await recover(await load()), key = requestKey(input.actor, input.requestId), previous = value.items[key];
        if (previous) { if (!scope(previous, input)) throw error('SMART_BATCH_REQUEST_CONFLICT', 409); return { row: previous, repeated: true }; }
        const rows = Object.values(value.items); if (rows.some(row => row.status === 'running')) throw error('SMART_BATCH_BUSY', 429); if (rows.length >= capacity) throw error('SMART_BATCH_CAPACITY_EXCEEDED');
        const row = { operationId: randomUUID(), requestId: input.requestId, pluginId: input.pluginId, actor: { id: input.actor.id, source: input.actor.source }, owner, status: 'running', items, createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(now()).toISOString(), deadlineAt: startedAt + MAX_TIME };
        value.items[key] = row; if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > 8 * 1024 * 1024) throw error('SMART_BATCH_CAPACITY_EXCEEDED'); await atomic(file, value); return { row, repeated: false };
      });
      if (!admitted.repeated) launch(admitted.row, input, snapshots); else await authorize(admitted.row, input.actor);
      return response(admitted.row);
    },
    async get(input) { validate(input, false); const row = await lookup(input, false); if (!row) throw error('SMART_BATCH_NOT_FOUND', 404); await authorize(row, input.actor); return response(row); },
    async drain() { await Promise.allSettled([...pending]); },
    async stop() { stopped = true; liveInstances.delete(instance); for (const controller of controllers.values()) controller.abort(); await lock.locked(async () => { await recover(await load()); }); await Promise.allSettled([...pending]); },
  };
}
