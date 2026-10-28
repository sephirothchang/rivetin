import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectionsFixture } from '../../../framework/tests/ssh-v2-fixture.js';
import { smartId } from '../../../framework/tests/data-fixture.js';
import { createDataProviders } from '../../../framework/src/data-providers.js';
import { createSmartHistory } from '../../../framework/server/smart-history.js';
import { loadDiskData, errorCode } from '../src/provider.js';
import { collectDisk } from '../src/collection.js';
import { collectAll } from '../src/batch-collection.js';

// The shared fixture runs the actual v2 HTTP/service/vault/provider/broker.
// Tower inventory and SSH output are synthetic; no host or credential is used.
const signal = () => new AbortController().signal;
const options = extra => ({ requestId: randomUUID(), signal: signal(), intervalMs: 10, timeoutMs: 5000, ...extra });
async function setup(t) {
  const f = await connectionsFixture(t);
  return { ...f, provider: createDataProviders(f.client, smartId).diskSmart };
}

test('v2 all auto-association is consumed through HTTP and replacement histories stay separate', async t => {
  const f = await setup(t);
  const before = await loadDiskData(f.provider, 'example-disk', signal());
  assert.match(before.identity.generation, /^[a-f0-9]{64}$/);
  assert.equal(before.identity.deviceId, before.identity.generation); assert.equal(before.identity.path, '');
  assert.equal(before.latest.code, 'SMART_NO_SAMPLE'); assert.deepEqual(before.history, []); assert.equal(f.runs(), 0);
  await f.approve();
  const result = await collectDisk(f.provider, options({ identity: before.identity }));
  assert.equal(result.status, 'succeeded'); assert.equal(f.runs(), 1);
  const sampled = await loadDiskData(f.provider, 'example-disk', signal());
  assert.equal(sampled.latest.status, 'ok'); assert.equal(sampled.history.length, 1); assert.equal(sampled.previous, null);
  f.state.disks[0].serial = 'EXAMPLE_REPLACEMENT';
  await assert.rejects(f.provider.readLatest({ identity: sampled.identity, signal: signal() }), { code: 'SMART_GENERATION_CHANGED' });
  const replaced = await loadDiskData(f.provider, 'example-disk', signal());
  assert.notEqual(replaced.identity.generation, sampled.identity.generation);
  assert.equal(replaced.latest.code, 'SMART_NO_SAMPLE'); assert.deepEqual(replaced.history, []); assert.equal(replaced.previous, null);
  const old = await createSmartHistory(f.directory).latest({ pluginId: smartId, diskId: sampled.identity.diskId,
    hostId: sampled.identity.hostId, generation: sampled.identity.generation });
  assert.equal(old.record.status, 'ok');
  const staleApproval = await collectDisk(f.provider, options({ identity: replaced.identity }));
  assert.equal(staleApproval.status, 'failed'); assert.equal(staleApproval.code, 'SSH_APPROVAL_REQUIRED'); assert.equal(f.runs(), 1);
  await f.approve();
  assert.equal((await collectDisk(f.provider, options({ identity: replaced.identity }))).status, 'succeeded');
  const renewed = await loadDiskData(f.provider, 'example-disk', signal());
  assert.equal(renewed.history.length, 1); assert.equal(renewed.previous, null);
  assert.equal((await f.client('/ssh-channel/policy-capabilities')).execution.scheduled, false);
  await f.service.sshChannel.tick(); assert.equal(f.runs(), 2);
});

test('v2 custom empty has no batch targets and cannot use an earlier automatic association', async t => {
  const f = await setup(t);
  await loadDiskData(f.provider, 'example-disk', signal());
  const request = await f.request(); request.hosts[0].devicePolicy.classes.disk = { mode: 'custom', ids: [] };
  await f.client('/ssh-channel/connections', 'PUT', request);
  const result = await collectAll(f.provider, options());
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'SMART_BATCH_NO_TARGETS'); assert.equal(result.operationId, null);
  await assert.rejects(loadDiskData(f.provider, 'example-disk', signal()), { code: 'SMART_DEVICE_UNAVAILABLE' });
  assert.equal(f.runs(), 0);
});

test('v2 custom selection cannot absorb a replacement disk through a consumer read', async t => {
  const f = await setup(t), request = await f.request();
  const inventory = await f.client('/ssh-channel/device-inventory?hostId=example-host&category=disk');
  request.hosts[0].devicePolicy.classes.disk = { mode: 'custom', ids: ['example-disk'] };
  request.selectionProofs = [{ hostId: 'example-host', category: 'disk', id: 'example-disk', selectionToken: inventory.items[0].selectionToken }];
  await f.client('/ssh-channel/connections', 'PUT', request);
  const before = await loadDiskData(f.provider, 'example-disk', signal()); await f.approve();
  f.state.disks[0].serial = 'EXAMPLE_REPLACEMENT';
  await assert.rejects(loadDiskData(f.provider, 'example-disk', signal()), { code: 'SMART_PROFILE_UNAVAILABLE' });
  await assert.rejects(collectDisk(f.provider, options({ identity: before.identity })), { code: 'SMART_GENERATION_CHANGED' });
  assert.equal(f.runs(), 0);
});

test('v2 all scope changes revoke collection approval and disk read revocation remains explicit', async t => {
  const f = await setup(t), before = await loadDiskData(f.provider, 'example-disk', signal());
  await f.approve();
  f.state.disks.push({ ...f.state.disks[0], id: 'example-disk-2', serial: 'EXAMPLE_SECOND_SERIAL', path: '/dev/sdb' });
  const result = await collectDisk(f.provider, options({ identity: before.identity }));
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'SSH_APPROVAL_REQUIRED'); assert.equal(f.runs(), 0);
  f.state.denied = true;
  await assert.rejects(loadDiskData(f.provider, 'example-disk', signal()), error => error.code === 'SMART_DISK_FORBIDDEN' && errorCode(error) === 'SMART_DISK_FORBIDDEN');
  assert.equal(f.runs(), 0);
});
