import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { multiDiskService } from './fixtures/multi-disk-service.js';
import { collectAll } from '../src/batch-collection.js';
import { loadDiskData } from '../src/provider.js';

async function collect(f) {
  let posts = 0;
  const provider = { collectAll: args => { posts++; assert.deepEqual(Object.keys(args).sort(), ['requestId', 'signal']); return f.provider.collectAll(args); },
    collectionAll: async args => { await f.service.smartBatch.drain(); return f.provider.collectionAll(args); } };
  const result = await collectAll(provider, { requestId: randomUUID(), signal: new AbortController().signal, intervalMs: 10, timeoutMs: 10000 });
  assert.equal(posts, 1); return result;
}

test('all expands every authorized SATA and NVMe disk on each configured host, with same paths isolated by host', async t => {
  const f = await multiDiskService(t); await f.approve();
  const result = await collect(f);
  assert.equal(result.status, 'succeeded'); assert.equal(result.summary.total, 4); assert.equal(result.summary.succeeded, 4);
  assert.deepEqual(result.items.map(item => item.diskId).sort(), f.state.disks.map(disk => disk.id).sort());
  assert.equal(f.state.commands.length, 4);
  assert.deepEqual(f.state.commands.map(row => `${row.hostId}/${row.diskId}`).sort(), f.state.disks.map(disk => `${disk.host.id}/${disk.id}`).sort());
  assert.ok(f.state.commands.some(row => row.command.endsWith('/dev/sda')));
  assert.ok(f.state.commands.some(row => row.command.endsWith('/dev/nvme0n1')));
  for (const disk of f.state.disks) {
    const data = await loadDiskData(f.provider, disk.id, new AbortController().signal);
    assert.equal(data.latest.status, 'ok'); assert.equal(data.identity.hostId, disk.host.id); assert.equal(data.history.length, 1);
  }
});

test('custom excludes unselected disks and an empty host selection never expands to all', async t => {
  const f = await multiDiskService(t);
  await f.custom({ 'example-host-a': ['disk-a-sata', 'disk-a-nvme'], 'example-host-b': [] }); await f.approve();
  const result = await collect(f);
  assert.equal(result.status, 'succeeded'); assert.equal(result.summary.total, 2);
  assert.deepEqual(result.items.map(item => item.diskId).sort(), ['disk-a-nvme', 'disk-a-sata']);
  assert.ok(f.state.commands.every(row => row.hostId === 'example-host-a' && !row.command.endsWith('/dev/sdb')));
  assert.equal(f.state.commands.length, 2);
});

test('an inventory row from another host is rejected before any expanded command runs', async t => {
  const f = await multiDiskService(t); await f.approve(); f.state.foreignRow = true;
  const result = await collect(f);
  assert.notEqual(result.status, 'succeeded'); assert.equal(f.state.commands.length, 0);
});

test('all rejects a non-allowlisted path instead of executing a wildcard or silently omitting that disk', async t => {
  const f = await multiDiskService(t);
  f.state.disks[0].path = '/dev/sda; echo EXAMPLE_NOT_EXECUTABLE';
  const result = await collect(f);
  assert.notEqual(result.status, 'succeeded'); assert.equal(f.state.commands.length, 0);
});
