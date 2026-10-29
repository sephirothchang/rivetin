import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopologySource } from '../src/provider-adapter.js';
import { workspaceSnapshot } from './fixtures/workspace.js';
const time = Date.parse('2026-10-29T08:00:00Z');
const envelope = () => ({ schemaVersion: 1, source: 'cloudtower', observedAt: new Date(time).toISOString(), complete: true, clusters: [{ id: 'cluster-fixture', name: 'Fixture' }] });

test('adapter unwraps the authoritative cluster envelope and forwards exact cluster ID and AbortSignal', async () => {
  const signal = new AbortController().signal, calls = [];
  const source = createTopologySource({ async listClusters(args) { calls.push(args); return envelope(); }, async read(args) { calls.push(args); return workspaceSnapshot(args.clusterId, time); } }, () => time);
  assert.deepEqual(await source.listClusters({ signal }), [{ id: 'cluster-fixture', name: 'Fixture' }]);
  const result = await source.read({ clusterId: 'cluster-fixture', signal }); assert.equal(result.cluster.id, 'cluster-fixture');
  assert.equal(calls[0].signal, signal); assert.equal(calls[1].signal, signal); assert.equal(calls[1].clusterId, 'cluster-fixture');
});
test('adapter rejects legacy array fallback, incomplete/untrusted/stale cluster lists and wrong snapshot cluster', async () => {
  for (const value of [[], { ...envelope(), source: 'demo' }, { ...envelope(), complete: false }, { ...envelope(), observedAt: new Date(time - 60000).toISOString() }, { ...envelope(), observedAt: '2026-10-29' }]) {
    const source = createTopologySource({ async listClusters() { return value; }, async read() {} }, () => time);
    await assert.rejects(source.listClusters({}), /TOPOLOGY_CLUSTERS_INVALID/);
  }
  const source = createTopologySource({ async listClusters() { return envelope(); }, async read() { return workspaceSnapshot('other-cluster', time); } }, () => time);
  await assert.rejects(source.read({ clusterId: 'cluster-fixture' }), /SNAPSHOT_INVALID/);
  await assert.rejects(createTopologySource(null).listClusters({}), /SOURCE_UNAVAILABLE/);
});
