import test from 'node:test';
import assert from 'node:assert/strict';
import { smartFixture, smartId, caller } from './data-fixture.js';

test('shared HTTP/client/provider reads never collect and enforce explicit SSH approval', async t => {
  const f = await smartFixture(t), identity = await f.provider.resolveDisk({ diskId: 'example-disk' });
  assert.equal(identity.path, ''); assert.equal(identity.deviceId, identity.generation);
  assert.equal((await f.provider.readLatest({ identity })).code, 'SMART_NO_SAMPLE');
  assert.deepEqual((await f.provider.readHistory({ identity })).items, []);
  assert.equal(f.runs(), 0);
  await assert.rejects(f.collect(), /SSH_APPROVAL_REQUIRED/);
  await f.approve(); assert.equal(f.runs(), 0);
  assert.equal((await f.collect()).items[0].result, 'success');
  const latest = await f.provider.readLatest({ identity }), history = await f.provider.readHistory({ identity });
  assert.equal(latest.status, 'ok'); assert.equal(history.items.length, 1); assert.equal(history.items[0].collectedAt, latest.collectedAt);
  assert.ok(!JSON.stringify(latest).includes('EXAMPLE_SERIAL')); assert.ok(!JSON.stringify(latest).includes('/dev/sda'));
  assert.ok(f.reads.every(read => read.actorId === caller.id && read.auth.Authorization === caller.auth.Authorization));
  assert.equal(f.runs(), 1);
});

test('caller denial, replacement and framework disable invalidate shared data reads', async t => {
  const f = await smartFixture(t), identity = await f.provider.resolveDisk({ diskId: 'example-disk' });
  f.deny(); await assert.rejects(f.provider.readHistory({ identity }), error => error.status === 403);
  f.deny(false); f.replaceSerial('EXAMPLE_REPLACEMENT_SERIAL');
  await assert.rejects(f.provider.readLatest({ identity }), error => error.code === 'SMART_GENERATION_CHANGED' && error.status === 409);
  await f.service.disable(caller);
  await assert.rejects(f.provider.readLatest({ identity }), error => error.status === 403);
  assert.equal(f.runs(), 0);
});

test('binding updates revoke collection approval and unbinding preserves inaccessible historical data', async t => {
  const f = await smartFixture(t), identity = await f.provider.resolveDisk({ diskId: 'example-disk' });
  await f.approve(); await f.collect();
  await f.service.smartBind({ diskId: 'example-disk', profileHostId: 'example-host', deviceId: 'example-device' }, caller);
  await assert.rejects(f.collect(), /SSH_APPROVAL_REQUIRED/);
  assert.equal((await f.provider.readLatest({ identity })).status, 'ok');
  await f.service.smartUnbind('example-disk', caller);
  await assert.rejects(f.provider.readLatest({ identity }), error => error.code === 'SMART_DISK_UNBOUND');
  assert.equal(f.runs(), 1);
  assert.ok((await f.service.logs()).items.some(item => item.action === 'smart.binding.remove'));
  assert.ok((await f.service.plugins()).find(item => item.id === smartId).active);
});
