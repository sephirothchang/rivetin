import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { createClient } from '../src/client.js';
import { createDataProviders } from '../src/data-providers.js';
import { bundle } from './helpers.js';

const pluginId = 'rivetin-actions-example';
async function fixture(t, { unknown = false } = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'resource-integration-'));
  const actor = { id: 'example-admin', name: 'Example administrator', source: 'tower', role: 'ROOT', admin: true, auth: { Authorization: 'EXAMPLE_NOT_A_REAL_TOKEN' } };
  const vm = { id: 'example-vm', name: 'Example VM', description: 'Example description', status: 'STOPPED', protected: false, internal: false, in_recycle_bin: false, entityAsyncStatus: null, vm_tools_status: 'RUNNING' };
  let mutations = 0, succeeded = false;
  const calls = [];
  const service = createService(directory, { towerBuild: '4.9.0', towerRequest: async (route, body, caller) => {
    calls.push({ route, body, actorId: caller.id });
    assert.equal(caller.auth.Authorization, actor.auth.Authorization);
    if (route === '/v2/api/get-vms') { assert.deepEqual(body, { where: { id: vm.id }, first: 2 }); return [structuredClone(vm)]; }
    if (route === '/v2/api/get-tasks') return body.where.id ? [{ id: 'example-task', resource_id: vm.id, status: succeeded ? 'SUCCESSED' : 'EXECUTING' }] : [];
    if (route === '/v2/api/update-vm-basic-info') {
      mutations++;
      if (unknown) throw new TypeError('EXAMPLE_TRANSPORT_DISCONNECTED');
      assert.deepEqual(body.where, { id: vm.id }); Object.assign(vm, body.data);
      return [{ data: { id: vm.id }, task_id: 'example-task' }];
    }
    throw new Error('UNEXPECTED_TEST_REQUEST');
  } });
  t.after(async () => { await service.sshChannel.stop(); if (!directory.startsWith(base + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE'); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await service.initialize(actor);
  const bytes = bundle(pluginId, '0.1.0', pkg => { pkg.manifest.permissions = ['ui.context-menu', 'resource.actions']; return pkg; });
  const pkg = await service.upload(bytes, actor); await service.change('install', pluginId, pkg.packageId, actor); await service.change('enable', pluginId, null, actor); await service.enable(actor);
  const server = http.createServer(createApi(service, { origins: ['https://tower.example.invalid'], authenticate: async req => req.headers.authorization === actor.auth.Authorization ? actor : null }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ localStorage: { getItem: () => JSON.stringify({ value: actor.auth.Authorization }) }, fetch: (route, options) => fetch(url + route, { ...options, headers: { ...options.headers, Origin: 'https://tower.example.invalid' } }) });
  return { service, actor, client, bridge: createDataProviders(client, pluginId).resourceActions, calls, mutations: () => mutations, finish() { succeeded = true; }, resource: { type: 'vm', id: vm.id } };
}

test('real shared resource HTTP/client contract submits once and follows a matching task', async t => {
  const f = await fixture(t);
  const current = await f.bridge.read(f.resource);
  assert.equal(current.snapshot.id, f.resource.id); assert.equal(current.capabilities['vm.general.edit'].allowed, true);
  assert.equal(current.capabilities['vm.hardware.cpu'].allowed, false); assert.equal(f.mutations(), 0);
  const request = { resource: f.resource, actionId: 'vm.general.edit', values: { description: '' }, requestId: randomUUID() };
  const first = await f.bridge.execute(request), repeated = await f.bridge.execute(request);
  assert.equal(first.status, 'running'); assert.deepEqual(repeated, first); assert.equal(f.mutations(), 1);
  assert.equal((await f.bridge.task(first.operationId)).status, 'running');
  f.finish(); assert.equal((await f.bridge.task(first.operationId)).status, 'succeeded');
  assert.equal((await f.bridge.read(f.resource)).snapshot.description, '');
  assert.ok(f.calls.every(call => call.actorId === f.actor.id));
});

test('unknown transport outcome is durable and cannot replay through the client', async t => {
  const f = await fixture(t, { unknown: true });
  const request = { resource: f.resource, actionId: 'vm.general.edit', values: { name: 'Example changed name' }, requestId: randomUUID() };
  const first = await f.bridge.execute(request);
  assert.equal(first.status, 'unknown');
  assert.deepEqual(await f.bridge.execute(request), first);
  assert.equal(f.mutations(), 1);
  await assert.rejects(f.bridge.execute({ ...request, values: { name: 'Example conflicting name' } }), /RESOURCE_ACTION_REQUEST_CONFLICT/);
  assert.equal(f.mutations(), 1);
});

test('framework emergency disable rejects new resource reads and mutations', async t => {
  const f = await fixture(t); await f.service.disable(f.actor);
  await assert.rejects(f.bridge.read(f.resource), /RESOURCE_ACTION_PLUGIN_UNAVAILABLE/);
  await assert.rejects(f.bridge.execute({ resource: f.resource, actionId: 'vm.general.edit', values: { name: 'Example VM name' }, requestId: randomUUID() }), /RESOURCE_ACTION_PLUGIN_UNAVAILABLE/);
  assert.equal(f.mutations(), 0);
});
