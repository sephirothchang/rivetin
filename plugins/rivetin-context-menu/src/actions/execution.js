const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validOperationId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function capture(request) {
  if (!request || !validId(request.resource?.id) || typeof request.resource.type !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(request.resource.type) ||
      typeof request.actionId !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(request.actionId) ||
      typeof request.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.requestId)) throw new Error('INVALID_CONFIRMATION');
  const values = copy(request.values ?? {});
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('INVALID_CONFIRMATION');
  const resource = { type: request.resource.type, id: request.resource.id };
  if (typeof request.resource.name === 'string') resource.name = request.resource.name.slice(0, 200);
  return freeze({ resource, actionId: request.actionId, values, requestId: request.requestId });
}

// One form confirmation, one host execute call. Authentication, operation
// whitelisting, task tracking and final readback belong to the injected bridge.
// A new executor must never be created automatically to retry an unknown result.
export function createConfirmedExecution({ bridge, validate, buildRequest, preflight, win = globalThis, timeoutMs = 120000, pollIntervalMs = 1000, maxPolls = 120, onProgress = () => {} }) {
  if (typeof bridge?.read !== 'function' || typeof bridge?.execute !== 'function' || typeof validate !== 'function' ||
      (buildRequest !== undefined && typeof buildRequest !== 'function') || (preflight !== undefined && typeof preflight !== 'function')) throw new Error('INVALID_EXECUTION_BRIDGE');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('INVALID_EXECUTION_TIMEOUT');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 10000 || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 1000) throw new Error('INVALID_EXECUTION_POLL_LIMIT');
  let attempt = null, stopped = false;
  let state = freeze({ phase: 'idle', submitted: false, requestId: null, operationId: null, result: null });
  const now = () => win.performance?.now() ?? Date.now();
  function progress(phase, result = null) {
    state = freeze({ phase, submitted: Boolean(attempt?.submitted), requestId: attempt?.request.requestId || null, operationId: attempt?.operationId || null, result });
    try { onProgress(state); } catch { /* A view callback cannot alter execution. */ }
  }
  function outcome(status, code, extra = {}) { return freeze({ status, ...(code ? { code } : {}), ...extra }); }
  const correlation = value => ({ ...(value.operationId ? { operationId: value.operationId } : {}), ...(value.taskId ? { taskId: value.taskId } : {}) });
  function interrupted(value) {
    return outcome(value.submitted ? 'unknown' : 'cancelled', value.timedOut ? 'EXECUTION_TIMEOUT' : 'EXECUTION_CANCELLED', correlation(value));
  }
  function check(value) {
    if (now() >= value.deadline && !value.controller.signal.aborted) { value.timedOut = true; value.controller.abort(); }
    if (value.controller.signal.aborted) throw value.interruption;
  }
  async function bounded(value, invoke) {
    check(value);
    const signal = value.controller.signal;
    let abort;
    const aborted = new Promise((_, reject) => { abort = () => reject(value.interruption); signal.addEventListener('abort', abort, { once: true }); });
    try {
      const result = await Promise.race([Promise.resolve().then(() => { check(value); return invoke(); }), aborted]);
      check(value); return result;
    } finally { signal.removeEventListener('abort', abort); }
  }
  function resultFromBridge(value, result) {
    if (!result || !['succeeded', 'failed', 'unknown', 'running'].includes(result.status) || !validOperationId(result.operationId) ||
        (result.taskId !== undefined && !validId(result.taskId))) return outcome('unknown', 'EXECUTION_RESPONSE_INVALID', correlation(value));
    if (value.operationId && value.operationId !== result.operationId) return outcome('unknown', 'OPERATION_ID_MISMATCH', correlation(value));
    value.operationId = result.operationId;
    if (result.taskId) value.taskId = result.taskId;
    const extra = correlation(value);
    if (result.snapshot !== undefined) {
      if (!result.snapshot || result.snapshot.id !== value.request.resource.id) return outcome('unknown', 'READBACK_ID_MISMATCH', extra);
      extra.snapshot = copy(result.snapshot);
    }
    return outcome(result.status, validCode(result.code) ? result.code : result.status === 'unknown' ? 'EXECUTION_UNCONFIRMED' : undefined, extra);
  }
  function delay(value) {
    return new Promise((resolve, reject) => {
      const signal = value.controller.signal;
      const abort = () => { win.clearTimeout(timer); reject(value.interruption); };
      const timer = win.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, pollIntervalMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
    });
  }
  async function run(value) {
    let result;
    try {
      progress('reading');
      const fresh = await bounded(value, () => preflight ? preflight(value.request, { signal: value.controller.signal }) : bridge.read(value.request.resource, { signal: value.controller.signal }));
      if (!fresh?.snapshot || fresh.snapshot.id !== value.request.resource.id) {
        result = outcome('failed', 'RESOURCE_ID_MISMATCH'); return result;
      }
      const snapshot = freeze(copy(fresh.snapshot)), capabilities = freeze(copy(fresh.capabilities || {})), choices = freeze(copy(fresh.choices || {}));
      progress('validating');
      check(value);
      const action = validate({ ...value.request, snapshot, capabilities, choices });
      if (!action || action.id !== value.request.actionId || action.enabled !== true) {
        result = outcome('failed', 'ACTION_UNAVAILABLE'); return result;
      }
      if (buildRequest) {
        try {
          // Local schema validation only. The host independently whitelists and
          // builds the action request; no raw operation is passed around it.
          const built = buildRequest({ ...value.request, action: freeze(copy(action)), snapshot, capabilities, choices });
          if (!built || built.then || typeof built.operationId !== 'string' || !Object.hasOwn(built, 'body')) throw new Error('INVALID_REQUEST_BUILDER');
        } catch { result = outcome('failed', 'REQUEST_VALIDATION_FAILED'); return result; }
      }
      check(value);
      // Set this before entering the transport: any exception or cancellation
      // after the host call starts has an uncertain submission outcome.
      const response = await bounded(value, () => {
        progress('submitting'); check(value); value.submitted = true;
        state = freeze({ ...state, submitted: true });
        return bridge.execute(value.request, { signal: value.controller.signal });
      });
      result = resultFromBridge(value, response);
      let polls = 0;
      while (result.status === 'running') {
        if (typeof bridge.task !== 'function' || polls >= maxPolls) { result = outcome('unknown', 'TRACKING_UNCONFIRMED', correlation(value)); break; }
        progress('tracking');
        await bounded(value, () => delay(value));
        const update = await bounded(value, () => bridge.task(value.operationId, { signal: value.controller.signal }));
        polls++;
        result = resultFromBridge(value, update);
      }
      return result;
    } catch (error) {
      result = error === value.interruption || value.controller.signal.aborted ? interrupted(value) :
        outcome(value.submitted ? 'unknown' : 'failed', value.submitted ? 'EXECUTION_UNCONFIRMED' : 'PREFLIGHT_UNAVAILABLE', correlation(value));
      return result;
    } finally {
      win.clearTimeout(value.timer); value.externalSignal?.removeEventListener('abort', value.externalAbort);
      value.finished = true;
      if (!result) result = outcome(value.submitted ? 'unknown' : 'failed', 'EXECUTION_UNCONFIRMED');
      progress('settled', result);
    }
  }
  function confirm(request, { signal } = {}) {
    let captured;
    try { captured = capture(request); } catch { return Promise.resolve(outcome('failed', 'INVALID_CONFIRMATION')); }
    const fingerprint = JSON.stringify(canonical(captured));
    if (attempt) return attempt.fingerprint === fingerprint ? attempt.promise : Promise.resolve(outcome('failed', 'CONFIRMATION_CONFLICT'));
    if (stopped) return Promise.resolve(outcome('cancelled', 'EXECUTION_STOPPED'));
    const value = { request: captured, fingerprint, controller: new win.AbortController(), interruption: Symbol('execution-interrupted'), deadline: now() + timeoutMs, timedOut: false, submitted: false, finished: false, operationId: null, taskId: null, timer: null, externalSignal: signal, externalAbort: null, promise: null };
    value.externalAbort = () => value.controller.abort();
    if (signal?.aborted) value.controller.abort(); else signal?.addEventListener('abort', value.externalAbort, { once: true });
    value.timer = win.setTimeout(() => { if (!value.finished) { value.timedOut = true; value.controller.abort(); } }, timeoutMs);
    attempt = value;
    value.promise = Promise.resolve().then(() => run(value));
    return value.promise;
  }
  function cancel() {
    stopped = true;
    if (attempt && !attempt.finished) attempt.controller.abort();
  }
  return { confirm, cancel, stop: cancel, getState: () => state };
}
