import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectDisk, validateOperation } from '../src/collection.js';
import { disks, mockIdentity } from '../demo/fixtures.js';
const identity = mockIdentity(disks[0]), operationId = randomUUID();
const result = (status = 'running', extra = {}) => ({ schemaVersion: 1, operationId, status, ...extra });
const options = extra => ({ identity, requestId: randomUUID(), signal: new AbortController().signal, intervalMs: 1, timeoutMs: 500, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one explicit collection sends one POST then bounded identity-bound GETs', async () => {
  let posts = 0, gets = 0; const request = options(), progress = [];
  const provider = {
    async collect(args) { posts++; assert.deepEqual(args.identity, identity); assert.equal(args.requestId, request.requestId); return result(); },
    async collection(args) { gets++; assert.deepEqual(args.identity, identity); assert.equal(args.operationId, operationId); return result(gets === 2 ? 'succeeded' : 'running'); },
  };
  assert.equal((await collectDisk(provider, { ...request, onProgress: value => progress.push(value.status) })).status, 'succeeded');
  assert.equal(posts, 1); assert.equal(gets, 2); assert.deepEqual(progress, ['running', 'running', 'succeeded']);
});

test('approval rejection is explicit while ambiguous POST failures never claim definite failure or retry', async () => {
  for (const [error, status, code] of [
    [Object.assign(new Error('private text'), { status: 403, code: 'SSH_APPROVAL_REVOKED' }), 'failed', 'SSH_APPROVAL_REQUIRED'],
    [new TypeError('private transport text'), 'unknown', 'SMART_COLLECTION_UNKNOWN'],
    [Object.assign(new Error('private server text'), { status: 503 }), 'unknown', 'SMART_COLLECTION_UNKNOWN'],
  ]) {
    let posts = 0, gets = 0;
    const outcome = await collectDisk({ collect: async () => { posts++; throw error; }, collection: async () => { gets++; } }, options());
    assert.equal(outcome.status, status); assert.equal(outcome.code, code); assert.equal(posts, 1); assert.equal(gets, 0);
    assert.equal(JSON.stringify(outcome).includes('private'), false);
  }
});

test('pending POST times out as unknown; its late response cannot start polling', async () => {
  let release, posts = 0, gets = 0; const progress = [];
  const outcome = await collectDisk({ collect: () => { posts++; return new Promise(resolve => { release = resolve; }); }, collection: async () => { gets++; return result('succeeded'); } }, options({ timeoutMs: 10, onProgress: value => progress.push(value) }));
  assert.equal(outcome.status, 'unknown'); assert.equal(outcome.operationId, null); assert.equal(outcome.code, 'SMART_COLLECTION_WAIT_TIMEOUT');
  release(result()); await tick(); assert.equal(posts, 1); assert.equal(gets, 0); assert.equal(progress.length, 0);
});

test('polling stops after thirty reads without a second POST', async () => {
  let posts = 0, gets = 0;
  const outcome = await collectDisk({ collect: async () => { posts++; return result(); }, collection: async () => { gets++; return result(); } }, options({ timeoutMs: 2000 }));
  assert.equal(outcome.status, 'unknown'); assert.equal(outcome.operationId, operationId); assert.equal(posts, 1); assert.equal(gets, 30);
});

test('operation ID swaps, malformed envelopes and unrecognized messages fail safely', async () => {
  assert.throws(() => validateOperation(result('running', { operationId: 'not-a-uuid' })), /INVALID_COLLECTION_RESPONSE/);
  let gets = 0;
  const outcome = await collectDisk({ collect: async () => result(), collection: async () => { gets++; return result('succeeded', { operationId: randomUUID(), code: 'private text' }); } }, options());
  assert.equal(outcome.status, 'unknown'); assert.equal(outcome.code, 'SMART_COLLECTION_UNKNOWN'); assert.equal(gets, 1);
});

test('terminal unknown or failed responses do not refresh or continue polling', async () => {
  for (const status of ['unknown', 'failed']) {
    let gets = 0;
    const outcome = await collectDisk({ collect: async () => result(), collection: async () => { gets++; return result(status, { code: 'SMART_COLLECTION_FAILED' }); } }, options());
    assert.equal(outcome.status, status); assert.equal(outcome.operationId, operationId); assert.equal(gets, 1);
  }
});

test('caller cancellation rejects before submit and ignores a late pending GET', async () => {
  const controller = new AbortController(); controller.abort(); let posts = 0;
  await assert.rejects(collectDisk({ collect: async () => { posts++; }, collection: async () => {} }, options({ signal: controller.signal })), { code: 'REQUEST_CANCELLED' }); assert.equal(posts, 0);
  const active = new AbortController(); let release, started;
  const pending = new Promise(resolve => { started = resolve; }); const progress = [];
  const promise = collectDisk({ collect: async () => result(), collection: () => { started(); return new Promise(resolve => { release = resolve; }); } }, options({ signal: active.signal, onProgress: value => progress.push(value.status) }));
  await pending; active.abort(); await assert.rejects(promise, { code: 'REQUEST_CANCELLED' }); release(result('succeeded')); await tick(); assert.deepEqual(progress, ['running']);
});

test('generation or read permission changes invalidate the data view', async () => {
  for (const code of ['SMART_GENERATION_CHANGED', 'SMART_DISK_FORBIDDEN']) {
    await assert.rejects(collectDisk({ collect: async () => result(), collection: async () => { throw Object.assign(new Error('private'), { code, status: 409 }); } }, options()), { code });
  }
});
