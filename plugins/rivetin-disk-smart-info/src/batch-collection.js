import { collectDisk, validateOperation, createRequestId, collectionCode } from './collection.js';

const itemStates = ['queued', 'running', 'succeeded', 'failed', 'unknown', 'skipped'];
const diskId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const invalid = () => { throw new Error('INVALID_COLLECTION_RESPONSE'); };

// The shared provider owns target enumeration, permissions, approvals and locks.
export function validateBatchOperation(value, expectedId) {
  const operation = validateOperation(value, expectedId), summary = value.summary;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operation.operationId)) invalid();
  if (!summary || Object.keys(summary).sort().join() !== ['total', ...itemStates].sort().join() || !['total', ...itemStates].every(key => Number.isInteger(summary[key]) && summary[key] >= 0 && summary[key] <= 100) ||
    itemStates.reduce((sum, key) => sum + summary[key], 0) !== summary.total || !Array.isArray(value.items) || value.items.length !== summary.total) invalid();
  const seen = new Set(), counts = Object.fromEntries(itemStates.map(key => [key, 0]));
  const items = value.items.map(item => {
    if (!item || !diskId(item.diskId) || typeof item.generation !== 'string' || !/^[0-9a-f]{64}$/.test(item.generation) ||
      !itemStates.includes(item.status) || seen.has(item.diskId)) invalid();
    seen.add(item.diskId); counts[item.status]++;
    return { diskId: item.diskId, generation: item.generation, status: item.status,
      ...(item.code === undefined ? {} : { code: collectionCode({ code: item.code }) }) };
  });
  const expectedState = counts.queued || counts.running ? 'running' : counts.unknown ? 'unknown' : counts.succeeded === items.length ? 'succeeded' : 'failed';
  if (!items.length || itemStates.some(key => counts[key] !== summary[key]) || operation.status !== expectedState) invalid();
  return { ...operation, summary: { total: summary.total, ...counts }, items };
}

export async function collectAll(provider, options) {
  if (typeof provider?.collectAll !== 'function' || typeof provider?.collectionAll !== 'function') throw new Error('SMART_COLLECTION_UNAVAILABLE');
  let last;
  const outcome = await collectDisk({
    collect: ({ requestId, signal }) => provider.collectAll({ requestId, signal }),
    collection: ({ operationId, signal }) => provider.collectionAll({ operationId, signal }),
  }, { ...options, validate: validateBatchOperation, onProgress: value => { last = value; options.onProgress?.(value); } });
  return { ...(last || {}), ...outcome };
}

export function createBatchController(win, provider, options = {}) {
  const available = typeof provider?.collectAll === 'function' && typeof provider?.collectionAll === 'function';
  let state = { active: false, available, status: 'idle' }, sequence = 0, abort;
  const listeners = new Set();
  const update = next => { state = next; for (const listener of listeners) listener(state); };
  const cancel = () => {
    sequence++; abort?.abort(); abort = null;
    if (state.status === 'running') update({ ...state, status: 'unknown', code: 'SMART_COLLECTION_WAIT_CANCELLED' });
  };
  return {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); if (!listeners.size) cancel(); }; },
    start() { update({ ...state, active: true }); },
    stop() { cancel(); update({ ...state, active: false }); },
    async collect() {
      if (!state.active || !available || state.status === 'running') return;
      const token = ++sequence; let requestId;
      try { requestId = createRequestId(win.crypto); }
      catch { update({ ...state, status: 'failed', code: 'SMART_COLLECTION_UNAVAILABLE' }); return; }
      abort = new win.AbortController();
      const active = () => token === sequence && !abort?.signal.aborted && state.active;
      update({ active: true, available, status: 'running' });
      try {
        const outcome = await collectAll(provider, { ...options, requestId, signal: abort.signal,
          onProgress: value => { if (active()) update({ ...value, active: true, available }); } });
        if (active()) update({ ...outcome, active: true, available });
      } catch (error) {
        if (active()) update({ active: true, available, status: 'failed', code: collectionCode(error) });
      } finally { if (token === sequence) abort = null; }
    },
  };
}
