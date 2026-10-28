// Entirely synthetic SMART samples, never collected from a real environment.
const identity = { diskId: 'disk-demo-nvme', hostId: 'host-demo', deviceId: '1'.repeat(64), generation: '1'.repeat(64), path: '/dev/nvme0n1', model: 'Example NVMe SSD' };
const ata = { diskId: 'disk-demo-ata', hostId: 'host-demo', deviceId: '2'.repeat(64), generation: '2'.repeat(64), path: '/dev/sdb', model: 'Example SATA HDD' };
const unsupported = { diskId: 'disk-demo-virtual', hostId: 'host-demo', deviceId: '3'.repeat(64), generation: '3'.repeat(64), path: '/dev/sdc', model: 'Example Virtual Disk' };
const vmware = { diskId: 'disk-demo-vmware', hostId: 'host-demo', deviceId: '4'.repeat(64), generation: '4'.repeat(64), path: '/dev/nvme1n1', model: 'VMware Virtual NVMe Disk' };
const virtualDisk = { diskId: 'disk-demo-virtual-disk', hostId: 'host-demo', deviceId: '5'.repeat(64), generation: '5'.repeat(64), path: '/dev/sdd', model: 'Virtual_disk_example' };
export const disks = [identity, ata, unsupported, vmware, virtualDisk];
export const mockIdentity = disk => ({ ...disk, path: '' });
export function sample(disk, offset = 0, now = Date.now()) {
  const collectedAt = new Date(now - offset * 86400000).toISOString();
  if (disk.diskId === unsupported.diskId) return { schemaVersion: 1, source: 'mock', identity: mockIdentity(disk), status: 'unsupported', collectedAt, code: 'SMART_UNSUPPORTED' };
  const smart = disk.diskId === identity.diskId ? {
    smartctl: { exit_status: 0 }, smart_status: { passed: true }, temperature: { current: 43 },
    nvme_smart_health_information_log: { critical_warning: 0, available_spare: 100, available_spare_threshold: 10,
      percentage_used: 92 - offset, media_errors: offset === 0 ? 3 : 2, num_err_log_entries: 12, unsafe_shutdowns: 4, power_on_hours: 18000 - offset * 24,
      data_units_read: 4256789, data_units_written: 6789123 },
  } : {
    smartctl: { exit_status: 0 }, smart_status: { passed: true }, temperature: { current: 38 }, power_on_time: { hours: 24000 - offset * 24 }, device: { protocol: 'ATA' },
    ata_smart_attributes: { table: [
      { id: 5, name: 'Reallocated_Sector_Ct', value: 98, worst: 98, thresh: 10, raw: { value: offset === 0 ? 9 : 8 } },
      { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, raw: { value: 0 } },
      { id: 199, name: 'UDMA_CRC_Error_Count', value: 200, worst: 200, thresh: 0, raw: { value: 2 } },
      { id: 1, name: 'Raw_Read_Error_Rate', value: 88, worst: 81, thresh: 6, raw: { value: 125000000 } },
      { id: 241, name: 'Unknown_Vendor_Field', value: 100, worst: 100, thresh: 0, raw: { value: 4096 } },
    ] },
  };
  return { schemaVersion: 1, source: 'mock', status: 'ok', identity: mockIdentity(disk), collectedAt, smart };
}
export function createMockProvider({ now = Date.now(), state = () => 'ok' } = {}) {
  const operations = new Map(), collected = new Map();
  return {
    async readInventory({ diskId, signal }) { if (signal.aborted) throw new Error('ABORTED'); const disk = disks.find(item => item.diskId === diskId); return { schemaVersion: 1, disk: { diskId: disk.diskId, model: disk.model } }; },
    async resolveDisk({ diskId, signal }) { if (signal.aborted) throw new Error('ABORTED'); return mockIdentity(disks.find(disk => disk.diskId === diskId)); },
    async readLatest({ identity: disk, signal }) {
      if (signal.aborted) throw new Error('ABORTED');
      if (state() === 'error') throw new Error('SIMULATED_PROVIDER_ERROR');
      if (state() === 'failed') return { schemaVersion: 1, source: 'mock', identity: mockIdentity(disk), status: 'unavailable', collectedAt: new Date(now).toISOString(), code: 'SMART_COLLECTION_FAILED' };
      const value = sample(disk, 0, collected.get(disk.diskId) || now); if (state() === 'stale' && value.status === 'ok') value.collectedAt = new Date(now - 3 * 86400000).toISOString();
      if (state() === 'recovered' && value.status === 'ok') value.gapCode = 'SMART_EXECUTION_TIMEOUT'; return value;
    },
    async readHistory({ identity: disk, cursor, limit = 30, signal }) {
      if (signal.aborted) throw new Error('ABORTED');
      return { schemaVersion: 1, source: 'mock', identity: mockIdentity(disk), items: Array.from({ length: Math.min(limit, 65 - Number(cursor || 0)) }, (_, index) => { const offset = Number(cursor || 0) + index + 1; const value = sample(disk, offset + (state() === 'stale' ? 3 : 0), now); return offset === 2 ? { ...value, status: 'unavailable', smart: undefined, code: 'SMART_COLLECTION_FAILED' } : value; }), nextCursor: Number(cursor || 0) + limit < 65 ? String(Number(cursor || 0) + limit) : null };
    },
    async collect({ identity: disk, requestId, signal }) {
      if (signal.aborted) throw new Error('ABORTED');
      if (state() === 'collection-denied') throw Object.assign(new Error('SSH_APPROVAL_REQUIRED'), { code: 'SSH_APPROVAL_REQUIRED', status: 403 });
      if (!operations.has(requestId)) operations.set(requestId, { identity: { ...disk }, polls: 0 });
      return { schemaVersion: 1, operationId: requestId, status: 'running' };
    },
    async collection({ identity: disk, operationId, signal }) {
      if (signal.aborted) throw new Error('ABORTED');
      const operation = operations.get(operationId);
      if (!operation || operation.identity.diskId !== disk.diskId || operation.identity.generation !== disk.generation) throw Object.assign(new Error('SMART_GENERATION_CHANGED'), { code: 'SMART_GENERATION_CHANGED', status: 409 });
      const status = state() === 'collection-running' || ++operation.polls < 2 ? 'running' : state() === 'collection-failed' ? 'failed' : state() === 'collection-unknown' ? 'unknown' : 'succeeded';
      if (status === 'succeeded') collected.set(disk.diskId, Date.now());
      return { schemaVersion: 1, operationId, status, ...(status === 'failed' ? { code: 'SMART_COLLECTION_FAILED' } : {}) };
    },
  };
}
