import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { smartFixture, caller } from './data-fixture.js';

test('manual collection through HTTP/client requires review and collects only the selected disk once', async t => {
  const f = await smartFixture(t, { twoDevices: true });
  const identity = await f.provider.resolveDisk({ diskId: 'example-disk' }), requestId = randomUUID();
  await assert.rejects(f.provider.collect({ identity, requestId }), /SSH_APPROVAL_REQUIRED/);
  assert.equal(f.runs(), 0);
  await f.approve();
  const started = await f.provider.collect({ identity, requestId });
  assert.equal(started.schemaVersion, 1); assert.equal(started.status, 'running');
  await f.service.smartCollection.drain();
  const completed = await f.provider.collection({ identity, operationId: started.operationId });
  assert.equal(completed.status, 'succeeded');
  assert.equal(f.runs(), 1); assert.equal(f.commands.length, 1); assert.ok(f.commands[0].endsWith('/dev/sda'));
  assert.equal((await f.provider.readLatest({ identity })).status, 'ok');
  const other = await f.provider.resolveDisk({ diskId: 'example-disk-second' });
  assert.equal((await f.provider.readLatest({ identity: other })).code, 'SMART_NO_SAMPLE');
  assert.deepEqual(await f.provider.collect({ identity, requestId }), completed);
  assert.equal(f.runs(), 1);
  f.deny(); await assert.rejects(f.provider.collection({ identity, operationId: started.operationId }), error => error.status === 403);
});

test('manual collection endpoint rejects unknown fields, unauthenticated and foreign origin requests without execution', async t => {
  const f = await smartFixture(t), identity = await f.provider.resolveDisk({ diskId: 'example-disk' });
  const payload = { pluginId: 'rivetin-smart-example', diskId: identity.diskId, generation: identity.generation, requestId: randomUUID() };
  const request = (extra, headers) => fetch(f.url + '/api/rivetin/v1/data/disk-smart/collect', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...payload, ...extra }) });
  assert.equal((await request({}, {})).status, 401);
  assert.equal((await request({}, { Authorization: caller.auth.Authorization, Origin: 'https://untrusted.example.invalid' })).status, 403);
  assert.equal((await request({ devicePath: '/dev/sdb' }, { Authorization: caller.auth.Authorization, Origin: 'https://tower.example.invalid' })).status, 400);
  assert.equal(f.runs(), 0);
});
