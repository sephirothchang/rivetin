import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataProviders } from '../src/data-providers.js';

const pluginId = 'rivetin-smart-example';
const requestId = 'e5bcb770-85ae-4fd9-99b2-24ac33c7db00';
const operationId = '8993de42-713b-42e9-ab8d-6803bdc11d50';
const response = () => ({ schemaVersion: 1, operationId, status: 'running', summary: { total: 1, queued: 1, running: 0, succeeded: 0, failed: 0, unknown: 0, skipped: 0 }, items: [{ diskId: 'example-disk', generation: 'a'.repeat(64), status: 'queued' }] });

test('global SMART bridge submits exactly one scoped request and polls without target fanout', async () => {
  const calls = [], signal = new AbortController().signal;
  const bridge = createDataProviders(async (...args) => { calls.push(args); return response(); }, pluginId).diskSmart;
  assert.deepEqual(await bridge.collectAll({ requestId, signal, targets: ['ignored-device'] }), response());
  await bridge.collectionAll({ operationId, signal });
  assert.deepEqual(calls[0].slice(0, 3), ['/data/disk-smart/collect-all', 'POST', { pluginId, requestId }]);
  const params = new URL('https://tower.example.invalid' + calls[1][0]).searchParams;
  assert.deepEqual([...params.keys()].sort(), ['operationId', 'pluginId']);
  assert.equal(params.get('operationId'), operationId);
  assert.ok(calls.every(call => call[3].signal === signal));
  await assert.rejects(bridge.collectAll({ requestId: 'invalid' }), /SMART_COLLECTION_REQUEST_INVALID/);
  await assert.rejects(bridge.collectionAll({ operationId: 'invalid' }), /SMART_COLLECTION_REQUEST_INVALID/);
  assert.equal(calls.length, 2);
});

test('batch bridge rejects inconsistent counts, duplicate identities, invalid terminal states and unsafe codes', async () => {
  const cases = [
    value => { value.summary.total = 2; },
    value => { value.summary.queued = 0; value.summary.failed = 1; },
    value => { value.items.push({ ...value.items[0] }); value.summary.total = 2; value.summary.queued = 2; },
    value => { value.status = 'succeeded'; },
    value => { value.status = 'failed'; },
    value => { value.status = 'unknown'; },
    value => { value.items[0].status = 'failed'; value.summary.queued = 0; value.summary.failed = 1; },
    value => { value.status = 'failed'; value.items[0].status = 'succeeded'; value.summary.queued = 0; value.summary.succeeded = 1; },
    value => { value.status = 'unknown'; value.items[0].status = 'failed'; value.summary.queued = 0; value.summary.failed = 1; },
    value => { value.status = 'failed'; value.items = []; value.summary.queued = 0; value.summary.total = 0; },
    value => { value.items[0].code = '/private/raw/error'; },
    value => { value.code = 'Error: raw diagnostic'; },
    value => { value.items[0].generation = 'not-a-generation'; },
    value => { value.summary.queued = -1; },
    value => { value.summary.queued = 1.5; },
    value => { value.summary.unexpected = 1; },
    value => { value.items = Array.from({ length: 101 }, (_, i) => ({ ...value.items[0], diskId: `disk-${i}` })); value.summary.total = value.summary.queued = 101; },
  ];
  for (const mutate of cases) {
    const value = response(); mutate(value);
    const bridge = createDataProviders(async () => value, pluginId).diskSmart;
    await assert.rejects(bridge.collectAll({ requestId }), /SMART_BATCH_RESPONSE_INVALID/);
  }
  const bridge = createDataProviders(async () => response(), pluginId).diskSmart;
  await assert.rejects(bridge.collectionAll({ operationId: requestId }), /SMART_BATCH_RESPONSE_INVALID/);
});

test('batch bridge strips private fields and preserves terminal partial results', async () => {
  const value = response();
  value.status = 'failed'; value.summary.queued = 0; value.summary.failed = 1;
  value.items[0].status = 'failed'; value.items[0].code = 'SSH_REMOTE_COMMAND_FAILED';
  value.items[0].path = '/private/ignored'; value.actor = { auth: 'EXAMPLE_NOT_A_REAL_TOKEN' };
  const result = await createDataProviders(async () => value, pluginId).diskSmart.collectAll({ requestId });
  assert.equal(result.status, 'failed'); assert.equal(result.items[0].code, 'SSH_REMOTE_COMMAND_FAILED');
  assert.equal(Object.hasOwn(result, 'actor'), false); assert.equal(Object.hasOwn(result.items[0], 'path'), false);
});

test('batch bridge never retries failed or cancelled submissions', async () => {
  let calls = 0; const signal = new AbortController();
  const bridge = createDataProviders(async () => { calls++; signal.abort(); return response(); }, pluginId).diskSmart;
  await assert.rejects(bridge.collectAll({ requestId, signal: signal.signal }), /REQUEST_CANCELLED/);
  await assert.rejects(bridge.collectAll({ requestId, signal: signal.signal }), /REQUEST_CANCELLED/);
  assert.equal(calls, 1);
  const failed = createDataProviders(async () => { calls++; throw new Error('SMART_BATCH_NO_TARGETS'); }, pluginId).diskSmart;
  await assert.rejects(failed.collectAll({ requestId }), /SMART_BATCH_NO_TARGETS/);
  assert.equal(calls, 2);
});
