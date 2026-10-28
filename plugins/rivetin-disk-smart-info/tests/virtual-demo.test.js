import test from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualDemo, isVirtualDiskModel } from '../src/virtual-demo.js';
import { loadDiskData, readHistoryPage } from '../src/provider.js';
const signal = () => new AbortController().signal;

test('virtual model prefixes cover user examples without matching arbitrary text inside physical model names', () => {
  for (const value of ['VMware_Virtual_SATA_Hard_Drive', 'VMware Virtual NVMe Disk', 'Virtual_disk', 'Virtual_disk_example', 'vmware Virtual Disk', '  Virtual_disk']) assert.equal(isVirtualDiskModel(value), true);
  for (const value of ['', null, 'Physical VMware controller disk', 'Example Virtual_disk', 'Virtualization Physical Drive', 'Example SATA HDD']) assert.equal(isVirtualDiskModel(value), false);
});

test('virtual examples are local presentation objects without real generation, collection time or history', () => {
  for (const model of ['VMware Virtual NVMe Disk', 'VMware_Virtual_SATA_Hard_Drive', 'Virtual_disk']) {
    const value = createVirtualDemo({ diskId: 'example-disk', model }, Date.parse('2026-10-28T00:00:00Z'));
    assert.equal(value.virtualDemo, true); assert.equal(value.identity, undefined); assert.equal(value.latest, undefined); assert.equal(value.history, undefined);
    assert.equal(value.example.source, 'local-virtual-demo'); assert.equal(value.example.collectedAt, undefined); assert.ok(value.example.metrics.length > 0);
    assert.ok(value.example.metrics.every(metric => metric.delta === null && metric.deterioration === null));
    assert.equal(value.example.protocol, /NVMe/.test(model) ? 'NVMe' : 'ATA');
    if (/NVMe/.test(model)) assert.equal(value.example.metrics.find(metric => metric.id === 'percentage_used').reason, 'informational');
    assert.equal(JSON.stringify(value).includes('generation'), false);
  }
});

test('fresh inventory enables unbound virtual examples without binding, SSH reads or real history access', async () => {
  let inventoryReads = 0;
  const blocked = () => { throw new Error('REAL_DATA_MUST_NOT_BE_TOUCHED'); };
  const provider = { readInventory: async ({ diskId }) => { inventoryReads++; return { schemaVersion: 1, disk: { diskId, model: 'VMware_Virtual_SATA_Hard_Drive' } }; }, resolveDisk: blocked, readLatest: blocked, readHistory: blocked };
  const value = await loadDiskData(provider, 'example-disk', signal()); assert.equal(value.virtualDemo, true); assert.equal(inventoryReads, 1);
  await assert.rejects(readHistoryPage(provider, value, null, signal()), /VIRTUAL_DEMO_HAS_NO_HISTORY/);
});

test('inventory model changes, mismatched disk IDs and revoked reads cannot retain or fabricate a virtual example', async () => {
  const blocked = async () => { throw Object.assign(new Error('SMART_DISK_UNBOUND'), { code: 'SMART_DISK_UNBOUND' }); };
  const provider = { readInventory: async ({ diskId }) => ({ schemaVersion: 1, disk: { diskId, model: 'Example SATA HDD' } }), resolveDisk: blocked, readLatest: blocked, readHistory: blocked };
  await assert.rejects(loadDiskData(provider, 'example-disk', signal()), /SMART_DISK_UNBOUND/);
  provider.readInventory = async () => ({ schemaVersion: 1, disk: { diskId: 'wrong-disk', model: 'VMware Virtual Disk' } });
  await assert.rejects(loadDiskData(provider, 'example-disk', signal()), /DISK_IDENTITY_UNVERIFIED/);
  provider.readInventory = async () => { throw Object.assign(new Error('SMART_DISK_FORBIDDEN'), { status: 403 }); };
  await assert.rejects(loadDiskData(provider, 'example-disk', signal()), /SMART_DISK_FORBIDDEN/);
});
