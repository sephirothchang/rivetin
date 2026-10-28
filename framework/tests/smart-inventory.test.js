import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createSmartProvider } from '../server/smart-provider.js';
import { createDataProviders } from '../src/data-providers.js';
import { smartFixture, smartId, caller } from './data-fixture.js';

test('unbound inventory reads exact caller model without creating generation, bindings, history or SSH access', async t => {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'smart-inventory-'));
  t.after(async () => { if (!root.startsWith(base + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE'); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const reads = []; let enabled = true, denied = false, vaultReads = 0, fullReads = 0;
  const provider = createSmartProvider(root, {
    vault: { get: async () => { vaultReads++; throw new Error('UNEXPECTED_VAULT_ACCESS'); } },
    readDisk: async input => { fullReads++; return { id: input.diskId, model: 'VMware Virtual NVMe Disk' }; },
    readDiskInventory: async input => {
      reads.push(input); if (denied) throw Object.assign(new Error('EXAMPLE_PRIVATE_ERROR'), { status: 403 });
      return { id: input.diskId, model: 'VMware Virtual NVMe Disk' };
    },
    pluginStatus: async () => ({ installed: true, active: enabled, manifest: { permissions: ['inventory.read', 'disk.smart.read', 'ssh.channel.use'], ssh: { commands: [{ operation: 'disk.smart.read' }] } } }),
  });
  const actor = { ...caller, admin: false }, args = { pluginId: smartId, diskId: 'example-unbound-disk', actor };
  assert.deepEqual(await provider.readInventory(args), { schemaVersion: 1, disk: { diskId: args.diskId, model: 'VMware Virtual NVMe Disk' } });
  assert.equal(reads[0].actor, actor); assert.equal(vaultReads, 0); assert.deepEqual(await readdir(root), []);
  await provider.readInventory({ ...args, actor: { ...actor, id: 'example-other-user' } });
  assert.equal(reads.length, 2); assert.equal(reads[1].actor.id, 'example-other-user');
  denied = true; await assert.rejects(provider.readInventory(args), { message: 'SMART_DISK_FORBIDDEN', status: 403 });
  denied = false; enabled = false; await assert.rejects(provider.readInventory(args), { message: 'SMART_PLUGIN_DISABLED', status: 403 });
  assert.equal(reads.length, 3); assert.deepEqual(await readdir(root), []);
  assert.equal(fullReads, 0);
  await assert.rejects(provider.readInventory({ ...args, generation: 'a'.repeat(64) }), { message: 'SMART_DISK_REQUEST_INVALID', status: 400 });
  enabled = true;
  await assert.rejects(provider.resolveDisk(args), { message: 'SMART_DISK_RESPONSE_INVALID' });
  assert.equal(fullReads, 1); assert.equal(vaultReads, 0); assert.deepEqual(await readdir(root), []);
});

test('inventory bridge validates the exact requested disk and strips all private upstream fields', async () => {
  const calls = [], signal = new AbortController().signal;
  const bridge = createDataProviders(async (...args) => {
    calls.push(args); return { schemaVersion: 1, disk: { diskId: 'example-disk', model: 'Virtual_disk', serial: 'EXAMPLE_SERIAL', path: '/dev/sda' }, auth: 'EXAMPLE_TOKEN' };
  }, smartId).diskSmart;
  assert.deepEqual(await bridge.readInventory({ diskId: 'example-disk', signal }), { schemaVersion: 1, disk: { diskId: 'example-disk', model: 'Virtual_disk' } });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'GET'); assert.equal(calls[0][3].signal, signal);
  const params = new URL('https://tower.example.invalid' + calls[0][0]).searchParams;
  assert.deepEqual([...params.keys()].sort(), ['diskId', 'pluginId']);
  for (const model of [null, '', ' ', 'bad\nmodel', 'x'.repeat(513)]) {
    const invalid = createDataProviders(async () => ({ schemaVersion: 1, disk: { diskId: 'example-disk', model } }), smartId).diskSmart;
    await assert.rejects(invalid.readInventory({ diskId: 'example-disk' }), /SMART_INVENTORY_RESPONSE_INVALID/);
  }
  const wrong = createDataProviders(async () => ({ schemaVersion: 1, disk: { diskId: 'other-disk', model: 'Virtual_disk' } }), smartId).diskSmart;
  await assert.rejects(wrong.readInventory({ diskId: 'example-disk' }), /SMART_INVENTORY_RESPONSE_INVALID/);
  await assert.rejects(bridge.readInventory({ diskId: '../example-disk' }), /SMART_IDENTITY_INVALID/);
});

test('inventory HTTP/client works without a binding, while real sampling still requires one', async t => {
  const f = await smartFixture(t); await f.service.smartUnbind('example-disk', caller);
  assert.deepEqual(await f.provider.readInventory({ diskId: 'example-disk' }), { schemaVersion: 1, disk: { diskId: 'example-disk', model: 'Example disk' } });
  assert.equal(f.runs(), 0);
  await assert.rejects(f.provider.resolveDisk({ diskId: 'example-disk' }), error => error.status === 404 && error.code === 'SMART_DISK_UNBOUND');
  const route = f.url + '/api/rivetin/v1/data/disk-smart/inventory?pluginId=' + smartId + '&diskId=example-disk';
  assert.equal((await fetch(route)).status, 401);
  for (const suffix of ['&path=/dev/sdb', '&diskId=other-disk', '&generation=' + 'a'.repeat(64)]) {
    assert.equal((await fetch(route + suffix, { headers: { Authorization: caller.auth.Authorization } })).status, 400);
  }
  f.deny(); await assert.rejects(f.provider.readInventory({ diskId: 'example-disk' }), error => error.status === 403);
  assert.equal(f.runs(), 0);
});

test('inventory cancellation discards a late read without a second request', async () => {
  const controller = new AbortController(); let reads = 0;
  const bridge = createDataProviders(async () => { reads++; controller.abort(); return { schemaVersion: 1, disk: { diskId: 'example-disk', model: 'Virtual_disk' } }; }, smartId).diskSmart;
  await assert.rejects(bridge.readInventory({ diskId: 'example-disk', signal: controller.signal }), /REQUEST_CANCELLED/);
  await assert.rejects(bridge.readInventory({ diskId: 'example-disk', signal: controller.signal }), /REQUEST_CANCELLED/);
  assert.equal(reads, 1);
});
