import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectAll, validateBatchOperation, createBatchController } from '../src/batch-collection.js';

const operationId = randomUUID();
const item = (id, status) => ({ diskId: 'example-disk-' + id, generation: String(id).repeat(64), status });
const result = (statuses = ['running', 'queued'], status = 'running') => ({ schemaVersion: 1, operationId, status,
  summary: { total: statuses.length, ...Object.fromEntries(['queued', 'running', 'succeeded', 'failed', 'unknown', 'skipped'].map(key => [key, statuses.filter(value => value === key).length])) },
  items: statuses.map((state, index) => item(index + 1, state)) });
const options = extra => ({ requestId: randomUUID(), signal: new AbortController().signal, intervalMs: 1, timeoutMs: 500, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('batch emits a single target-free POST and bounded operation GETs without per-disk fanout', async () => {
  let posts = 0, gets = 0; const request = options(), progress = [];
  const provider = {
    collectAll: async args => { posts++; assert.deepEqual(Object.keys(args).sort(), ['requestId', 'signal']); assert.equal(args.requestId, request.requestId); return result(); },
    collectionAll: async args => { gets++; assert.deepEqual(Object.keys(args).sort(), ['operationId', 'signal']); assert.equal(args.operationId, operationId); return result(['succeeded', 'succeeded'], 'succeeded'); },
    collect() { throw new Error('FRONTEND_FANOUT'); },
  };
  const outcome = await collectAll(provider, { ...request, onProgress: value => progress.push(value) });
  assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(outcome.status, 'succeeded'); assert.equal(outcome.summary.succeeded, 2); assert.equal(progress.length, 2);
});

test('batch rejects false success, inconsistent totals, duplicate identities, invalid generations and oversized results', () => {
  const valid = result(['succeeded', 'skipped'], 'failed'); valid.items[1].code = 'private error text';
  assert.equal(validateBatchOperation(valid).items[1].code, 'SMART_COLLECTION_UNKNOWN');
  const malformed = [result([], 'succeeded'), result([], 'failed'), result(['succeeded', 'failed'], 'succeeded'), result(['running'], 'failed'),
    result(['failed'], 'running'), result(['succeeded'], 'failed'), result(['failed'], 'unknown'), result(['unknown'], 'failed')];
  const count = result(); count.summary.total++; malformed.push(count);
  const swapped = result(); swapped.items[1].diskId = swapped.items[0].diskId; malformed.push(swapped);
  const generation = result(); generation.items[0].generation = 'private'; malformed.push(generation);
  const tooMany = result(Array(101).fill('queued')); malformed.push(tooMany);
  const wrongBucket = result(); wrongBucket.items[0].status = 'succeeded'; malformed.push(wrongBucket);
  for (const value of malformed) assert.throws(() => validateBatchOperation(value), /INVALID_COLLECTION_RESPONSE/);
  assert.throws(() => validateBatchOperation(result(), randomUUID()), /INVALID_COLLECTION_RESPONSE/);
});

test('batch partial failure and an empty-target precondition cannot become success', async () => {
  for (const value of [result(['succeeded', 'failed', 'skipped'], 'failed')]) {
    let gets = 0; const outcome = await collectAll({ collectAll: async () => value, collectionAll: async () => { gets++; } }, options());
    assert.equal(outcome.status, 'failed'); assert.equal(outcome.summary.total, value.summary.total); assert.equal(gets, 0);
  }
  const empty = await collectAll({ collectAll: async () => { throw Object.assign(new Error('SMART_BATCH_NO_TARGETS'), { status: 409 }); }, collectionAll: async () => {} }, options());
  assert.equal(empty.status, 'failed'); assert.equal(empty.code, 'SMART_BATCH_NO_TARGETS'); assert.equal(empty.operationId, null);
});

test('poll timeout preserves last progress as unknown and never resends the batch', async () => {
  let posts = 0, gets = 0;
  const outcome = await collectAll({ collectAll: async () => { posts++; return result(); }, collectionAll: async () => { gets++; return result(); } }, options({ timeoutMs: 2000 }));
  assert.equal(outcome.status, 'unknown'); assert.equal(outcome.summary.total, 2); assert.equal(outcome.operationId, operationId); assert.equal(posts, 1); assert.equal(gets, 30);
});

test('unacknowledged batch timeout never invents an operation or polls its late response', async () => {
  let release, gets = 0;
  const outcome = await collectAll({ collectAll: () => new Promise(resolve => { release = resolve; }), collectionAll: async () => { gets++; } }, options({ timeoutMs: 10 }));
  assert.equal(outcome.status, 'unknown'); assert.equal(outcome.operationId, null); assert.equal(outcome.summary, undefined);
  release(result()); await tick(); assert.equal(gets, 0);
});

test('controller blocks double submit and stops waiting on settings unmount or plugin stop without late updates', async () => {
  for (const reason of ['unmount', 'stop']) {
    let release, posts = 0, gets = 0;
    const controller = createBatchController({ crypto: globalThis.crypto, AbortController }, {
      collectAll: () => { posts++; return new Promise(resolve => { release = resolve; }); }, collectionAll: async () => { gets++; },
    }, { intervalMs: 1, timeoutMs: 500 });
    const states = [], unsubscribe = controller.subscribe(state => states.push(state)); controller.start();
    const pending = controller.collect(); controller.collect(); assert.equal(posts, 1); assert.equal(controller.snapshot().status, 'running');
    if (reason === 'unmount') unsubscribe(); else controller.stop();
    const stopped = controller.snapshot(); assert.equal(stopped.status, 'unknown'); assert.equal(stopped.code, 'SMART_COLLECTION_WAIT_CANCELLED');
    release(result()); await pending; await tick(); assert.deepEqual(controller.snapshot(), stopped); assert.equal(gets, 0); assert.equal(posts, 1); unsubscribe();
  }
});

test('controller never collects without capability or before activation', async () => {
  let posts = 0; const provider = { collectAll: async () => { posts++; return result(['succeeded'], 'succeeded'); }, collectionAll: async () => {} };
  const controller = createBatchController({ crypto: globalThis.crypto, AbortController }, provider);
  await controller.collect(); assert.equal(posts, 0); controller.start(); await controller.collect(); assert.equal(posts, 1);
  const unavailable = createBatchController({ crypto: globalThis.crypto, AbortController }, {}); unavailable.start(); await unavailable.collect(); assert.equal(unavailable.snapshot().available, false);
});
