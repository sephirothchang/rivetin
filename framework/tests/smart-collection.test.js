import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createSmartCollection } from '../server/smart-collection.js';
import { createSshBroker } from '../server/ssh-broker.js';
import { createSmartProvider } from '../server/smart-provider.js';

const actor = { id: 'example-admin', source: 'demo', admin: true, auth: { Authorization: 'Bearer EXAMPLE_NOT_REAL' } };
const input = (patch = {}) => ({ pluginId: 'rivetin-smart-example', diskId: 'disk-example', generation: 'a'.repeat(64), requestId: randomUUID(), actor, ...patch });
async function fixture(t, options = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'smart-collection-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const state = { target: { profileHostId: 'host-example', deviceId: 'device-example', generation: 'a'.repeat(64), bindingToken: 'b'.repeat(64) }, allowed: true, approved: true, runs: [], reads: 0, now: Date.now() };
  const provider = { collectionTarget: async args => { state.reads++; if (!state.allowed) throw Object.assign(new Error('SMART_PLUGIN_DISABLED'), { status: 403 }); if (args.generation !== state.target.generation) throw Object.assign(new Error('SMART_GENERATION_CHANGED'), { status: 409 }); return structuredClone(state.target); } };
  const broker = { selectSmartTarget: async (pluginId, target) => { if (!state.approved) throw new Error('SSH_APPROVAL_REQUIRED'); return { pluginId, commandId: 'daily-smart', hostId: target.hostId, deviceId: target.deviceId, digest: 'c'.repeat(64), approvalId: randomUUID() }; },
    runTarget: async (selection, who, { signal }) => { state.runs.push({ selection, who }); return options.run ? options.run(selection, signal) : { items: [{ result: 'success' }] }; } };
  const opts = { provider, broker, now: () => state.now, ...(options.capacity ? { capacity: options.capacity } : {}) };
  const collector = createSmartCollection(root, opts); t.after(() => collector.stop());
  return { root, opts, collector, state, query: args => ({ pluginId: args.pluginId, diskId: args.diskId, generation: args.generation, actor: args.actor }) };
}

test('submit is asynchronous and duplicate UUID requests reuse the durable operation without execution replay', async t => {
  let finish; const f = await fixture(t, { run: async () => new Promise(resolve => { finish = () => resolve({ items: [{ result: 'success' }] }); }) }), args = input();
  const admitted = await f.collector.submit(args); assert.equal(admitted.status, 'running'); assert.match(admitted.operationId, /^[a-f0-9-]{36}$/);
  assert.equal((await f.collector.submit(args)).operationId, admitted.operationId);
  while (!finish) await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state.runs.length, 1);
  const polling = await f.collector.get({ ...f.query(args), operationId: admitted.operationId }); assert.equal(polling.status, 'running');
  finish(); await f.collector.drain(); assert.equal((await f.collector.submit(args)).status, 'succeeded'); assert.equal(f.state.runs.length, 1);
  const bytes = await readFile(path.join(f.root, 'smart-collection/operations.json'), 'utf8'); assert.ok(!bytes.includes('EXAMPLE_NOT_REAL')); assert.ok(!bytes.includes('stdout')); assert.ok(!bytes.includes('device-example'));
});

test('zero permission or missing SSH approval causes no marker and no command execution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.collector.submit(input({ actor: { ...actor, admin: false } })), { status: 403 });
  f.state.approved = false; await assert.rejects(f.collector.submit(input()), { message: 'SSH_APPROVAL_REQUIRED', status: 403 });
  f.state.approved = true; f.state.allowed = false; await assert.rejects(f.collector.submit(input()), { message: 'SMART_PLUGIN_DISABLED', status: 403 });
  assert.equal(f.state.runs.length, 0);
  await assert.rejects(readFile(path.join(f.root, 'smart-collection/operations.json')), { code: 'ENOENT' });
});

test('request UUID cannot change scope; operation status stays isolated by actor and source with fresh access checks', async t => {
  const f = await fixture(t), args = input(), admitted = await f.collector.submit(args); await f.collector.drain();
  await assert.rejects(f.collector.submit({ ...args, diskId: 'another-disk' }), { message: 'SMART_COLLECTION_REQUEST_CONFLICT', status: 409 });
  for (const other of [{ ...actor, id: 'another-admin' }, { ...actor, source: 'tower' }]) await assert.rejects(f.collector.get({ ...f.query(args), actor: other, operationId: admitted.operationId }), { status: 404 });
  f.state.allowed = false; await assert.rejects(f.collector.get({ ...f.query(args), operationId: admitted.operationId }), { status: 403 });
  assert.ok(f.state.reads >= 5);
});

test('each disk has one running collection and the global running limit is two', async t => {
  const finishes = [], f = await fixture(t, { run: async () => new Promise(resolve => finishes.push(() => resolve({ items: [{ result: 'success' }] }))) });
  const first = input(), second = input({ diskId: 'second-disk' }); await f.collector.submit(first);
  await assert.rejects(f.collector.submit(input()), { message: 'SMART_COLLECTION_CONCURRENCY_LIMIT', status: 429 });
  await f.collector.submit(second); await assert.rejects(f.collector.submit(input({ diskId: 'third-disk' })), { status: 429 });
  while (finishes.length < 2) await new Promise(resolve => setImmediate(resolve)); finishes.forEach(finish => finish()); await f.collector.drain();
  assert.equal(f.state.runs.length, 2);
});

test('simultaneous requests and independent instances do not race the disk admission limit', async t => {
  let finish; const f = await fixture(t, { run: async () => new Promise(resolve => { finish = () => resolve({ items: [{ result: 'success' }] }); }) }), other = createSmartCollection(f.root, f.opts); t.after(() => other.stop());
  const values = await Promise.allSettled([f.collector.submit(input()), other.submit(input())]); assert.equal(values.filter(value => value.status === 'fulfilled').length, 1);
  while (!finish) await new Promise(resolve => setImmediate(resolve)); finish(); await Promise.all([f.collector.drain(), other.drain()]); assert.equal(f.state.runs.length, 1);
});

test('new collection UUIDs obey the persistent marker capacity and terminal request IDs cannot replay', async t => {
  const f = await fixture(t, { capacity: 1 }), args = input(); await f.collector.submit(args); await f.collector.drain();
  await assert.rejects(f.collector.submit(input()), { message: 'SMART_COLLECTION_CAPACITY_EXCEEDED', status: 503 }); assert.equal((await f.collector.submit(args)).status, 'succeeded'); assert.equal(f.state.runs.length, 1);
});

test('orphaned in-flight markers become unknown on restart and are never retried', async t => {
  const f = await fixture(t), args = input(), operation = await f.collector.submit(args); await f.collector.drain();
  const file = path.join(f.root, 'smart-collection/operations.json'), value = JSON.parse(await readFile(file)); const row = Object.values(value.items)[0]; row.status = 'running'; row.owner.process = randomUUID(); row.owner.pid = process.pid; await writeFile(file, JSON.stringify(value));
  const restarted = createSmartCollection(f.root, f.opts); t.after(() => restarted.stop()); const status = await restarted.get({ ...f.query(args), operationId: operation.operationId }); assert.equal(status.status, 'unknown'); assert.equal(status.code, 'SMART_COLLECTION_INTERRUPTED');
  assert.equal((await restarted.submit(args)).status, 'unknown'); assert.equal(f.state.runs.length, 1);
});

test('binding changes between admission and asynchronous run reject execution and expose only fixed failure metadata', async t => {
  const f = await fixture(t), original = f.opts.provider.collectionTarget; let calls = 0;
  f.opts.provider.collectionTarget = async args => { const target = await original(args); if (++calls > 1) target.bindingToken = 'd'.repeat(64); return target; };
  const args = input(), operation = await f.collector.submit(args); await f.collector.drain(); const status = await f.collector.get({ ...f.query(args), operationId: operation.operationId });
  assert.equal(status.status, 'failed'); assert.equal(status.code, 'SMART_BINDING_CHANGED'); assert.equal(f.state.runs.length, 0);
});

test('failed commands, malformed results and raw errors only return fixed codes', async t => {
  for (const run of [async () => ({ items: [{ result: 'failed', code: 'SSH_EXECUTION_TIMEOUT' }] }), async () => { throw new Error('EXAMPLE_REMOTE_SECRET'); }, async () => ({ stdout: 'EXAMPLE_REMOTE_SECRET' })]) {
    const f = await fixture(t, { run }), args = input(), operation = await f.collector.submit(args); await f.collector.drain();
    const status = await f.collector.get({ ...f.query(args), operationId: operation.operationId }); assert.equal(status.status, 'failed'); assert.ok(!JSON.stringify(status).includes('EXAMPLE_REMOTE_SECRET')); assert.equal(Object.keys(status).sort().join(), 'code,operationId,schemaVersion,status');
  }
});

test('stop aborts only its accepted work and persists unknown instead of replaying after restart', async t => {
  let started; const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { run: async (_, signal) => { started(); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ items: [{ result: 'failed', code: 'SSH_EXECUTION_CANCELLED' }] }), { once: true })); } });
  const args = input(), operation = await f.collector.submit(args); await entered; await f.collector.stop();
  const next = createSmartCollection(f.root, f.opts); t.after(() => next.stop()); const result = await next.get({ ...f.query(args), operationId: operation.operationId }); assert.equal(result.status, 'unknown'); assert.equal(f.state.runs.length, 1);
});

test('an overdue in-flight status becomes unknown and does not replay even if its original worker returns later', async t => {
  let finish; const f = await fixture(t, { run: async () => new Promise(resolve => { finish = () => resolve({ items: [{ result: 'success' }] }); }) }), args = input(), operation = await f.collector.submit(args);
  while (!finish) await new Promise(resolve => setImmediate(resolve)); f.state.now += 120001;
  assert.equal((await f.collector.get({ ...f.query(args), operationId: operation.operationId })).status, 'unknown'); assert.equal((await f.collector.submit(args)).status, 'unknown');
  finish(); await f.collector.drain(); assert.equal((await f.collector.get({ ...f.query(args), operationId: operation.operationId })).status, 'unknown'); assert.equal(f.state.runs.length, 1);
});

test('real local provider and broker pipeline collects exactly the selected disk after review and approval', async t => {
  let supported = true;
  const f = await fixture(t), id = 'rivetin-smart-example', commands = [], host = { hostId: 'profile-example', clusterId: 'cluster-example', address: '192.0.2.10', port: 22, username: 'collector', hostKeySha256: 'a'.repeat(64), password: 'EXAMPLE_NEVER_USED', devices: [
    { deviceId: 'device-a', path: '/dev/sda', serial: 'EXAMPLE_SERIAL_A' }, { deviceId: 'device-b', path: '/dev/sdb', serial: 'EXAMPLE_SERIAL_B' },
  ] };
  const vault = { list: async () => [structuredClone(host)], get: async () => structuredClone(host), revision: async () => 'a'.repeat(64) };
  const manifest = { permissions: ['inventory.read', 'disk.smart.read', 'ssh.channel.use'], ssh: { version: 1, commands: [{ id: 'daily-smart', operation: 'disk.smart.read', purpose: { 'zh-CN': '只读采集磁盘', 'en-US': 'Read disk SMART' }, hostScope: 'configured', deviceScope: 'configured', intervalSeconds: 86400 }] } };
  const status = { enabled: true, channelInstalled: true, channelEnabled: true, plugins: [{ id, installed: true, enabled: true, packageId: 'b'.repeat(64), manifest }] };
  const provider = createSmartProvider(f.root, { vault, pluginStatus: async () => ({ installed: true, active: true, manifest }), readDisk: async () => ({ id: 'selected-disk', hostId: 'tower-host', serial: 'EXAMPLE_SERIAL_B', path: '/dev/sdb', model: 'Example disk B' }) });
  await provider.bind({ diskId: 'selected-disk', profileHostId: host.hostId, deviceId: 'device-b', actor });
  const identity = await provider.resolveDisk({ pluginId: id, diskId: 'selected-disk', actor });
  const broker = createSshBroker(f.root, { vault, serviceStatus: async () => status, prepareResultContext: provider.prepareResultContext, onResult: provider.onResult,
    run: async ({ command }) => { commands.push(command); return { stdout: JSON.stringify({ serial_number: 'EXAMPLE_SERIAL_B', smartctl: { exit_status: 0 }, ...(supported ? { smart_status: { passed: true }, temperature: { current: 37 } } : { device: { protocol: 'ATA' } }) }), exitCode: 0 }; } });
  t.after(() => broker.stop()); const collector = createSmartCollection(f.root, { provider, broker }); t.after(() => collector.stop());
  const args = input({ pluginId: id, diskId: identity.diskId, generation: identity.generation });
  await assert.rejects(collector.submit(args), { message: 'SSH_APPROVAL_REQUIRED', status: 403 }); assert.equal(commands.length, 0);
  const review = await broker.review(id, actor); await broker.approve({ pluginId: id, challenge: review.challenge, digest: review.digest, acknowledged: true }, actor);
  const operation = await collector.submit(args); assert.equal(operation.status, 'running'); await collector.drain();
  assert.equal((await collector.get({ pluginId: id, diskId: identity.diskId, generation: identity.generation, operationId: operation.operationId, actor })).status, 'succeeded');
  assert.deepEqual(commands, ['sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sdb']);
  const latest = await provider.readLatest({ pluginId: id, diskId: identity.diskId, generation: identity.generation, actor }); assert.equal(latest.status, 'ok'); assert.equal(latest.smart.temperature.current, 37); assert.equal(latest.identity.path, ''); assert.equal(latest.smart.serial_number, undefined);
  supported = false; const unsupported = await collector.submit({ ...args, requestId: randomUUID() }); await collector.drain();
  const unsuccessful = await collector.get({ pluginId: id, diskId: identity.diskId, generation: identity.generation, operationId: unsupported.operationId, actor }); assert.equal(unsuccessful.status, 'failed'); assert.equal(unsuccessful.code, 'SMART_UNSUPPORTED');
  assert.equal((await provider.readLatest({ pluginId: id, diskId: identity.diskId, generation: identity.generation, actor })).collectedAt, latest.collectedAt);
});
