import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClusters, normalizeSnapshot, snapshotIsStale, SNAPSHOT_LIMITS } from '../src/snapshot.js';
import { workspaceSnapshot } from './fixtures/workspace.js';
const now = Date.parse('2026-10-29T06:00:00Z'), normalized = () => normalizeSnapshot(workspaceSnapshot('cluster-fixture', now), 'cluster-fixture', now);

test('snapshot preserves unknowns and exact resource relationships without guessing speed/bond or absent VM counts', () => {
  const value = normalized();
  assert.equal(value.nics[0].speedMbps, null); assert.equal(value.nics[0].link, 'unknown'); assert.equal(value.nics[0].bondMode, null);
  assert.equal(value.vmGroups.length, 1); assert.equal(value.vmGroups[0].networkId, 'net-workload'); assert.equal(value.nics[0].hostId, 'host-fixture');
  assert.equal(snapshotIsStale(value, now + 59999), false); assert.equal(snapshotIsStale(value, now + 60000), true);
});
test('wrong cluster, source, future timestamp, duplicate identities and broken joins fail closed', () => {
  for (const mutate of [
    value => { value.cluster.id = 'another-cluster'; }, value => { value.source = 'demo'; },
    value => { value.revision = 'not-a-snapshot-hash'; },
    value => { value.observedAt = new Date(now + 5001).toISOString(); }, value => { value.hosts.push({ ...value.hosts[0] }); },
    value => { value.switches[2].networks.push({ ...value.switches[1].networks[0] }); },
    value => { value.nics[0].hostId = 'missing'; }, value => { value.nics[0].switchId = 'missing'; },
    value => { value.nics[0].peerId = 'missing'; }, value => { value.vmGroups[0].networkId = 'missing'; },
    value => { value.vmGroups.push({ ...value.vmGroups[0] }); }, value => { value.switches[1].networks[0].vlan = 4095; }
  ]) { const value = workspaceSnapshot('cluster-fixture', now); mutate(value); assert.throws(() => normalizeSnapshot(value, 'cluster-fixture', now), /TOPOLOGY_SNAPSHOT_INVALID/); }
});
test('missing LLDP stays empty, incomplete snapshots stay incomplete and collection bounds are enforced', () => {
  const value = workspaceSnapshot('cluster-fixture', now); value.complete = false; value.peers = []; value.nics[0].peerId = null;
  const result = normalizeSnapshot(value, 'cluster-fixture', now); assert.equal(result.complete, false); assert.deepEqual(result.peers, []);
  assert.deepEqual(normalizeClusters([]), []);
  assert.throws(() => normalizeClusters([{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }]), /INVALID/);
  assert.throws(() => normalizeClusters(Array.from({ length: SNAPSHOT_LIMITS.clusters + 1 }, (_, i) => ({ id: `c${i}`, name: `C${i}` }))), /INVALID/);
  value.hosts = Array.from({ length: SNAPSHOT_LIMITS.hosts + 1 }, (_, i) => ({ id: `h${i}`, name: `H${i}` }));
  assert.throws(() => normalizeSnapshot(value, 'cluster-fixture', now), /INVALID/);
});
