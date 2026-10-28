import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createSmartBatch } from '../server/smart-batch.js';
import { createSmartCollection } from '../server/smart-collection.js';

const actor = { id: 'example-admin', source: 'demo', admin: true, auth: { Authorization: 'Bearer EXAMPLE_NOT_A_REAL_TOKEN' } }, pluginId = 'rivetin-smart-example';
const input = patch => ({ pluginId, requestId: randomUUID(), actor, ...patch });
async function fixture(t, options = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'smart-batch-'));
  const state = { now: Date.now(), active: true, calls: [], fresh: [], approved: new Set(), ambiguous: new Set(), forbidden: new Set(), targets: new Map(), selections: new Map(), blockFresh: null };
  for (let index = 0; index < (options.count ?? 2); index++) {
    const diskId = `disk_${index}`, target = { profileHostId: `host_${index}`, deviceId: `device_${index}`, generation: (index + 1).toString(16).padStart(64, '0'), bindingToken: (index + 200).toString(16).padStart(64, '0') };
    state.targets.set(diskId, target); state.approved.add(diskId); state.selections.set(diskId, { pluginId, commandId: 'daily-smart', hostId: target.profileHostId, deviceId: target.deviceId, digest: 'd'.repeat(64), approvalId: randomUUID() });
  }
  const provider = {
    collectionCandidates: async ({ actor: who }) => { if (!who.admin || !state.active) throw Object.assign(new Error('SMART_PLUGIN_DISABLED'), { status: 403 }); return { items: [...state.targets].map(([diskId, target]) => ({ diskId, ...structuredClone(target) })) }; },
    collectionTarget: async args => { state.fresh.push(args.diskId); if (state.blockFresh) await state.blockFresh(args); if (!state.active || state.forbidden.has(args.diskId)) throw Object.assign(new Error('EXAMPLE_PRIVATE_ERROR'), { status: 403 }); const target = state.targets.get(args.diskId); if (!target || args.generation !== target.generation) throw Object.assign(new Error('SMART_GENERATION_CHANGED'), { status: 409 }); return structuredClone(target); },
  };
  const diskFor = target => [...state.targets].find(([, value]) => value.profileHostId === target.hostId && value.deviceId === target.deviceId)?.[0];
  const broker = {
    snapshotSmartSelections: async () => ({ items: [...state.selections].filter(([diskId]) => state.approved.has(diskId) && !state.ambiguous.has(diskId)).map(([, value]) => structuredClone(value)), rejected: [...state.ambiguous].map(diskId => ({ hostId: state.targets.get(diskId).profileHostId, deviceId: state.targets.get(diskId).deviceId, code: 'SSH_SMART_COMMAND_AMBIGUOUS' })) }),
    selectSmartTarget: async (_, target) => { const diskId = diskFor(target); if (!state.approved.has(diskId)) throw new Error('SSH_APPROVAL_REQUIRED'); if (state.ambiguous.has(diskId)) throw new Error('SSH_SMART_COMMAND_AMBIGUOUS'); return structuredClone(state.selections.get(diskId)); },
    runTarget: async (selection, who, opts) => { const diskId = diskFor(selection); state.calls.push(diskId); return options.run ? options.run(diskId, opts.signal, state) : { items: [{ result: 'success' }] }; },
  };
  const collection = createSmartCollection(root, { provider, broker, now: () => state.now });
  const batchOptions = { provider, broker, collection, now: () => state.now, ...(options.capacity ? { capacity: options.capacity } : {}) }, batch = createSmartBatch(root, batchOptions);
  t.after(async () => { await batch.stop(); await collection.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const get = (operation, args = { pluginId, actor }) => batch.get({ ...args, operationId: operation.operationId });
  return { root, state, provider, broker, collection, batch, batchOptions, get };
}
function complete(value) { const { total, ...counts } = value.summary; assert.equal(value.items.length, total); assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), total); }

test('batch acknowledges after bounded permission checks without waiting for command execution then runs serially', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { run: async () => { await blocked; return { items: [{ result: 'success' }] }; } });
  const args = input(), admitted = await f.batch.submit(args); assert.equal(admitted.status, 'running'); assert.equal(admitted.items.length, 2); complete(admitted); assert.ok(f.state.calls.length <= 1);
  release(); await f.batch.drain(); const result = await f.get(admitted); assert.equal(result.status, 'succeeded'); assert.equal(result.summary.succeeded, 2); complete(result); assert.deepEqual(f.state.calls, ['disk_0', 'disk_1']);
  assert.equal((await f.batch.submit(args)).operationId, admitted.operationId); assert.equal(f.state.calls.length, 2);
  const bytes = await readFile(path.join(f.root, 'smart-batch/operations.json'), 'utf8'); for (const forbidden of ['EXAMPLE_NOT_A_REAL_TOKEN', 'profileHostId', 'bindingToken', 'approvalId', 'device_0']) assert.ok(!bytes.includes(forbidden)); assert.ok(bytes.includes('guard'));
});

test('complete candidate sets are bounded and zero targets or all unapproved targets cannot be admitted', async t => {
  const empty = await fixture(t, { count: 0 }); await assert.rejects(empty.batch.submit(input()), { message: 'SMART_BATCH_NO_TARGETS', status: 409 });
  const unapproved = await fixture(t); unapproved.state.approved.clear(); await assert.rejects(unapproved.batch.submit(input()), { message: 'SMART_BATCH_NO_APPROVED_TARGETS', status: 403 }); assert.equal(unapproved.state.calls.length, 0);
  const large = await fixture(t, { count: 101 }); await assert.rejects(large.batch.submit(input()), { message: 'SMART_BATCH_TARGET_LIMIT', status: 409 }); assert.equal(large.state.calls.length, 0);
  const full = await fixture(t, { count: 100 }); let checks = 0; full.state.blockFresh = async args => { if (++checks <= 100) return; await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true })); };
  const response = await full.batch.submit(input()); assert.equal(response.items.length, 100); assert.equal(response.summary.total, 100); complete(response); await full.batch.stop();
});

test('unmapped or ambiguous targets are skipped without hiding any item and partial completion is failed', async t => {
  const f = await fixture(t, { count: 3 }); f.state.approved.delete('disk_1'); f.state.ambiguous.add('disk_2');
  const response = await f.batch.submit(input()); complete(response); assert.equal(response.summary.skipped, 2);
  await f.batch.drain(); const result = await f.get(response); assert.equal(result.status, 'failed'); assert.equal(result.summary.succeeded, 1); assert.equal(result.summary.skipped, 2); complete(result); assert.deepEqual(f.state.calls, ['disk_0']);
});

test('same-generation rebind and new approval identity cannot redirect a queued frozen snapshot', async t => {
  for (const kind of ['binding', 'approval', 'digest', 'command']) {
    let release; const held = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { run: async diskId => { if (diskId === 'disk_0') await held; return { items: [{ result: 'success' }] }; } }), operation = await f.batch.submit(input());
    while (!f.state.calls.length) await new Promise(resolve => setImmediate(resolve));
    if (kind === 'binding') f.state.targets.get('disk_1').bindingToken = 'e'.repeat(64);
    if (kind === 'approval') f.state.selections.get('disk_1').approvalId = randomUUID();
    if (kind === 'digest') f.state.selections.get('disk_1').digest = 'f'.repeat(64);
    if (kind === 'command') f.state.selections.get('disk_1').commandId = 'new-command';
    release(); await f.batch.drain(); const result = await f.get(operation); assert.equal(result.status, 'failed'); assert.equal(result.items[1].status, 'skipped'); assert.equal(result.items[1].code, 'SMART_BATCH_SNAPSHOT_CHANGED'); assert.deepEqual(f.state.calls, ['disk_0']);
  }
});

test('revoked approval is skipped and later independent disks still run without retry', async t => {
  const f = await fixture(t, { count: 3 }); let reads = 0; f.state.blockFresh = async args => { if (args.diskId === 'disk_1' && ++reads === 1) f.state.approved.delete('disk_1'); };
  const operation = await f.batch.submit(input()); await f.batch.drain(); const value = await f.get(operation); assert.equal(value.status, 'failed'); assert.equal(value.summary.skipped, 1); assert.equal(value.items[1].code, 'SMART_BATCH_NOT_APPROVED'); assert.deepEqual(f.state.calls, ['disk_0', 'disk_2']); complete(value);
});

test('manual single-disk requests share real collection admission locks with batch children', async t => {
  let finish; const f = await fixture(t, { count: 1, run: async () => new Promise(resolve => { finish = () => resolve({ items: [{ result: 'success' }] }); }) }), target = f.state.targets.get('disk_0');
  await f.collection.submit({ pluginId, diskId: 'disk_0', generation: target.generation, requestId: randomUUID(), actor }); while (!finish) await new Promise(resolve => setImmediate(resolve));
  const operation = await f.batch.submit(input()); await f.batch.drain(); const value = await f.get(operation); assert.equal(value.status, 'failed'); assert.equal(value.items[0].code, 'SMART_BATCH_CONFLICT'); assert.equal(f.state.calls.length, 1); finish(); await f.collection.drain();
});

test('only one active batch is admitted globally across actors and service instances', async t => {
  const f = await fixture(t); let checks = 0; f.state.blockFresh = async args => { if (++checks <= 2) return; await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true })); };
  const other = createSmartBatch(f.root, f.batchOptions); t.after(() => other.stop()); await f.batch.submit(input());
  await assert.rejects(other.submit(input({ actor: { ...actor, id: 'other-admin' } })), { message: 'SMART_BATCH_BUSY', status: 429 });
  await f.batch.stop();
});

test('stop aborts child wait, leaves remaining work unknown and never submits a later disk', async t => {
  const f = await fixture(t, { run: async (_, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ items: [{ result: 'failed', code: 'SSH_EXECUTION_CANCELLED' }] }), { once: true })) });
  const args = input(), operation = await f.batch.submit(args); while (!f.state.calls.length) await new Promise(resolve => setImmediate(resolve)); await f.batch.stop();
  const next = createSmartBatch(f.root, f.batchOptions); t.after(() => next.stop()); const value = await next.get({ pluginId, operationId: operation.operationId, actor }); assert.equal(value.status, 'unknown'); assert.equal(value.summary.unknown, 2); complete(value); assert.equal(f.state.calls.length, 1);
  assert.equal((await next.submit(args)).status, 'unknown'); assert.equal(f.state.calls.length, 1);
});

test('restart converts queued or running items to unknown and never reconstructs or replays snapshots', async t => {
  const f = await fixture(t), args = input(), operation = await f.batch.submit(args); await f.batch.drain(); const file = path.join(f.root, 'smart-batch/operations.json'), value = JSON.parse(await readFile(file)), row = Object.values(value.items)[0];
  row.status = 'running'; row.items.forEach(item => { item.status = 'queued'; }); row.owner.process = randomUUID(); row.owner.pid = process.pid; await writeFile(file, JSON.stringify(value));
  const restarted = createSmartBatch(f.root, f.batchOptions); t.after(() => restarted.stop()); const result = await restarted.get({ pluginId, operationId: operation.operationId, actor }); assert.equal(result.status, 'unknown'); assert.equal(result.summary.unknown, 2); complete(result); assert.equal((await restarted.submit(args)).status, 'unknown'); assert.equal(f.state.calls.length, 2);
});

test('five-minute deadline skips queued disks and does not launch a new child after expiry', async t => {
  const f = await fixture(t, { run: async (_, __, state) => { state.now += 300001; return { items: [{ result: 'success' }] }; } }), operation = await f.batch.submit(input()); await f.batch.drain();
  const result = await f.get(operation); assert.equal(result.status, 'unknown'); assert.equal(result.items[1].status, 'skipped'); assert.equal(result.items[1].code, 'SMART_BATCH_DEADLINE'); assert.equal(f.state.calls.length, 1); complete(result);
});

test('partial failed or unsupported samples cannot yield a successful batch and fixed errors do not expose raw messages', async t => {
  const f = await fixture(t, { run: async diskId => ({ items: [{ result: diskId === 'disk_0' ? 'success' : 'failed', code: 'SSH_SMART_UNSUPPORTED' }] }) }), operation = await f.batch.submit(input()); await f.batch.drain();
  const result = await f.get(operation); assert.equal(result.status, 'failed'); assert.equal(result.summary.succeeded, 1); assert.equal(result.summary.failed, 1); assert.equal(result.items[1].code, 'SMART_UNSUPPORTED'); complete(result);
});

test('batch polling rechecks every disk permission and refuses a partial response after permission changes', async t => {
  const f = await fixture(t), operation = await f.batch.submit(input()); await f.batch.drain(); f.state.forbidden.add('disk_1');
  await assert.rejects(f.get(operation), { message: 'SMART_BATCH_FORBIDDEN', status: 403 });
  f.state.forbidden.clear(); f.state.active = false; await assert.rejects(f.get(operation), { status: 403 });
});

test('batch POST exposes no candidate identities and writes no marker if any disk permission is denied', async t => {
  const f = await fixture(t); f.state.forbidden.add('disk_1');
  await assert.rejects(f.batch.submit(input()), { message: 'SMART_BATCH_FORBIDDEN', status: 403 }); assert.equal(f.state.calls.length, 0);
  await assert.rejects(readFile(path.join(f.root, 'smart-batch/operations.json')), { code: 'ENOENT' });
});

test('batch POST permission preflight has a five-second budget with no durable admission after timeout', async t => {
  const f = await fixture(t); f.state.blockFresh = async () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] }); const request = f.batch.submit(input()), rejected = assert.rejects(request, { message: 'SMART_BATCH_ACCESS_TIMEOUT', status: 504 });
  while (f.state.fresh.length < 2) await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(5000); await rejected;
  assert.equal(f.state.calls.length, 0); await assert.rejects(readFile(path.join(f.root, 'smart-batch/operations.json')), { code: 'ENOENT' });
});

test('stop during POST permission preflight prevents late durable admission and command execution', async t => {
  const f = await fixture(t); let release; const held = new Promise(resolve => { release = resolve; }); f.state.blockFresh = async () => held;
  const request = f.batch.submit(input()), rejected = assert.rejects(request, { message: 'SMART_BATCH_STOPPED', status: 503 });
  while (f.state.fresh.length < 2) await new Promise(resolve => setImmediate(resolve)); await f.batch.stop(); release(); await rejected; assert.equal(f.state.calls.length, 0); await assert.rejects(readFile(path.join(f.root, 'smart-batch/operations.json')), { code: 'ENOENT' });
});

test('batch GET has a five-second overall fresh-read budget and does not expose already checked items', async t => {
  const f = await fixture(t), operation = await f.batch.submit(input()); await f.batch.drain(); f.state.blockFresh = async () => new Promise(() => {});
  const before = f.state.fresh.length;
  t.mock.timers.enable({ apis: ['setTimeout'] }); const request = f.get(operation), rejected = assert.rejects(request, { message: 'SMART_BATCH_ACCESS_TIMEOUT', status: 504 });
  while (f.state.fresh.length < before + 2) await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(5000); await rejected;
});

test('request idempotency includes actor/source/plugin, and persistent marker capacity fails closed', async t => {
  const f = await fixture(t, { capacity: 1 }), args = input(), operation = await f.batch.submit(args); await f.batch.drain();
  await assert.rejects(f.batch.submit(input()), { message: 'SMART_BATCH_CAPACITY_EXCEEDED', status: 503 });
  await assert.rejects(f.batch.submit({ ...args, pluginId: 'rivetin-another-plugin' }), { message: 'SMART_BATCH_REQUEST_CONFLICT', status: 409 });
  for (const who of [{ ...actor, id: 'other-admin' }, { ...actor, source: 'tower' }]) await assert.rejects(f.get(operation, { pluginId, actor: who }), { message: 'SMART_BATCH_NOT_FOUND', status: 404 });
  assert.equal((await f.batch.submit(args)).operationId, operation.operationId); assert.equal(f.state.calls.length, 2);
});

test('new batch request IDs require UUIDv4 without creating any task marker', async t => {
  const f = await fixture(t); await assert.rejects(f.batch.submit(input({ requestId: '123e4567-e89b-12d3-a456-426614174000' })), { message: 'SMART_BATCH_REQUEST_INVALID', status: 400 }); assert.equal(f.state.calls.length, 0); await assert.rejects(readFile(path.join(f.root, 'smart-batch/operations.json')), { code: 'ENOENT' });
});

test('unknown child status interrupts the queue without issuing any replacement or later POST', async t => {
  const f = await fixture(t); let submissions = 0; const childOperation = randomUUID();
  const batch = createSmartBatch(f.root, { ...f.batchOptions, collection: { submit: async () => { submissions++; return { schemaVersion: 1, operationId: childOperation, status: 'unknown', code: 'SMART_COLLECTION_INTERRUPTED' }; }, get: async () => { throw new Error('POLL_MUST_NOT_REPLAY'); } } }); t.after(() => batch.stop());
  const operation = await batch.submit(input()); await batch.drain(); const value = await batch.get({ pluginId, operationId: operation.operationId, actor }); assert.equal(value.status, 'unknown'); assert.equal(value.summary.unknown, 2); assert.equal(submissions, 1); complete(value);
});
