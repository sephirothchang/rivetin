import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmedExecution } from '../src/actions/execution.js';
const OPERATION_A = 'a'.repeat(64), OPERATION_B = 'b'.repeat(64);

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const request = values => ({ resource: { type: 'vm', id: 'vm-a', name: 'VM A' }, actionId: 'vm.power.shutdown', values: values || {}, requestId: 'confirmation-a' });
const fresh = (id = 'vm-a') => ({ snapshot: { id, status: 'RUNNING' }, capabilities: { 'vm.power.shutdown': { allowed: true } } });
function fixture(t, overrides = {}) {
  let now = 0, next = 1; const timers = new Map(), reads = [], submissions = [], tasks = [], progress = [];
  const win = { AbortController, performance: { now: () => now }, setTimeout(fn, delay) { const id = next++; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const bridge = {
    read(resource, options) { reads.push({ resource, options }); return overrides.read ? overrides.read(resource, options) : Promise.resolve(fresh()); },
    execute(value, options) { submissions.push({ value, options }); return overrides.execute ? overrides.execute(value, options) : Promise.resolve({ status: 'succeeded', operationId: OPERATION_A, taskId: 'task-a', snapshot: { id: 'vm-a', status: 'STOPPED' } }); },
    task(operationId, options) { tasks.push({ operationId, options }); return overrides.task ? overrides.task(operationId, options) : Promise.resolve({ status: 'succeeded', operationId, taskId: 'task-a' }); },
  };
  const execution = createConfirmedExecution({ bridge, win,
    validate: overrides.validate || (({ actionId, snapshot, capabilities }) => ({ id: actionId, enabled: snapshot.status === 'RUNNING' && capabilities[actionId]?.allowed === true })),
    buildRequest: overrides.buildRequest || (() => ({ operationId: 'ShutDownVm', body: { where: { id: 'vm-a' } } })),
    maxPolls: overrides.maxPolls || 120,
    onProgress(value) { progress.push(value); overrides.onProgress?.(value); },
  });
  t.after(() => execution.stop());
  return { execution, bridge, reads, submissions, tasks, timers, progress,
    fire(delay) { const match = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(match, `Expected a ${delay} ms timer`); timers.delete(match[0]); match[1].fn(); },
    advance(ms) { now += ms; },
  };
}

test('a user confirmation reads fresh state then submits exactly once through the bridge', async t => {
  const f = fixture(t), result = await f.execution.confirm(request());
  assert.equal(result.status, 'succeeded'); assert.equal(result.operationId, OPERATION_A); assert.equal(result.taskId, 'task-a'); assert.equal(result.snapshot.status, 'STOPPED');
  assert.equal(f.reads.length, 1); assert.equal(f.submissions.length, 1); assert.equal(f.tasks.length, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(Object.keys(f.submissions[0].value).sort(), ['actionId', 'requestId', 'resource', 'values']);
  assert.equal(f.submissions[0].value.requestId, 'confirmation-a'); assert.equal(f.execution.getState().phase, 'settled');
  assert.equal(f.execution.getState().submitted, true); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.snapshot));
});

test('matching confirmations coalesce, but changed values or request IDs cannot share an attempt', async t => {
  const pending = deferred(), f = fixture(t, { read: () => pending.promise });
  const first = f.execution.confirm(request({ a: 1, b: { c: 2 } }));
  assert.equal(f.execution.confirm(request({ b: { c: 2 }, a: 1 })), first);
  assert.equal((await f.execution.confirm(request({ a: 9 }))).code, 'CONFIRMATION_CONFLICT');
  assert.equal((await f.execution.confirm({ ...request(), requestId: 'confirmation-b' })).code, 'CONFIRMATION_CONFLICT');
  pending.resolve(fresh()); assert.equal((await first).status, 'succeeded'); assert.equal(f.submissions.length, 1);
});

test('confirmation input and adapter snapshots are copied and frozen before use', async t => {
  const pending = deferred(), initial = request({ nested: { value: 1 } }); let observed;
  const f = fixture(t, { read: () => pending.promise, validate: value => { observed = value; return { id: value.actionId, enabled: true }; } });
  const result = f.execution.confirm(initial); initial.values.nested.value = 9; initial.resource.id = 'vm-b'; pending.resolve(fresh()); await result;
  assert.equal(f.submissions[0].value.values.nested.value, 1); assert.equal(f.submissions[0].value.resource.id, 'vm-a');
  assert.ok(Object.isFrozen(observed.snapshot)); assert.ok(Object.isFrozen(observed.capabilities)); assert.ok(Object.isFrozen(f.submissions[0].value.values.nested));
});

for (const mode of ['ID mismatch', 'permission denied', 'action mismatch', 'builder rejected']) test(`${mode} never enters execute`, async t => {
  const f = fixture(t, {
    ...(mode === 'ID mismatch' ? { read: async () => fresh('vm-b') } : {}),
    ...(mode === 'permission denied' ? { read: async () => ({ ...fresh(), capabilities: { 'vm.power.shutdown': { allowed: false } } }) } : {}),
    ...(mode === 'action mismatch' ? { validate: () => ({ id: 'vm.delete', enabled: true }) } : {}),
    ...(mode === 'builder rejected' ? { buildRequest: () => { throw new Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); } } : {}),
  });
  const result = await f.execution.confirm(request()); assert.equal(result.status, 'failed'); assert.equal(f.submissions.length, 0); assert.equal(f.tasks.length, 0);
  assert.equal(f.execution.getState().submitted, false); assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_PRIVATE_DIAGNOSTIC/);
});

test('fresh state changes remain authoritative at confirmation time', async t => {
  const f = fixture(t, { read: async () => ({ ...fresh(), snapshot: { id: 'vm-a', status: 'STOPPED' } }) });
  assert.equal((await f.execution.confirm(request())).status, 'failed'); assert.equal(f.submissions.length, 0);
});

test('cancel before confirmation and an already aborted caller signal never submit', async t => {
  const a = fixture(t); a.execution.cancel(); assert.equal((await a.execution.confirm(request())).status, 'cancelled'); assert.equal(a.reads.length, 0);
  const b = fixture(t), caller = new AbortController(); caller.abort(); const result = await b.execution.confirm(request(), { signal: caller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(b.reads.length, 0); assert.equal(b.submissions.length, 0); assert.equal(b.timers.size, 0);
});

test('cancelling a pending read ignores its eventual result without submission', async t => {
  const pending = deferred(), f = fixture(t, { read: () => pending.promise }); const promise = f.execution.confirm(request()); await settle();
  f.execution.cancel(); assert.equal((await promise).status, 'cancelled'); assert.equal(f.reads[0].options.signal.aborted, true);
  pending.resolve(fresh()); await settle(); assert.equal(f.submissions.length, 0); assert.equal(f.timers.size, 0);
});

test('an absolute deadline blocks a late preflight even before its timer callback runs', async t => {
  const pending = deferred(), f = fixture(t, { read: () => pending.promise }); const promise = f.execution.confirm(request()); await settle();
  f.advance(120001); pending.resolve(fresh()); assert.equal((await promise).status, 'cancelled'); assert.equal(f.submissions.length, 0);
});

test('a view callback cancelling at submission preparation still prevents execute', async t => {
  let execution; const f = fixture(t, { onProgress: value => { if (value.phase === 'submitting') execution.cancel(); } }); execution = f.execution;
  const result = await execution.confirm(request()); assert.equal(result.status, 'cancelled'); assert.equal(f.submissions.length, 0);
});

for (const reason of ['cancel', 'timeout', 'transport error']) test(`${reason} after entering execute is unknown and cannot automatically resubmit`, async t => {
  const pending = deferred(), f = fixture(t, { execute: () => reason === 'transport error' ? Promise.reject(new Error('EXAMPLE_PRIVATE_DIAGNOSTIC')) : pending.promise });
  const initial = request(), promise = f.execution.confirm(initial); await settle(); assert.equal(f.submissions.length, 1);
  if (reason === 'cancel') f.execution.cancel(); if (reason === 'timeout') f.fire(120000);
  const result = await promise; assert.equal(result.status, 'unknown'); assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_PRIVATE_DIAGNOSTIC/);
  assert.equal(f.execution.confirm(initial), promise); assert.equal((await f.execution.confirm(initial)).status, 'unknown');
  pending.resolve({ status: 'succeeded', operationId: OPERATION_A }); await settle(); assert.equal(f.submissions.length, 1); assert.equal(f.timers.size, 0);
});

test('running operations poll only the exact returned operation ID and submit once', async t => {
  let polls = 0;
  const f = fixture(t, { execute: async () => ({ status: 'running', operationId: OPERATION_A, taskId: 'task-a' }), task: async operationId => (++polls === 1 ? { status: 'running', operationId } : { status: 'succeeded', operationId, snapshot: { id: 'vm-a', status: 'STOPPED' } }) });
  const promise = f.execution.confirm(request()); await settle(); f.fire(1000); await settle(); f.fire(1000);
  const result = await promise; assert.equal(result.status, 'succeeded'); assert.equal(result.operationId, OPERATION_A); assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.tasks.map(call => call.operationId), [OPERATION_A, OPERATION_A]); assert.equal(f.reads.length, 1); assert.equal(f.timers.size, 0);
});

test('a different operation ID in a task update is not followed or treated as success', async t => {
  const f = fixture(t, { execute: async () => ({ status: 'running', operationId: OPERATION_A }), task: async () => ({ status: 'succeeded', operationId: OPERATION_B }) });
  const promise = f.execution.confirm(request()); await settle(); f.fire(1000); const result = await promise;
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'OPERATION_ID_MISMATCH'); assert.equal(result.operationId, OPERATION_A); assert.equal(f.tasks.length, 1);
});

test('poll limits and cancellation during a poll delay never repeat execute', async t => {
  const f = fixture(t, { maxPolls: 2, execute: async () => ({ status: 'running', operationId: OPERATION_A }), task: async operationId => ({ status: 'running', operationId }) });
  const promise = f.execution.confirm(request()); await settle(); f.fire(1000); await settle(); f.fire(1000);
  assert.equal((await promise).status, 'unknown'); assert.equal(f.tasks.length, 2); assert.equal(f.submissions.length, 1); assert.equal(f.timers.size, 0);
  const g = fixture(t, { execute: async () => ({ status: 'running', operationId: OPERATION_A }) });
  const cancelled = g.execution.confirm(request()); await settle(); g.execution.stop(); const result = await cancelled;
  assert.equal(result.status, 'unknown'); assert.equal(result.operationId, OPERATION_A); assert.equal(g.tasks.length, 0); assert.equal(g.timers.size, 0);
});

test('host task failure or paused uncertainty stays non-success and preserves correlation', async t => {
  for (const response of [{ status: 'failed', code: 'TASK_FAILED' }, { status: 'unknown', code: 'TASK_PAUSED' }]) {
    const f = fixture(t, { execute: async () => ({ status: 'running', operationId: OPERATION_A }), task: async operationId => ({ ...response, operationId, taskId: 'task-a' }) });
    const promise = f.execution.confirm(request()); await settle(); f.fire(1000); const result = await promise;
    assert.equal(result.status, response.status); assert.equal(result.code, response.code); assert.equal(result.taskId, 'task-a'); assert.equal(result.operationId, OPERATION_A);
  }
});

test('unknown schemas and readback identity mismatches are never promoted to success', async t => {
  for (const response of [{ status: 'SUCCESSED', operationId: OPERATION_A }, { status: 'succeeded', operationId: OPERATION_A, snapshot: { id: 'vm-b' } }, { status: 'succeeded' }, { status: 'running', operationId: 'operation-a' }, { status: 'succeeded', operationId: 'A'.repeat(64) }]) {
    const f = fixture(t, { execute: async () => response }); assert.equal((await f.execution.confirm(request())).status, 'unknown'); assert.equal(f.submissions.length, 1);
  }
});

test('only safe host codes are returned, and external abort subscriptions are released', async t => {
  const external = new AbortController(); let attached = 0, removed = 0;
  const add = external.signal.addEventListener.bind(external.signal), remove = external.signal.removeEventListener.bind(external.signal);
  external.signal.addEventListener = (...args) => { attached++; return add(...args); }; external.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  const f = fixture(t, { execute: async () => ({ status: 'failed', operationId: OPERATION_A, code: 'EXAMPLE_PRIVATE_DIAGNOSTIC=not-a-safe-code', message: 'EXAMPLE_PRIVATE_DIAGNOSTIC' }) });
  const result = await f.execution.confirm(request(), { signal: external.signal });
  assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_PRIVATE_DIAGNOSTIC/); assert.equal(attached, 1); assert.equal(removed, 1); assert.equal(f.timers.size, 0);
});

test('invalid confirmation values fail locally without invoking a bridge', async t => {
  const f = fixture(t); const malformed = [request(), { ...request(), resource: { type: 'vm', id: '../other' } }, { ...request(), requestId: '' }, { ...request(), values: [] }];
  delete malformed[0].actionId;
  for (const value of malformed) assert.equal((await f.execution.confirm(value)).code, 'INVALID_CONFIRMATION');
  assert.equal(f.reads.length, 0); assert.equal(f.submissions.length, 0);
});
