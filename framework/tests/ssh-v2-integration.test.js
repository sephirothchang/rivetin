import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { connectionsFixture } from './ssh-v2-fixture.js';
import { caller, smartId } from './data-fixture.js';
import { createSshConnectionsStore } from '../src/ssh-connection-settings.js';
import { atomic } from '../server/storage.js';
import { createDeviceResolver, emptyPolicy } from '../server/ssh-device-policy.js';
const cli = { id: 'offline-operator', name: 'Offline operator', source: 'cli', admin: true };
const vaultPath = (f, name) => path.join(f.directory, 'ssh-channel/vault', name);

test('v2 HTTP CAS and durable actor-bound receipts never replay writes or revoke on conflicts', async t => {
  const f = await connectionsFixture(t); await f.approve();
  const payload = await f.request(), prior = await readFile(path.join(f.directory, 'ssh-channel/approvals.json'), 'utf8');
  await assert.rejects(f.client('/ssh-channel/connections', 'PUT', { ...payload, expectedRevision: 0 }), /SSH_CONNECTION_REVISION_CONFLICT/);
  assert.equal(await readFile(path.join(f.directory, 'ssh-channel/approvals.json'), 'utf8'), prior);
  const saved = await f.client('/ssh-channel/connections', 'PUT', payload); assert.equal(saved.replayed, false);
  await f.approve(); const reads = f.state.reads;
  const replay = await f.client('/ssh-channel/connections', 'PUT', payload); assert.equal(replay.replayed, true); assert.equal(replay.committedRevision, saved.committedRevision); assert.equal(f.state.reads, reads);
  await assert.rejects(f.service.sshSaveConnections(payload, { ...caller, id: 'other-admin' }), /SSH_CONNECTION_OPERATION_CONFLICT/);
  assert.equal((await f.service.sshChannel.status(caller)).registrations[0].approved, true);
  const newer = await f.request(); await f.service.sshSaveConnections(newer, caller);
  const historical = await f.service.sshSaveConnections(payload, caller); assert.equal(historical.committedRevision, saved.committedRevision); assert.ok(historical.connections.revision > saved.committedRevision);
  const ledger = await readFile(vaultPath(f, 'operations.v2.json'), 'utf8'); assert.ok(!ledger.includes('EXAMPLE_NOT_A_REAL_SSH_SECRET')); assert.ok(!ledger.includes(caller.auth.Authorization));
});

test('custom selection proofs are fresh, actor/host bound and empty custom resolves no targets', async t => {
  const f = await connectionsFixture(t), payload = await f.request();
  const inventory = await f.client('/ssh-channel/device-inventory?hostId=example-host&category=disk');
  assert.equal(inventory.complete, true); assert.ok(!JSON.stringify(inventory).includes('/dev/sda')); assert.ok(!JSON.stringify(inventory).includes('EXAMPLE_SERIAL'));
  payload.hosts[0].devicePolicy.classes.disk = { mode: 'custom', ids: ['example-disk'] };
  payload.selectionProofs = [{ hostId: 'example-host', category: 'disk', id: 'example-disk', selectionToken: inventory.items[0].selectionToken }];
  await assert.rejects(f.service.sshSaveConnections(payload, { ...caller, id: 'other-admin' }), /SSH_DEVICE_SELECTION_EXPIRED/);
  await f.client('/ssh-channel/connections', 'PUT', payload); await f.approve();
  f.state.disks[0].serial = 'EXAMPLE_REPLACEMENT';
  await assert.rejects(f.collect(), /SSH_DEVICE_IDENTITY_CHANGED/); assert.equal(f.runs(), 0);
  const empty = await f.request(); empty.hosts[0].devicePolicy.classes.disk.ids = [];
  await f.client('/ssh-channel/connections', 'PUT', empty);
  assert.deepEqual((await f.service.sshHosts.get('example-host', caller)).devices, []);
  await assert.rejects(f.approve(), /SSH_TARGET_UNAVAILABLE/);
  await assert.rejects(f.client('/ssh-channel/device-inventory?hostId=example-host&category=gpu'), /SSH_DEVICE_CLASS_UNSUPPORTED/);
});

test('all inventory changes invalidate approval; no background actor or daily schedule is fabricated', async t => {
  const f = await connectionsFixture(t); await f.approve();
  const capabilities = await f.client('/ssh-channel/policy-capabilities'); assert.equal(capabilities.execution.scheduled, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'ssh-channel/approvals.json'), 'utf8')).schedules[smartId], {});
  f.state.disks.push({ ...f.state.disks[0], id: 'example-disk-2', serial: 'EXAMPLE_SERIAL_2', path: '/dev/sdb' });
  await assert.rejects(f.collect(), /SSH_APPROVAL_REQUIRED/); assert.equal(f.runs(), 0);
  await assert.rejects(f.service.sshHosts.get('example-host'), /SSH_BACKGROUND_INVENTORY_AUTH_UNAVAILABLE/);
});

test('real shared HTTP response loss reconciles with GET without a second PUT', async t => {
  const f = await connectionsFixture(t); let writes = 0, dropReads = false;
  const store = createSshConnectionsStore({ crypto: webcrypto, client: async (...args) => { if (dropReads && args[1] !== 'PUT') throw new Error('NETWORK_UNAVAILABLE'); const result = await f.client(...args); if (args[1] === 'PUT') { writes++; dropReads = true; throw new Error('NETWORK_OUTCOME_UNKNOWN'); } return result; } });
  t.after(() => store.dispose()); await store.load(); store.update({ hosts: [] });
  assert.equal(await store.save(), false); assert.equal(writes, 1);
  dropReads = false; await store.load(); assert.equal(writes, 1); assert.equal(store.status().dirty, false); assert.equal(store.getDraft().hosts.length, 0);
});

test('legacy GET is read-only; explicit offline migration preserves empty/custom semantics and byte-exact rollback', async t => {
  const f = await connectionsFixture(t, { legacy: true }), original = await readFile(vaultPath(f, 'example-host.host.json'));
  const summary = await f.client('/ssh-channel/connections'); assert.equal(summary.version, 2); assert.equal(summary.migration.required, true); assert.deepEqual(summary.hosts[0].devicePolicy.classes.disk, { mode: 'custom', ids: [] });
  await assert.rejects(f.client('/ssh-channel/connections', 'PUT', await f.request()), /SSH_CONNECTION_MIGRATION_REQUIRED/);
  await f.service.disable(cli); const operationId = randomUUID();
  await f.service.sshMigrateConnections({ direction: 'upgrade', operationId, stopped: true }, cli);
  const migrated = await f.service.sshConnections(caller); assert.equal(migrated.migration.required, false); assert.equal(migrated.hosts[0].policyState.disk, 'unresolved');
  await assert.rejects(f.service.sshSaveHost({}, caller), /SSH_CONNECTION_VERSION_UNSUPPORTED/);
  await f.service.sshMigrateConnections({ direction: 'rollback', operationId, stopped: true }, cli);
  assert.deepEqual(await readFile(vaultPath(f, 'example-host.host.json')), original);
  assert.equal((await f.service.sshConnections(caller)).migration.required, true);
});

test('failed persistent revocation leaves barrier, unchanged ciphertext and no runnable approval', async t => {
  const f = await connectionsFixture(t), before = await readFile(vaultPath(f, 'connections.v2.json'));
  f.service.sshChannel.invalidate = async () => { throw new Error('EIO'); };
  await assert.rejects(f.service.sshSaveConnections(await f.request(), caller), /SSH_CONNECTION_REVOKE_FAILED/);
  assert.deepEqual(await readFile(vaultPath(f, 'connections.v2.json')), before);
  await assert.rejects(f.service.sshConnections(caller), /SSH_CONNECTION_OUTCOME_UNKNOWN/);
  await assert.rejects(f.collect(), /SSH_CONNECTION_OUTCOME_UNKNOWN/); assert.equal(f.runs(), 0);
});

test('v2 fresh automatic SMART binding preserves generation/history and writes no actor credentials', async t => {
  const f = await connectionsFixture(t);
  const identity = await f.service.smartData.resolveDisk({ pluginId: smartId, diskId: 'example-disk', actor: caller });
  assert.match(identity.generation, /^[a-f0-9]{64}$/); assert.equal(identity.deviceId, identity.generation); assert.equal(identity.path, '');
  await f.approve(); const result = await f.collect(); assert.equal(result.items[0].result, 'success');
  const latest = await f.service.smartData.readLatest({ pluginId: smartId, diskId: 'example-disk', generation: identity.generation, actor: caller }); assert.equal(latest.status, 'ok');
  f.state.disks[0].serial = 'EXAMPLE_REPLACEMENT';
  await assert.rejects(f.service.smartData.readLatest({ pluginId: smartId, diskId: 'example-disk', generation: identity.generation, actor: caller }), /SMART_GENERATION_CHANGED/);
  const next = await f.service.smartData.resolveDisk({ pluginId: smartId, diskId: 'example-disk', actor: caller }); assert.notEqual(next.generation, identity.generation);
  const bindings = await readFile(path.join(f.directory, 'smart-provider/bindings.json'), 'utf8'); assert.ok(!bindings.includes(caller.auth.Authorization));
});

test('explicit offline recovery aborts precommit failure without replay and reconciles a lost committed receipt', async t => {
  const f = await connectionsFixture(t), request = await f.request(), revoke = f.service.sshChannel.invalidate;
  f.service.sshChannel.invalidate = async () => { throw new Error('EIO'); };
  await assert.rejects(f.service.sshSaveConnections(request, caller), /SSH_CONNECTION_REVOKE_FAILED/);
  f.service.sshChannel.invalidate = revoke; await f.service.disable(cli);
  const aborted = await f.service.sshMigrateConnections({ direction: 'recover', operationId: request.operationId, stopped: true }, cli);
  assert.equal(aborted.committed, false);
  await assert.rejects(f.service.sshSaveConnections(request, caller), /SSH_CONNECTION_OUTCOME_UNKNOWN/);
  const next = await f.request(), saved = await f.service.sshSaveConnections(next, caller);
  const ledger = JSON.parse(await readFile(vaultPath(f, 'operations.v2.json'), 'utf8')), entry = ledger.items.find(row => row.id === next.operationId);
  entry.state = 'pending'; await atomic(vaultPath(f, 'operations.v2.json'), ledger);
  await atomic(vaultPath(f, 'mutation.v2.json'), { version: 2, operationId: entry.id, revision: entry.revision, digest: entry.digest });
  await unlink(vaultPath(f, 'connections.v1.json'));
  const recovered = await f.service.sshMigrateConnections({ direction: 'recover', operationId: next.operationId, stopped: true }, cli);
  assert.equal(recovered.revision, saved.committedRevision);
  const replay = await f.service.sshSaveConnections(next, caller); assert.equal(replay.replayed, true);
});

test('ordinary credential saves retain unresolved legacy references; edited v2 cannot silently downgrade', async t => {
  const f = await connectionsFixture(t, { legacy: true }); await f.service.disable(cli);
  const operationId = randomUUID(); await f.service.sshMigrateConnections({ direction: 'upgrade', operationId, stopped: true }, cli);
  await f.service.sshSaveConnections(await f.request(), caller);
  assert.equal((await f.service.sshConnections(caller)).hosts[0].policyState.unresolvedLegacyCount, 1);
  const ciphertext = await readFile(vaultPath(f, 'connections.v2.json'));
  await assert.rejects(f.service.sshMigrateConnections({ direction: 'rollback', operationId, stopped: true }, cli), /SSH_CONNECTION_DOWNGRADE_UNREPRESENTABLE/);
  assert.deepEqual(await readFile(vaultPath(f, 'connections.v2.json')), ciphertext);
});

test('selection proof expiry and inventory changes reject selection instead of following new identity', async () => {
  let clock = 1000;
  const disk = { id: 'example-disk', host: { id: 'example-host' }, serial: 'EXAMPLE_SERIAL', path: '/dev/sda', model: 'Example disk' };
  const host = { hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, hostKeySha256: 'a'.repeat(64), connection: null, devicePolicy: emptyPolicy() };
  const document = { revision: 1, global: null, clusters: [], hosts: [host], selectionIdentities: {} };
  const resolver = createDeviceResolver({ now: () => clock, key: async () => Buffer.alloc(32, 1), request: async route => route.endsWith('get-hosts') ? [{ id: host.hostId, cluster: { id: host.clusterId }, management_ip: host.address }] : [structuredClone(disk)] });
  const inventory = await resolver.inventory(host.hostId, 'disk', caller, document);
  const next = structuredClone(document); next.hosts[0].devicePolicy.classes.disk = { mode: 'custom', ids: [disk.id] };
  const proofs = [{ hostId: host.hostId, category: 'disk', id: disk.id, selectionToken: inventory.items[0].selectionToken }];
  assert.ok((await resolver.validate(next, document, proofs, caller))[host.hostId + '/' + disk.id]);
  clock += 60001; await assert.rejects(resolver.validate(next, document, proofs, caller), /SSH_DEVICE_SELECTION_EXPIRED/);
  clock = 1000; disk.serial = 'EXAMPLE_REPLACEMENT'; await assert.rejects(resolver.validate(next, document, proofs, caller), /SSH_DEVICE_SELECTION_EXPIRED/);
});

test('auth-only preflight credentials do not imply SMART identity or health readiness', async t => {
  const f = await connectionsFixture(t); delete f.state.disks[0].serial;
  const connection = await f.service.sshHosts.get('example-host', caller, { connectionOnly: true });
  assert.equal(connection.username, 'collector'); assert.deepEqual(connection.devices, []);
  await assert.rejects(f.service.sshHosts.get('example-host', caller), /SSH_DEVICE_IDENTITY_UNVERIFIED/);
  const inventory = await f.service.sshDeviceInventory('example-host', 'disk', caller);
  assert.equal(inventory.items[0].selectable, false); assert.equal(f.runs(), 0);
});

test('maximum-size inventory signs proofs without per-device key-file fanout', async () => {
  let keyReads = 0;
  const resolver = createDeviceResolver({ key: async () => { keyReads++; return Buffer.alloc(32, 1); }, request: async route => route.endsWith('get-hosts') ? [{ id: 'example-host', cluster: { id: 'example-cluster' }, management_ip: '192.0.2.10' }] : Array.from({ length: 1000 }, (_, index) => ({ id: 'disk-' + index, host: { id: 'example-host' }, serial: 'EXAMPLE_SERIAL_' + index, path: '/dev/nvme' + index + 'n1', model: 'Example disk' })) });
  const value = await resolver.inventory('example-host', 'disk', caller, { revision: 0, global: null, clusters: [], hosts: [] });
  assert.equal(value.items.length, 1000); assert.ok(value.items.every(row => row.selectable)); assert.ok(keyReads <= 2);
});

test('interrupted precommit format migration recovers the original encrypted v1 state with approvals still revoked', async t => {
  const f = await connectionsFixture(t, { legacy: true }); await f.service.disable(cli);
  const original = await readFile(vaultPath(f, 'example-host.host.json')), operationId = randomUUID(), revoke = f.service.sshChannel.invalidate;
  f.service.sshChannel.invalidate = async () => { throw new Error('EIO'); };
  await assert.rejects(f.service.sshMigrateConnections({ direction: 'upgrade', operationId, stopped: true }, cli), /SSH_CONNECTION_REVOKE_FAILED/);
  await assert.rejects(f.service.sshConnections(caller), /SSH_CONNECTION_OUTCOME_UNKNOWN/);
  f.service.sshChannel.invalidate = revoke;
  const result = await f.service.sshMigrateConnections({ direction: 'recover', operationId, stopped: true }, cli);
  assert.equal(result.committed, false); assert.deepEqual(await readFile(vaultPath(f, 'example-host.host.json')), original);
  assert.equal((await f.service.sshConnections(caller)).migration.required, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'ssh-channel/approvals.json'), 'utf8')).approvals, {});
});

test('the current service never creates background schedules even before a legacy vault is migrated', async t => {
  const f = await connectionsFixture(t, { legacy: true }); await f.approve(); await f.service.sshChannel.tick();
  const approvals = JSON.parse(await readFile(path.join(f.directory, 'ssh-channel/approvals.json'), 'utf8'));
  assert.deepEqual(approvals.schedules[smartId], {}); assert.equal(f.runs(), 0);
});
