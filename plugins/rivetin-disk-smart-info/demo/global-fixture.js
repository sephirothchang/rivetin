// Synthetic presentation states only; this file performs no collection or requests.
export const globalStates = {
  idle: {},
  running: { status: 'running', summary: { total: 3, queued: 2, running: 1, succeeded: 0, failed: 0, unknown: 0, skipped: 0 }, items: [
    { key: 'example-a', label: 'Example disk A', status: 'running' }, { key: 'example-b', label: 'Example disk B', status: 'queued' }, { key: 'example-c', label: 'Example disk C', status: 'queued' },
  ] },
  completed: { status: 'succeeded', summary: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, unknown: 0, skipped: 0 }, items: [{ key: 'example-a', label: 'Example disk A', status: 'succeeded' }] },
  partial: { status: 'failed', summary: { total: 3, queued: 0, running: 0, succeeded: 1, failed: 1, unknown: 0, skipped: 1 }, items: [
    { key: 'example-a', label: 'Example disk A', status: 'succeeded' }, { key: 'example-b', label: 'Example disk B', status: 'failed', code: 'SMART_COLLECTION_FAILED' },
    { key: 'example-c', label: 'Example disk C', status: 'skipped', code: 'SSH_APPROVAL_REQUIRED' },
  ] },
  empty: { status: 'failed', summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0, skipped: 0 }, items: [] },
  unknown: { status: 'unknown' },
};

// Synthetic batch service; no inventory, network, SSH or single-disk submit calls.
export function createMockBatchProvider({ state = () => 'ok' } = {}) {
  const operations = new Map();
  const envelope = (operationId, stage) => {
    const value = structuredClone(globalStates[stage]);
    return { schemaVersion: 1, operationId, status: value.status, summary: value.summary,
      items: value.items?.map((item, index) => ({ diskId: 'disk-demo-' + String.fromCharCode(97 + index), generation: String(index + 1).repeat(64), status: item.status, ...(item.code ? { code: item.code } : {}) })) || [] };
  };
  return {
    async collectAll({ requestId, signal }) {
      if (signal.aborted) throw new Error('ABORTED');
      if (state() === 'batch-denied') throw Object.assign(new Error('SSH_APPROVAL_REQUIRED'), { code: 'SSH_APPROVAL_REQUIRED', status: 403 });
      if (state() === 'batch-empty') throw Object.assign(new Error('SMART_BATCH_NO_TARGETS'), { code: 'SMART_BATCH_NO_TARGETS', status: 409 });
      operations.set(requestId, { polls: 0 });
      return envelope(requestId, 'running');
    },
    async collectionAll({ operationId, signal }) {
      if (signal.aborted) throw new Error('ABORTED');
      const operation = operations.get(operationId);
      if (!operation) throw new Error('SMART_COLLECTION_UNKNOWN');
      if (state() === 'batch-running' || ++operation.polls < 2) return envelope(operationId, 'running');
      if (state() === 'batch-unknown') return { ...envelope(operationId, 'running'), status: 'unknown', code: 'SMART_BATCH_INTERRUPTED',
        summary: { total: 3, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 1, skipped: 2 },
        items: [1, 2, 3].map((index) => ({ diskId: 'disk-demo-' + String.fromCharCode(96 + index), generation: String(index).repeat(64), status: index === 1 ? 'unknown' : 'skipped', code: 'SMART_BATCH_INTERRUPTED' })) };
      if (state() === 'batch-partial') return envelope(operationId, 'partial');
      const value = envelope(operationId, 'running'); value.status = 'succeeded';
      value.items = value.items.map(item => ({ ...item, status: 'succeeded' }));
      value.summary = { total: 3, queued: 0, running: 0, succeeded: 3, failed: 0, unknown: 0, skipped: 0 }; return value;
    },
  };
}
