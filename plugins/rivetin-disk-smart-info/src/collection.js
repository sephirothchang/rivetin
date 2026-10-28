const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const statuses = new Set(['running', 'succeeded', 'failed', 'unknown']);
const codes = new Set(['SMART_DISK_UNBOUND', 'SMART_GENERATION_CHANGED', 'SMART_BINDING_CHANGED', 'SMART_DISK_FORBIDDEN', 'SMART_PLUGIN_DISABLED',
  'SMART_COLLECTION_FAILED', 'SMART_COLLECTION_BUSY', 'SMART_COLLECTION_UNAVAILABLE', 'SMART_COLLECTION_WAIT_TIMEOUT', 'SMART_COLLECTION_UNKNOWN',
  'SMART_COLLECTION_INTERRUPTED', 'SMART_UNSUPPORTED', 'SMART_OUTPUT_INVALID', 'SMART_IDENTITY_MISMATCH',
  'SMART_PROFILE_UNAVAILABLE', 'SMART_DEVICE_UNAVAILABLE', 'SSH_CHANNEL_DISABLED', 'SSH_TARGET_UNAVAILABLE', 'SSH_DEVICE_UNAVAILABLE',
  'SSH_TRANSPORT_UNAVAILABLE', 'SSH_EXECUTION_TIMEOUT', 'SSH_EXECUTION_CANCELLED', 'SMART_EXECUTION_TIMEOUT', 'SMART_EXECUTION_CANCELLED',
  'SSH_REGISTRATION_CHANGED', 'SSH_CONCURRENCY_LIMIT', 'AUTHENTICATION_REQUIRED', 'ADMIN_REQUIRED',
  'SMART_BATCH_NO_TARGETS', 'SMART_BATCH_NO_APPROVED_TARGETS', 'SMART_BATCH_TARGET_LIMIT', 'SMART_BATCH_NOT_APPROVED', 'SMART_BATCH_AMBIGUOUS_COMMAND',
  'SMART_BATCH_SNAPSHOT_CHANGED', 'SMART_BATCH_FORBIDDEN', 'SMART_BATCH_TARGET_UNAVAILABLE', 'SMART_BATCH_CONFLICT', 'SMART_BATCH_DEADLINE',
  'SMART_BATCH_INTERRUPTED', 'SMART_BATCH_CHILD_UNKNOWN', 'SMART_BATCH_BUSY', 'SMART_BATCH_CAPACITY_EXCEEDED', 'SMART_BATCH_NOT_FOUND',
  'SMART_BATCH_ACCESS_CHANGED', 'SMART_BATCH_ACCESS_UNAVAILABLE', 'SMART_BATCH_ACCESS_TIMEOUT', 'SMART_COLLECTION_SNAPSHOT_CHANGED']);
export function createRequestId(crypto) {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('SMART_COLLECTION_UNAVAILABLE');
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function collectionCode(error) {
  for (const code of [error?.code, error?.message]) {
    if (code === 'SSH_TARGET_NOT_APPROVED') return 'SSH_APPROVAL_REQUIRED';
    if (code === 'SSH_ADMIN_REQUIRED') return 'ADMIN_REQUIRED';
    if (code === 'SMART_COLLECTION_CONCURRENCY_LIMIT') return 'SMART_COLLECTION_BUSY';
    if (typeof code === 'string' && /^SSH_APPROVAL_[A-Z_]+$/.test(code)) return 'SSH_APPROVAL_REQUIRED';
    if (codes.has(code)) return code;
  }
  return 'SMART_COLLECTION_UNKNOWN';
}
export const collectionInvalidatesData = code => ['SMART_GENERATION_CHANGED', 'SMART_BINDING_CHANGED', 'SMART_DISK_FORBIDDEN', 'SMART_PLUGIN_DISABLED', 'AUTHENTICATION_REQUIRED', 'ADMIN_REQUIRED', 'SMART_BATCH_FORBIDDEN', 'SMART_BATCH_ACCESS_CHANGED'].includes(code);
export function validateOperation(value, expectedId) {
  if (!value || value.schemaVersion !== 1 || !uuid(value.operationId) || expectedId && value.operationId !== expectedId || !statuses.has(value.status)) throw new Error('INVALID_COLLECTION_RESPONSE');
  return { schemaVersion: 1, operationId: value.operationId, status: value.status,
    ...(value.code === undefined ? {} : { code: collectionCode({ code: value.code }) }) };
}
const cancelled = () => Object.assign(new Error('REQUEST_CANCELLED'), { name: 'AbortError', code: 'REQUEST_CANCELLED' });

// One POST per explicit action. Cancellation stops waiting, not the remote command.
export async function collectDisk(provider, { identity, requestId, signal, onProgress = () => {}, timeoutMs = 45000, intervalMs = 1500, validate = validateOperation }) {
  if (!provider || typeof provider.collect !== 'function' || typeof provider.collection !== 'function' || !uuid(requestId)) throw new Error('SMART_COLLECTION_UNAVAILABLE');
  if (signal.aborted) throw cancelled();
  const controller = new AbortController(); let operation, deadlineTimer, abortListener;
  const unknown = code => ({ schemaVersion: 1, operationId: operation?.operationId ?? null, status: 'unknown', code });
  const check = () => { if (controller.signal.aborted) throw cancelled(); };
  const pause = () => new Promise((resolve, reject) => {
    const finish = () => { controller.signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, intervalMs);
    const stop = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); reject(cancelled()); };
    controller.signal.addEventListener('abort', stop, { once: true }); if (controller.signal.aborted) stop();
  });
  const work = async () => {
    operation = validate(await provider.collect({ identity, requestId, signal: controller.signal }));
    check(); onProgress(operation);
    for (let count = 0; operation.status === 'running' && count < 30; count++) {
      await pause(); check();
      operation = validate(await provider.collection({ identity, operationId: operation.operationId, signal: controller.signal }), operation.operationId);
      check(); onProgress(operation);
    }
    return operation.status === 'running' ? unknown('SMART_COLLECTION_WAIT_TIMEOUT') : operation;
  };
  try {
    return await Promise.race([
      work(),
      new Promise(resolve => { deadlineTimer = setTimeout(() => { resolve(unknown('SMART_COLLECTION_WAIT_TIMEOUT')); controller.abort(); }, timeoutMs); }),
      new Promise((_, reject) => { abortListener = () => { reject(cancelled()); controller.abort(); }; signal.addEventListener('abort', abortListener, { once: true }); if (signal.aborted) abortListener(); }),
    ]);
  } catch (error) {
    if (signal.aborted) throw cancelled();
    const code = collectionCode(error);
    if (collectionInvalidatesData(code)) throw Object.assign(new Error(code), { code });
    return { ...unknown(code), status: !operation && Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? 'failed' : 'unknown' };
  } finally {
    clearTimeout(deadlineTimer); signal.removeEventListener('abort', abortListener); controller.abort();
  }
}
