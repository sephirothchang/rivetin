import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createApi } from '../server/http.js';
import { createClient } from '../src/client.js';
import { createDataProviders } from '../src/data-providers.js';
import { smartFixture, caller, smartId } from './data-fixture.js';

const prefix = '/api/rivetin/v1/data/disk-smart';
const origin = 'https://tower.example.invalid';
const counts = (total, values = {}) => ({ total, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0, skipped: 0, ...values });
async function waitFor(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() >= deadline) assert.fail('Local mocked transport did not start'); await pause(1); }
}
async function alternateListener(t, service) {
  const identities = new Map([
    ['EXAMPLE_OTHER_ADMIN_TOKEN', { ...caller, id: 'example-other-admin' }],
    ['EXAMPLE_READER_TOKEN', { ...caller, id: 'example-reader', admin: false, role: 'USER' }],
  ]);
  const server = http.createServer(createApi(service, { origins: [origin], authenticate: async req => {
    const actor = identities.get(req.headers.authorization);
    return actor ? { ...actor, auth: { Authorization: req.headers.authorization } } : null;
  } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = token => createClient({ localStorage: { getItem: () => JSON.stringify({ value: token }) }, fetch: (route, options) => fetch(url + route, { ...options, headers: { ...options.headers, Origin: origin } }) });
  return { url, other: createDataProviders(client('EXAMPLE_OTHER_ADMIN_TOKEN'), smartId).diskSmart, reader: createDataProviders(client('EXAMPLE_READER_TOKEN'), smartId).diskSmart };
}
function assertSafeEnvelope(value) {
  const raw = JSON.stringify(value);
  for (const forbidden of ['192.0.2.', '/dev/', 'serial', 'smartctl', 'EXAMPLE_NOT_A_REAL', 'Authorization', 'stdout', 'stderr']) assert.ok(!raw.includes(forbidden), forbidden);
  assert.deepEqual(Object.keys(value).filter(key => key !== 'code').sort(), ['schemaVersion', 'operationId', 'status', 'summary', 'items'].sort());
  assert.equal(value.items.length, value.summary.total);
  for (const row of value.items) assert.deepEqual(Object.keys(row).filter(key => key !== 'code').sort(), ['diskId', 'generation', 'status']);
}

test('global SMART HTTP/client batch collects exactly both approved bound disks and reuses a terminal UUID', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve();
  const scheduleFile = path.join(f.directory, 'ssh-channel', 'approvals.json');
  const schedule = JSON.parse(await readFile(scheduleFile, 'utf8')).schedules;
  await f.service.sshChannel.tick(); assert.equal(f.runs(), 0, 'approval does not make a daily plan due immediately');
  const identities = await Promise.all(['example-disk', 'example-disk-second'].map(diskId => f.provider.resolveDisk({ diskId })));
  const requestId = randomUUID(), initial = await f.provider.collectAll({ requestId });
  assert.equal(initial.schemaVersion, 1); assert.equal(initial.status, 'running'); assert.equal(initial.summary.total, 2); assertSafeEnvelope(initial);
  await f.service.smartBatch.drain();
  const completed = await f.provider.collectionAll({ operationId: initial.operationId });
  assert.equal(completed.status, 'succeeded'); assert.deepEqual(completed.summary, counts(2, { succeeded: 2 })); assertSafeEnvelope(completed);
  assert.deepEqual(completed.items.map(row => [row.diskId, row.generation]).sort(), identities.map(row => [row.diskId, row.generation]).sort());
  assert.equal(f.runs(), 2);
  assert.deepEqual([...f.commands].sort(), ['sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sda', 'sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sdb']);
  for (const identity of identities) assert.equal((await f.provider.readLatest({ identity })).status, 'ok');
  assert.deepEqual(await f.provider.collectAll({ requestId }), completed);
  assert.equal(f.runs(), 2, 'duplicate request never repeats either SSH command');
  assert.deepEqual(JSON.parse(await readFile(scheduleFile, 'utf8')).schedules, schedule, 'manual batch does not advance or rewrite the daily plan');
});

test('global batch reports one actual mocked disk failure without inventing full success or retrying', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve();
  f.failRun(({ command }) => command.endsWith('/dev/sdb'));
  const initial = await f.provider.collectAll({ requestId: randomUUID() }); await f.service.smartBatch.drain();
  const result = await f.provider.collectionAll({ operationId: initial.operationId });
  assert.equal(result.status, 'failed'); assert.deepEqual(result.summary, counts(2, { succeeded: 1, failed: 1 }));
  assert.equal(result.items.find(row => row.diskId === 'example-disk').status, 'succeeded');
  const failed = result.items.find(row => row.diskId === 'example-disk-second'); assert.equal(failed.status, 'failed'); assert.match(failed.code, /^(?:SSH|SMART)_[A-Z_]+$/);
  assert.equal(f.runs(), 2); assertSafeEnvelope(result);
});

test('global batch requires explicit SSH approval and nonempty authoritative bindings', async t => {
  const f = await smartFixture(t, { twoDevices: true });
  await assert.rejects(f.provider.collectAll({ requestId: randomUUID() }), error => error.status === 403 && error.code === 'SMART_BATCH_NO_APPROVED_TARGETS');
  assert.equal(f.runs(), 0);
  await f.service.smartUnbind('example-disk', caller); await f.service.smartUnbind('example-disk-second', caller);
  await assert.rejects(f.provider.collectAll({ requestId: randomUUID() }), error => error.status === 409 && error.code === 'SMART_BATCH_NO_TARGETS');
  assert.equal(f.runs(), 0);
});

test('global batch POST rejects missing fresh Tower access before exposing targets or persisting admission', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve(); f.deny();
  await assert.rejects(f.provider.collectAll({ requestId: randomUUID() }), error => error.status === 403 && error.code === 'SMART_BATCH_FORBIDDEN');
  assert.equal(f.runs(), 0);
  try {
    const document = JSON.parse(await readFile(path.join(f.directory, 'smart-batch', 'operations.json'), 'utf8'));
    assert.deepEqual(document.items, {}, 'rejected admission cannot create a durable batch marker');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
});

test('actual global batch POST forbids authentication/origin bypass and caller-supplied commands or targets', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve();
  const payload = { pluginId: smartId, requestId: randomUUID() };
  const request = (extra, headers = {}) => fetch(f.url + prefix + '/collect-all', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...payload, ...extra }) });
  assert.equal((await request({})).status, 401);
  assert.equal((await request({}, { Authorization: caller.auth.Authorization, Origin: 'https://untrusted.example.invalid' })).status, 403);
  for (const extra of [{ command: '/usr/bin/uname -srm' }, { path: '/dev/sdc' }, { hostId: 'other-host' }, { diskIds: ['example-disk'] }, { generation: 'a'.repeat(64) }]) {
    assert.equal((await request(extra, { Authorization: caller.auth.Authorization, Origin: origin })).status, 400);
  }
  const alternate = await alternateListener(t, f.service);
  await assert.rejects(alternate.reader.collectAll({ requestId: randomUUID() }), error => error.status === 403);
  assert.equal(f.runs(), 0);
});

test('global batch GET and request UUID remain isolated by actor and plugin with fresh read authorization', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve();
  const alternate = await alternateListener(t, f.service), requestId = randomUUID();
  const initial = await f.provider.collectAll({ requestId }); await f.service.smartBatch.drain();
  await assert.rejects(alternate.other.collectionAll({ operationId: initial.operationId }), error => error.status === 404);
  await assert.rejects(alternate.reader.collectionAll({ operationId: initial.operationId }), error => error.status === 403);
  const foreign = await fetch(f.url + prefix + '/collection-all?' + new URLSearchParams({ pluginId: 'rivetin-other-example', operationId: initial.operationId }), { headers: { Authorization: caller.auth.Authorization } });
  assert.ok([403, 404].includes(foreign.status));
  const duplicateQuery = await fetch(f.url + prefix + '/collection-all?' + new URLSearchParams([['pluginId', smartId], ['pluginId', smartId], ['operationId', initial.operationId]]), { headers: { Authorization: caller.auth.Authorization } });
  assert.equal(duplicateQuery.status, 400);
  f.deny();
  await assert.rejects(f.provider.collectionAll({ operationId: initial.operationId }), error => error.status === 403);
  await assert.rejects(f.provider.collectAll({ requestId }), error => error.status === 403);
  assert.equal(f.runs(), 2, 'authorization failure cannot replay an accepted UUID');
});

test('a pending global batch is idempotent and revoking approval prevents execution of the next queued disk', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve();
  let release;
  f.failRun(() => new Promise(resolve => { release = resolve; }));
  t.after(() => release?.(false));
  const requestId = randomUUID(), initial = await f.provider.collectAll({ requestId }); await waitFor(() => f.runs() === 1);
  const duplicate = await f.provider.collectAll({ requestId }); assert.equal(duplicate.operationId, initial.operationId); assert.equal(f.runs(), 1);
  await f.service.sshChannel.revoke(smartId, caller); release(false);
  await f.service.smartBatch.drain();
  const result = await f.provider.collectionAll({ operationId: initial.operationId });
  assert.notEqual(result.status, 'succeeded'); assert.equal(result.summary.total, 2); assert.equal(result.summary.queued, 0); assert.equal(result.summary.running, 0);
  assert.equal(f.runs(), 1, 'approval changes cannot follow or run the queued target'); assertSafeEnvelope(result);
});

test('revoking Tower disk visibility hides the whole batch and prevents a queued disk from running', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve();
  let release;
  f.failRun(() => new Promise(resolve => { release = resolve; })); t.after(() => release?.(false));
  const initial = await f.provider.collectAll({ requestId: randomUUID() }); await waitFor(() => f.runs() === 1);
  f.deny();
  await assert.rejects(f.provider.collectionAll({ operationId: initial.operationId }), error => error.status === 403);
  release(false); await f.service.smartBatch.drain();
  assert.equal(f.runs(), 1); assert.ok(f.reads.every(row => row.actorId === caller.id && row.auth.Authorization === caller.auth.Authorization));
});

test('global batch shares single-disk and SSH host exclusion without retrying conflicts or starting the daily plan', async t => {
  const f = await smartFixture(t, { twoDevices: true }); await f.approve();
  let release;
  f.failRun(() => new Promise(resolve => { release = resolve; })); t.after(() => release?.(false));
  const identity = await f.provider.resolveDisk({ diskId: 'example-disk' });
  const single = await f.provider.collect({ identity, requestId: randomUUID() }); await waitFor(() => f.runs() === 1);
  const batch = await f.provider.collectAll({ requestId: randomUUID() });
  await f.service.smartBatch.drain();
  const result = await f.provider.collectionAll({ operationId: batch.operationId });
  assert.equal(result.status, 'failed'); assert.deepEqual(result.summary, counts(2, { failed: 2 }));
  assert.equal(result.items.find(item => item.diskId === 'example-disk').code, 'SMART_BATCH_CONFLICT');
  assert.equal(f.runs(), 1, 'neither the occupied disk nor another disk on its occupied SSH host executes');
  release(false); await f.service.smartCollection.drain();
  assert.equal((await f.provider.collection({ identity, operationId: single.operationId })).status, 'succeeded');
  await f.service.sshChannel.tick(); assert.equal(f.runs(), 1, 'manual conflicts do not trigger a schedule retry');
});
