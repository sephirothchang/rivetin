import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createSmartProvider } from '../server/smart-provider.js';
import { createSmartHistory } from '../server/smart-history.js';

const pluginId = 'rivetin-smart-example', actor = { id: 'example-admin', source: 'tower', admin: true, auth: { Authorization: 'Bearer EXAMPLE_SYNTHETIC' } }, reader = { ...actor, id: 'example-reader', admin: false };
const profile = () => ({ hostId: 'ssh-profile', clusterId: 'cluster-example', address: '192.0.2.10', port: 22, username: 'collector', password: 'EXAMPLE_NOT_A_REAL_SECRET', hostKeySha256: 'a'.repeat(64), devices: [{ deviceId: 'disk-device', path: '/dev/sda', serial: 'EXAMPLE_SERIAL' }] });
const raw = () => ({ serial_number: 'EXAMPLE_SERIAL', model_name: 'EXAMPLE_MODEL', smartctl: { exit_status: 0 }, smart_status: { passed: true }, temperature: { current: 35 } });
async function fixture(t, extra = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'smart-provider-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const state = { profile: profile(), tower: { id: 'tower-disk', hostId: 'tower-host', serial: 'EXAMPLE_SERIAL', path: '/dev/sda', model: 'Example disk' }, active: true, installed: true, permitted: true, calls: [] };
  const options = { readDisk: async ({ diskId, actor: caller }) => { state.calls.push({ diskId, actor: caller }); if (!state.permitted) throw Object.assign(new Error('EXAMPLE_SENSITIVE_ERROR'), { status: 403 }); return structuredClone(state.tower); },
    vault: { get: async hostId => { if (hostId !== state.profile.hostId) throw new Error('SSH_HOST_UNAVAILABLE'); return structuredClone(state.profile); } },
    pluginStatus: async id => id === pluginId ? { installed: state.installed, active: state.active, manifest: { permissions: ['ssh.channel.use', 'inventory.read', 'disk.smart.read'], ssh: { commands: [{ operation: 'disk.smart.read' }] } } } : undefined,
    ...extra };
  const provider = createSmartProvider(root, options);
  const bind = () => provider.bind({ diskId: state.tower.id, profileHostId: state.profile.hostId, deviceId: state.profile.devices[0].deviceId, actor });
  const resolve = (caller = reader) => provider.resolveDisk({ pluginId, diskId: state.tower.id, actor: caller });
  const prepare = () => provider.prepareResultContext({ pluginId, operation: 'disk.smart.read', commandId: 'daily', hostId: state.profile.hostId, deviceId: state.profile.devices[0].deviceId, host: structuredClone(state.profile) });
  const item = (patch = {}) => ({ id: 'job-example', pluginId, operation: 'disk.smart.read', hostId: state.profile.hostId, deviceId: state.profile.devices[0].deviceId, result: 'success', exitCode: 0, stdout: JSON.stringify(raw()), finishedAt: new Date().toISOString(), ...patch });
  return { root, state, options, provider, bind, resolve, prepare, item };
}

test('unbound disks are not exposed as integrated; binding is admin-only and no-sample is explicit', async t => {
  const f = await fixture(t); await assert.rejects(f.resolve(), { message: 'SMART_DISK_UNBOUND', status: 404 });
  await assert.rejects(f.provider.bind({ diskId: f.state.tower.id, profileHostId: 'ssh-profile', deviceId: 'disk-device', actor: reader }), { message: 'ADMIN_REQUIRED', status: 403 });
  await f.bind(); const identity = await f.resolve(); assert.match(identity.generation, /^[a-f0-9]{64}$/); assert.equal(identity.deviceId, identity.generation); assert.equal(identity.path, '');
  const latest = await f.provider.readLatest({ pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader });
  assert.equal(latest.status, 'unavailable'); assert.equal(latest.code, 'SMART_NO_SAMPLE'); assert.equal(latest.collectedAt, null);
  assert.ok(!JSON.stringify(identity).includes('EXAMPLE_SERIAL')); assert.ok(!JSON.stringify(identity).includes('192.0.2.10'));
});

test('private collection target requires administrator and exact current binding generation', async t => {
  const f = await fixture(t); await f.bind(); const identity = await f.resolve(), args = { pluginId, diskId: identity.diskId, generation: identity.generation };
  await assert.rejects(f.provider.collectionTarget({ ...args, actor: reader }), { status: 403 });
  const target = await f.provider.collectionTarget({ ...args, actor }); assert.equal(target.profileHostId, 'ssh-profile'); assert.equal(target.deviceId, 'disk-device'); assert.match(target.bindingToken, /^[a-f0-9]{64}$/);
  await assert.rejects(f.provider.collectionTarget({ ...args, generation: 'b'.repeat(64), actor }), { message: 'SMART_GENERATION_CHANGED', status: 409 });
});

test('every read independently verifies exact caller disk permissions and plugin active capability', async t => {
  const f = await fixture(t); await f.bind(); const identity = await f.resolve(); const count = f.state.calls.length;
  await f.provider.readLatest({ pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader });
  await f.provider.readHistory({ pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader });
  assert.equal(f.state.calls.length, count + 2); assert.ok(f.state.calls.slice(-2).every(call => call.actor.id === reader.id && call.diskId === identity.diskId));
  f.state.permitted = false; await assert.rejects(f.resolve(), { message: 'SMART_DISK_FORBIDDEN', status: 403 });
  f.state.permitted = true; f.state.active = false; await assert.rejects(f.resolve(), { message: 'SMART_PLUGIN_DISABLED', status: 403 });
  f.state.active = true; f.state.installed = false; await assert.rejects(f.resolve(), { message: 'SMART_PLUGIN_DISABLED', status: 403 });
  await assert.rejects(f.provider.resolveDisk({ pluginId: 'rivetin-other', diskId: identity.diskId, actor: reader }), { status: 403 });
});

test('binding uses exact trusted serial/path, refuses ambiguous targets and publishes redacted summaries', async t => {
  const f = await fixture(t); f.state.profile.devices[0].serial = 'OTHER_SERIAL'; await assert.rejects(f.bind(), { message: 'SMART_BINDING_IDENTITY_MISMATCH', status: 409 });
  f.state.profile.devices[0].serial = 'EXAMPLE_SERIAL'; f.state.profile.devices[0].path = '/dev/sdb'; await assert.rejects(f.bind(), { message: 'SMART_BINDING_IDENTITY_MISMATCH', status: 409 });
  f.state.profile.devices[0].path = '/dev/sda'; await f.bind(); f.state.tower.id = 'second-tower-disk'; await assert.rejects(f.bind(), { message: 'SMART_BINDING_AMBIGUOUS', status: 409 });
  await assert.rejects(f.provider.bindings(reader), { status: 403 }); const list = await f.provider.bindings(actor);
  const json = JSON.stringify(list); for (const forbidden of ['EXAMPLE_SERIAL', '/dev/sda', '192.0.2.10', 'EXAMPLE_NOT_A_REAL_SECRET', 'bindingToken', 'targetToken']) assert.ok(!json.includes(forbidden));
});

test('physical replacement changes generation, path changes invalidate binding and old generations are never substituted', async t => {
  const f = await fixture(t); await f.bind(); const before = await f.resolve();
  f.state.tower.serial = 'NEW_SERIAL'; await assert.rejects(f.resolve(), { message: 'SMART_GENERATION_CHANGED', status: 409 });
  f.state.profile.devices[0].serial = 'NEW_SERIAL'; await f.bind(); const next = await f.resolve(); assert.notEqual(next.generation, before.generation);
  await assert.rejects(f.provider.readLatest({ pluginId, diskId: before.diskId, generation: before.generation, actor: reader }), { message: 'SMART_GENERATION_CHANGED', status: 409 });
  f.state.tower.path = '/dev/sdb'; await assert.rejects(f.resolve(), { message: 'SMART_BINDING_CHANGED', status: 409 });
});

test('generation and bindings survive restart, and missing secret key over existing state fails closed', async t => {
  const f = await fixture(t); await f.bind(); const before = await f.resolve(); const restarted = createSmartProvider(f.root, f.options);
  assert.deepEqual(await restarted.resolveDisk({ pluginId, diskId: before.diskId, actor: reader }), before);
  const bytes = await readFile(path.join(f.root, 'smart-provider/bindings.json'), 'utf8');
  for (const value of ['EXAMPLE_SERIAL', '/dev/sda', '192.0.2.10', 'EXAMPLE_SYNTHETIC', 'EXAMPLE_NOT_A_REAL_SECRET']) assert.ok(!bytes.includes(value));
  await rm(path.join(f.root, 'smart-provider/key.json')); await assert.rejects(f.resolve(), { message: 'SMART_GENERATION_KEY_MISSING', status: 503 });
});

test('collection hooks sanitize successful output, preserve timestamp and never persist raw output or credentials', async t => {
  const f = await fixture(t); await f.bind(); const context = await f.prepare(), item = f.item(); let checked = 0;
  await f.provider.onResult(item, context, { assertActive: async () => { checked++; } }); assert.equal(checked, 1);
  const identity = await f.resolve(), result = await f.provider.readLatest({ pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader });
  assert.equal(result.status, 'ok'); assert.equal(result.collectedAt, item.finishedAt); assert.equal(result.smart.temperature.current, 35);
  assert.equal(result.smart.serial_number, undefined); assert.equal(result.smart.model_name, undefined);
  const page = await f.provider.readHistory({ pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader }); assert.equal(page.items.length, 1); assert.equal(page.source, 'host-smartctl');
  await f.provider.unbind({ diskId: identity.diskId, actor }); await assert.rejects(f.resolve(), { message: 'SMART_DISK_UNBOUND' });
  await f.bind(); assert.equal((await f.provider.readLatest({ pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader })).status, 'ok');
});

test('context-less, unrelated operations and ambiguous targets do not write history', async t => {
  const f = await fixture(t); assert.equal(await f.provider.prepareResultContext({ pluginId, operation: 'host.identity' }), undefined);
  await f.bind(); assert.equal(await f.provider.prepareResultContext({ pluginId, operation: 'disk.smart.read', hostId: 'another-host', deviceId: 'disk-device' }), undefined);
  assert.deepEqual(await f.provider.onResult(f.item(), undefined, {}), { recorded: false });
  const identity = await f.resolve(); assert.equal((await f.provider.readLatest({ pluginId, diskId: identity.diskId, generation: identity.generation, actor })).code, 'SMART_NO_SAMPLE');
});

test('rebind, vault target change, plugin disable or revoked guard cannot commit an in-flight sample', async t => {
  for (const kind of ['rebind', 'vault', 'plugin', 'guard', 'cancel']) {
    const f = await fixture(t); await f.bind(); const context = await f.prepare(), controller = new AbortController();
    if (kind === 'rebind') await f.bind(); if (kind === 'vault') f.state.profile.devices[0].path = '/dev/sdb'; if (kind === 'plugin') f.state.active = false; if (kind === 'cancel') controller.abort();
    await assert.rejects(f.provider.onResult(f.item(), context, { signal: controller.signal, assertActive: async () => { if (kind === 'guard') throw new Error('SSH_APPROVAL_REVOKED'); } }));
    const history = createSmartHistory(f.root); assert.equal((await history.latest({ pluginId, diskId: context.diskId, hostId: context.hostId, generation: context.generation })).record, null);
  }
});

test('failed results and invalid/mismatched outputs persist only fixed failure code and original collection time', async t => {
  for (const [patch, expected] of [[{ result: 'failed', code: 'SSH_EXECUTION_TIMEOUT', stdout: undefined }, 'SMART_EXECUTION_TIMEOUT'], [{ result: 'failed', code: 'EXAMPLE_REMOTE_SECRET', stdout: undefined }, 'SMART_COLLECTION_FAILED'], [{ stdout: '{' }, 'SMART_OUTPUT_INVALID'], [{ stdout: JSON.stringify({ ...raw(), serial_number: 'OTHER_SERIAL' }) }, 'SMART_IDENTITY_MISMATCH'], [{ stdout: JSON.stringify({ serial_number: 'EXAMPLE_SERIAL', device: { protocol: 'ATA' } }) }, 'SMART_UNSUPPORTED']]) {
    const f = await fixture(t); await f.bind(); const context = await f.prepare(), item = f.item(patch); await f.provider.onResult(item, context, { assertActive: async () => {} });
    const identity = await f.resolve(), value = await f.provider.readLatest({ pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader });
    assert.equal(value.code, expected); assert.equal(value.collectedAt, item.finishedAt); assert.equal(value.smart, undefined); assert.ok(!JSON.stringify(value).includes('EXAMPLE_REMOTE_SECRET'));
  }
});

test('history cursors cannot cross identities and invalid limits have stable HTTP-facing statuses', async t => {
  const f = await fixture(t); await f.bind(); const identity = await f.resolve(), history = createSmartHistory(f.root);
  for (const day of [1, 2]) await history.append({ pluginId, diskId: identity.diskId, hostId: identity.hostId, generation: identity.generation, operation: 'disk.smart.read', operationId: `old_${day}`, collectedAt: new Date(Date.now() - day * 86400000).toISOString(), status: 'ok', smart: { smart_status: { passed: true } } });
  const args = { pluginId, diskId: identity.diskId, generation: identity.generation, actor: reader };
  const page = await f.provider.readHistory({ ...args, limit: 1 }); assert.ok(page.nextCursor);
  await assert.rejects(f.provider.readHistory({ ...args, cursor: page.nextCursor + 'x' }), { status: 400 });
  await assert.rejects(f.provider.readHistory({ ...args, limit: 31 }), { status: 400 });
  await assert.rejects(f.provider.readHistory({ ...args, generation: 'b'.repeat(64), cursor: page.nextCursor }), { status: 409 });
});

test('read cancellation is bounded and unrelated transport errors never expose their raw message', async t => {
  const f = await fixture(t, { readDisk: async () => new Promise(() => {}) }), controller = new AbortController();
  const pending = f.provider.resolveDisk({ pluginId, diskId: 'tower-disk', actor: reader, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { message: 'SMART_EXECUTION_CANCELLED', status: 409 });
  const other = createSmartProvider(f.root, { ...f.options, readDisk: async () => { throw new Error('EXAMPLE_REMOTE_SECRET'); } });
  await assert.rejects(other.resolveDisk({ pluginId, diskId: 'tower-disk', actor: reader }), { message: 'SMART_DISK_READ_FAILED', status: 503 });
  const expired = createSmartProvider(f.root, { ...f.options, readDisk: async () => { throw Object.assign(new Error('EXAMPLE_REMOTE_SECRET'), { status: 401 }); } });
  await assert.rejects(expired.resolveDisk({ pluginId, diskId: 'tower-disk', actor: reader }), { message: 'AUTHENTICATION_REQUIRED', status: 401 });
});

test('all three declared capabilities and the structured SMART operation are mandatory', async t => {
  const f = await fixture(t);
  for (const missing of ['inventory.read', 'disk.smart.read', 'ssh.channel.use', 'operation']) {
    const provider = createSmartProvider(f.root, { ...f.options, pluginStatus: async () => ({ installed: true, active: true, manifest: {
      permissions: ['inventory.read', 'disk.smart.read', 'ssh.channel.use'].filter(permission => permission !== missing), ssh: { commands: missing === 'operation' ? [{ operation: 'host.identity' }] : [{ operation: 'disk.smart.read' }] },
    } }) });
    await assert.rejects(provider.resolveDisk({ pluginId, diskId: 'tower-disk', actor: reader }), { message: 'SMART_PLUGIN_DISABLED', status: 403 });
  }
});

test('read timeout is bounded and expired authentication never falls back to stored data', async t => {
  const f = await fixture(t, { readDisk: async () => new Promise(() => {}) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.provider.resolveDisk({ pluginId, diskId: 'tower-disk', actor: reader });
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(8000);
  await assert.rejects(pending, { message: 'SMART_DISK_READ_TIMEOUT', status: 503 });
});

test('tampered binding metadata is rejected rather than assigning samples to a different Tower host', async t => {
  const f = await fixture(t); await f.bind(); const file = path.join(f.root, 'smart-provider/bindings.json'), data = JSON.parse(await readFile(file));
  Object.values(data.items)[0].hostId = 'tampered-host'; await writeFile(file, JSON.stringify(data));
  await assert.rejects(f.resolve(), { message: 'SMART_PROVIDER_CORRUPT', status: 503 });
  await assert.rejects(f.prepare(), { message: 'SMART_PROVIDER_CORRUPT', status: 503 });
});
