import test from 'node:test';
import assert from 'node:assert/strict';
import { createSshInventory } from '../server/tower-inventory.js';
const actor = { id: 'example-admin', admin: true, source: 'tower', auth: { Authorization: 'EXAMPLE_NOT_A_REAL_TOKEN' } };
const cluster = { id: 'example-cluster', name: 'Example cluster' };
const host = { id: 'example-host', name: 'Example host', cluster, management_ip: '192.0.2.10', password: 'EXAMPLE_NOT_A_REAL_SECRET' };
test('SSH inventory uses caller-scoped exact routes and returns only the host picker contract', async () => {
  const calls = [], read = createSshInventory({ request: async (route, body, caller) => { calls.push({ route, body, caller }); return route.endsWith('get-clusters') ? [cluster] : [host]; } });
  assert.deepEqual(await read(actor), { clusters: [cluster], hosts: [{ id: host.id, name: host.name, clusterId: cluster.id, address: host.management_ip }] });
  assert.ok(calls.every(call => call.caller === actor && call.body.first === 501));
});
test('SSH inventory rejects absent permission, excess results, duplicates and foreign host membership', async () => {
  const read = (clusters, hosts) => createSshInventory({ request: async route => route.endsWith('get-clusters') ? clusters : hosts });
  await assert.rejects(read([cluster], [host])({ ...actor, admin: false }), error => error.status === 403);
  await assert.rejects(read(Array(501).fill(cluster), [])(actor), /SSH_INVENTORY_LIMIT/);
  await assert.rejects(read([cluster], [host, host])(actor), /SSH_INVENTORY_INVALID/);
  await assert.rejects(read([cluster], [{ ...host, cluster: { id: 'example-other' } }])(actor), /SSH_INVENTORY_INVALID/);
});
