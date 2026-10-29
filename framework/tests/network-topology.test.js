import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkTopology } from '../server/network-topology.js';
import { createDataProviders } from '../src/data-providers.js';
import { validateTopologySnapshot } from '../shared/network-topology.js';
import { createTowerConnection } from '../server/tower.js';

const actor = { id: 'example-root', source: 'tower', role: 'ROOT', admin: true, auth: { Authorization: 'EXAMPLE_NOT_A_REAL_TOKEN' } };
const pluginId = 'rivetin-network-topology';
const input = { pluginId, actor, clusterId: 'second-cluster' };
const status = () => ({ frameworkEnabled: true, installed: true, enabled: true, compatible: true, manifest: { permissions: ['inventory.read'], compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.5' } } });
function fixture(overrides = {}) {
  const cluster = { id: input.clusterId, name: 'Second cluster' };
  const source = { 'get-clusters': [cluster], 'get-hosts': [{ id: 'host-2', name: 'Host two', cluster, management_ip: '192.0.2.10' }],
    'get-vdses': [{ id: 'switch-2', name: 'Workload', cluster, type: 'VM', internal: false, vlans_num: 1, nics: [{ id: 'nic-2' }] }],
    'get-vlans': [{ id: 'network-2', name: 'Network two', type: 'VM', vlan_id: 100, vds: { id: 'switch-2' } }],
    'get-nics': [{ id: 'nic-2', name: 'Physical port', host: { id: 'host-2' }, physical: true, vds: { id: 'switch-2' }, speed: 10000, running: true, mac_address: '00:00:5e:00:53:01' },
      { id: 'virtual-2', name: 'Internal virtual port', host: { id: 'host-2' }, physical: false, vds: null }] };
  const calls = [];
  const provider = createNetworkTopology({ towerBuildProvider: async () => '4.9.0', pluginStatus: async () => status(), request: async (path, body, auth, options) => {
    calls.push({ path, body, options }); const rows = source[path.split('/').at(-1)]; return structuredClone(rows.slice(body.skip, body.skip + body.first));
  }, ...overrides });
  return { source, calls, provider };
}

test('topology rejects wrong plugin, caller, old minimum and missing permission before resource queries', async () => {
  const f = fixture();
  for (const patch of [{ pluginId: 'rivetin-another' }, { actor: { ...actor, source: 'demo' } }, { actor: { ...actor, admin: false } }, { actor: { ...actor, auth: {} } }]) await assert.rejects(f.provider.read({ ...input, ...patch }), /TOPOLOGY_PERMISSION_REQUIRED/);
  for (const patch of [{ enabled: false }, { compatible: false }, { installed: 'true' }, { enabled: 1 }, { frameworkEnabled: 'true' }, { manifest: { permissions: [] } }, { manifest: { permissions: ['inventory.read'], compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.4' } } }]) {
    const g = fixture({ pluginStatus: async () => ({ ...status(), ...patch }) }); await assert.rejects(g.provider.read(input), /TOPOLOGY_PLUGIN_UNAVAILABLE/); assert.equal(g.calls.length, 0);
  }
  const unsupported = fixture({ towerBuildProvider: async () => '4.8.0' }); await assert.rejects(unsupported.provider.read(input), /TOPOLOGY_TOWER_UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});

test('complete topology is normalized to exact cluster and excludes native secrets, addresses, virtual NICs and guessed facts', async () => {
  const f = fixture(), result = await f.provider.read(input);
  assert.equal(result.complete, true); assert.equal(result.cluster.id, input.clusterId); assert.equal(result.nics.length, 1);
  assert.equal(result.switches[0].purpose, 'workload'); assert.equal(result.switches[0].networks[0].vlan, 100);
  assert.deepEqual(result.nics[0], { id: 'nic-2', name: 'Physical port', hostId: 'host-2', switchId: 'switch-2', link: 'unknown', speedMbps: null, bond: null, bondMode: null, peerId: null, peerPort: null });
  assert.doesNotMatch(JSON.stringify(result), /192\.0\.2|mac_address|EXAMPLE_NOT_A_REAL_TOKEN|virtual-2/);
  assert.equal(f.calls.length, 5); assert.ok(f.calls.every(call => call.body.orderBy === 'id_ASC' && call.body.first <= 100 && call.options.signal));
  assert.deepEqual(f.calls.find(call => call.path.endsWith('get-nics')).body.where, { host: { cluster: { id: input.clusterId } } });
  const again = await f.provider.read(input); assert.equal(again.revision, result.revision);
});

test('system and unknown purposes stay protected and asynchronous source data is not claimed complete', async () => {
  const f = fixture(); f.source['get-vdses'][0].internal = true; f.source['get-vlans'][0].type = 'STORAGE';
  f.source['get-hosts'][0].entityAsyncStatus = 'UPDATING'; const result = await f.provider.read(input);
  assert.equal(result.switches[0].purpose, 'system'); assert.equal(result.switches[0].networks[0].purpose, 'storage'); assert.equal(result.complete, false);
  f.source['get-vdses'][0].internal = false; f.source['get-vdses'][0].type = 'UNKNOWN_FUTURE_TYPE'; assert.equal((await f.provider.read(input)).switches[0].purpose, null);
  f.source['get-vdses'][0].type = 'VM'; delete f.source['get-vdses'][0].internal; assert.equal((await f.provider.read(input)).switches[0].purpose, null);
});

test('cross-cluster rows, orphan relationships, duplicate identities and conflicting memberships fail closed', async () => {
  for (const mutate of [f => { f.source['get-hosts'][0].cluster = { id: 'other' }; }, f => { f.source['get-vlans'][0].vds.id = 'other'; },
    f => { f.source['get-nics'][0].host.id = 'other'; }, f => { f.source['get-nics'][0].vds.id = 'other'; },
    f => { f.source['get-vdses'][0].nics = [{ id: 'absent-nic' }]; }, f => { f.source['get-hosts'].push(f.source['get-hosts'][0]); }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.provider.read(input), /TOPOLOGY_(?:RELATIONSHIP|SOURCE)_INVALID/);
  }
  for (const mutate of [f => { f.source['get-vlans'][0].vlan_id = '100'; }, f => { f.source['get-vdses'][0].nics = {}; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.provider.read(input), /TOPOLOGY_SOURCE_INVALID/);
  }
});

test('pagination reads a bounded extra row, rejects excess instead of silently truncating, and rejects repeated pages', async () => {
  const f = fixture(); f.source['get-clusters'] = Array.from({ length: 200 }, (_, i) => ({ id: 'cluster-' + String(i).padStart(3, '0'), name: 'Cluster ' + i }));
  const result = await f.provider.listClusters({ pluginId, actor }); assert.equal(result.clusters.length, 200); assert.deepEqual(f.calls.map(call => [call.body.skip, call.body.first]), [[0, 100], [100, 100], [200, 1]]);
  f.source['get-clusters'].push({ id: 'cluster-extra', name: 'Extra' }); await assert.rejects(f.provider.listClusters({ pluginId, actor }), /TOPOLOGY_RESOURCE_LIMIT/);
  let calls = 0; const repeat = fixture({ request: async () => { calls++; return Array.from({ length: 100 }, (_, i) => ({ id: 'row-' + i, name: 'Row ' + i })); } });
  await assert.rejects(repeat.provider.listClusters({ pluginId, actor }), /TOPOLOGY_SOURCE_INVALID/); assert.equal(calls, 2);
});

test('cancellation before dispatch and permission changes before publication deny results', async () => {
  const abort = new AbortController(); abort.abort(); const f = fixture(); await assert.rejects(f.provider.read({ ...input, signal: abort.signal }), /TOPOLOGY_READ_CANCELLED/); assert.equal(f.calls.length, 0);
  let gates = 0; const stopped = fixture({ pluginStatus: async () => ({ ...status(), enabled: ++gates === 1 }) }); await assert.rejects(stopped.provider.read(input), /TOPOLOGY_PLUGIN_UNAVAILABLE/);
});

test('transport failures expose bounded codes and never fall back to another cluster or identity', async () => {
  let calls = 0; const f = fixture({ request: async () => { calls++; throw Object.assign(new Error('EXAMPLE_PRIVATE_DIAGNOSTIC'), { status: 403 }); } });
  await assert.rejects(f.provider.read(input), /TOPOLOGY_PERMISSION_DENIED/); assert.equal(calls, 1);
});

test('frontend provider binds plugin and cluster, validates exact DTO, and rejects cancellation or leaked extra fields', async () => {
  const snapshot = await fixture().provider.read(input), calls = [];
  const api = async (route, method, body, options) => { calls.push({ route, method, body, options }); return structuredClone(snapshot); };
  const provider = createDataProviders(api, pluginId).networkTopology;
  assert.equal((await provider.read({ clusterId: input.clusterId })).cluster.id, input.clusterId); assert.match(calls[0].route, /clusterId=second-cluster/); assert.equal(calls[0].method, 'GET');
  await assert.rejects(createDataProviders(api, 'rivetin-other').networkTopology.read({ clusterId: input.clusterId }), /TOPOLOGY_PERMISSION_REQUIRED/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(provider.read({ clusterId: input.clusterId, signal: controller.signal }), /REQUEST_CANCELLED/); assert.equal(calls.length, 1);
  assert.throws(() => validateTopologySnapshot({ ...snapshot, Authorization: 'EXAMPLE' }, input.clusterId), /TOPOLOGY_RESPONSE_INVALID/);
  assert.throws(() => validateTopologySnapshot(snapshot, 'first-cluster'), /TOPOLOGY_RESPONSE_INVALID/);
});

test('Tower caller cancellation and shorter deadlines are forwarded without widening the default budget', async () => {
  let calls = 0, signal; const connection = createTowerConnection({ baseUrl: 'https://tower.example.invalid', fetchImpl: async (url, options) => { calls++; signal = options.signal; return Response.json([]); } });
  const abort = new AbortController(); abort.abort(); await assert.rejects(connection.request('/v2/api/get-hosts', {}, actor, { signal: abort.signal })); assert.equal(calls, 0);
  await connection.request('/v2/api/get-hosts', {}, actor, { timeoutMs: 100 }); assert.equal(signal.aborted, false);
  await assert.rejects(connection.request('/v2/api/get-hosts', {}, actor, { timeoutMs: 4001 }), /INVALID_TOWER_TIMEOUT/);
});
