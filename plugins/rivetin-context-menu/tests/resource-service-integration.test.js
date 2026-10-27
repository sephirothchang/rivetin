import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createService } from '../../../framework/server/service.js';
import { createApi } from '../../../framework/server/http.js';
import { createClient } from '../../../framework/src/client.js';
import { createDataProviders } from '../../../framework/src/data-providers.js';
import { bundle } from '../../../framework/tests/helpers.js';
import { createProductionActionProvider } from '../src/actions/provider.js';
import { buildActionTree } from '../src/actions/catalog.js';

const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const pluginId = 'rivetin-context-menu', resource = { type: 'vm', id: 'example-vm', name: 'Example VM' };
const setupActor = { id: 'example-setup', name: 'Example setup', source: 'demo', admin: true };
const copy = value => structuredClone(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate() && performance.now() < deadline) await pause(10);
  assert.ok(predicate(), 'Expected observable integration state within the bounded wait');
}

async function fixture(t, { permissions = ['ui.context-menu', 'resource.actions'], applyReadback = true } = {}) {
  const parent = path.resolve(tmpdir()), directory = await mkdtemp(path.join(parent, 'rivetin-context-menu-http-'));
  let server, dom, provider;
  t.after(async () => {
    provider?.stop(); dom?.window.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith('rivetin-context-menu-http-')) throw new Error('TEST_DIRECTORY_OUTSIDE_ALLOWLIST');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const state = { vm: { id: resource.id, name: resource.name, description: 'Before', status: 'RUNNING', protected: false, internal: false, in_recycle_bin: false, entityAsyncStatus: null, vm_tools_status: 'RUNNING' }, pending: null, complete: false, mismatch: false,
    actor: { id: 'example-root', name: 'Example administrator', source: 'tower', admin: true, role: 'ROOT', auth: { Authorization: 'EXAMPLE_UNUSABLE_TEST_AUTHORIZATION' } } };
  const towerCalls = [], httpCalls = [];
  // Only this final Tower request dependency is replaced. No real Tower address,
  // credential or VM is contacted; every request must be one of these fixed APIs.
  async function fakeTower(url, body, actor) {
    assert.equal(actor.id, state.actor.id); towerCalls.push({ url, body: copy(body) });
    if (url === '/v2/api/get-vms') {
      assert.deepEqual(Object.keys(body).sort(), ['first', 'where']); assert.deepEqual(Object.keys(body.where), ['id']);
      if (body.where.id !== resource.id) return [];
      return [{ ...copy(state.vm), ...(state.mismatch ? { id: 'another-vm' } : {}) }];
    }
    if (url === '/v2/api/get-tasks') {
      if (Object.hasOwn(body.where, 'id')) {
        assert.equal(body.where.id, 'example-task'); assert.deepEqual(Object.keys(body.where), ['id']);
        state.complete = true;
        if (applyReadback) Object.assign(state.vm, state.pending);
        return [{ id: 'example-task', resource_id: resource.id, status: 'SUCCESSED' }];
      }
      assert.deepEqual(body.where, { resource_id: resource.id, status_in: ['EXECUTING', 'PENDING', 'PAUSED'] });
      return state.pending && !state.complete ? [{ id: 'example-task', resource_id: resource.id, status: 'EXECUTING' }] : [];
    }
    assert.equal(url, '/v2/api/update-vm-basic-info'); assert.deepEqual(body.where, { id: resource.id });
    assert.deepEqual(Object.keys(body).sort(), ['data', 'where']); state.pending = copy(body.data);
    return [{ task_id: 'example-task', data: { id: resource.id } }];
  }
  // The package's simulated 4.9.0 declaration is a test fixture, not an assertion
  // that a production build or live environment has passed compatibility tests.
  const service = createService(directory, { towerBuild: '4.9.0', towerRequest: fakeTower });
  await service.initialize(setupActor); await service.enable(setupActor);
  const uploaded = await service.upload(bundle(pluginId, '0.1.0', value => { value.manifest.permissions = permissions; return value; }), setupActor);
  await service.change('install', pluginId, uploaded.packageId, setupActor); await service.change('enable', pluginId, null, setupActor);
  let origin;
  const api = createApi(service, { authenticate: async () => state.actor, origins: [] });
  // Origins are fixed after the ephemeral loopback port has been allocated.
  let handler = api;
  server = createServer((req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  handler = createApi(service, { authenticate: async () => state.actor, origins: [origin] });
  dom = new JSDOM('<button id="previous">Previous focus</button>', { url: origin + '/#/vms' });
  const win = dom.window;
  win.fetch = async (url, options = {}) => {
    const target = new URL(url, origin); assert.equal(target.origin, origin, 'The HTTP test must stay on its own loopback origin');
    const entry = { path: target.pathname + target.search, method: options.method || 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) }; httpCalls.push(entry);
    const response = await fetch(target, { ...options, headers: { ...options.headers, Origin: origin } }); entry.status = response.status; return response;
  };
  const client = createClient(win), bridge = createDataProviders(client, pluginId).resourceActions;
  provider = createProductionActionProvider({ win, bridge, getLocale: () => 'zh-CN' });
  const root = () => win.document.querySelector('[data-rivetin-action-form]');
  const status = () => root()?.querySelector('[role="status"]')?.textContent || '';
  const confirm = () => [...root().querySelectorAll('button')].find(button => button.textContent === '确认执行');
  async function open() {
    const data = await provider.read(resource), action = buildActionTree({ resource, ...data }).flatMap(group => group.items).find(value => value.id === 'vm.general.edit');
    assert.equal((await provider.open({ resource, actionId: action.id, action, snapshot: data.snapshot })).status, 'opened');
  }
  function input(key, value) { const node = root().querySelector(`[data-field="${key}"]`); node.value = value; node.dispatchEvent(new win.Event('input', { bubbles: true })); }
  return { service, bridge, provider, win, state, towerCalls, httpCalls, root, status, confirm, open, input,
    writes: () => towerCalls.filter(call => !call.url.startsWith('/v2/api/get-')),
  };
}

test('production edit form confirms through real HTTP, service, task tracking and final readback exactly once', async t => {
  const f = await fixture(t); await f.open(); f.input('name', 'Renamed example'); f.input('description', '');
  assert.equal(f.writes().length, 0); assert.equal(f.httpCalls.filter(call => call.method === 'POST').length, 0);
  const button = f.confirm(); assert.equal(button.disabled, false); button.click(); button.dispatchEvent(new f.win.MouseEvent('click', { bubbles: true }));
  await until(() => f.status().includes('操作已完成'));
  assert.equal(f.writes().length, 1); assert.deepEqual(f.writes()[0], { url: '/v2/api/update-vm-basic-info', body: { where: { id: resource.id }, data: { name: 'Renamed example', description: '' } } });
  const submission = f.httpCalls.find(call => call.path === '/api/rivetin/v1/resource-actions/execute'); assert.equal(submission.status, 200);
  assert.deepEqual(submission.body.values, { name: 'Renamed example', description: '' }); assert.match(submission.body.requestId, /^[a-f0-9-]{36}$/);
  const terminalTask = f.towerCalls.findIndex(call => call.url === '/v2/api/get-tasks' && call.body.where.id === 'example-task');
  assert.ok(terminalTask >= 0); assert.ok(f.towerCalls.slice(terminalTask + 1).some(call => call.url === '/v2/api/get-vms' && call.body.where.id === resource.id), 'Task success must be followed by a fresh exact-VM readback');
  assert.equal(f.state.vm.name, 'Renamed example'); assert.equal(f.state.vm.description, '');
  const { pluginId: unused, ...repeated } = submission.body;
  const result = await f.bridge.execute(repeated); assert.equal(result.status, 'succeeded'); assert.equal(f.writes().length, 1);
  await assert.rejects(f.bridge.execute({ ...repeated, values: { name: 'Conflicting name', description: '' } }), /RESOURCE_ACTION_REQUEST_CONFLICT/); assert.equal(f.writes().length, 1);
});

test('a task success with unchanged VM fields cannot be shown as a completed edit', async t => {
  const f = await fixture(t, { applyReadback: false });
  const submitted = await f.bridge.execute({ resource, actionId: 'vm.general.edit', values: { name: 'Expected name' }, requestId: randomUUID() }); assert.equal(submitted.status, 'running');
  const result = await f.bridge.task(submitted.operationId);
  assert.notEqual(result.status, 'succeeded'); assert.equal(f.state.vm.name, 'Example VM'); assert.equal(f.writes().length, 1);
});

test('fresh non-ROOT permissions block a production form confirmation before a mutation request', async t => {
  const f = await fixture(t); await f.open(); f.input('name', 'Must not be applied'); f.state.actor = { ...f.state.actor, role: 'READ_ONLY' }; f.confirm().click();
  await until(() => f.status().includes('操作失败')); assert.equal(f.writes().length, 0); assert.equal(f.httpCalls.filter(call => call.path.endsWith('/resource-actions/execute')).length, 0);
  await assert.rejects(f.bridge.execute({ resource, actionId: 'vm.general.edit', values: { name: 'Denied' }, requestId: randomUUID() }), /RESOURCE_ACTION_PERMISSION_UNVERIFIED/); assert.equal(f.writes().length, 0);
});

test('manifest permission and plugin/framework disable gates are enforced by the real service', async t => {
  const missing = await fixture(t, { permissions: ['ui.context-menu'] });
  await assert.rejects(missing.bridge.read(resource), /RESOURCE_ACTION_PERMISSION_REQUIRED/); assert.equal(missing.towerCalls.length, 0);
  const f = await fixture(t); await f.service.change('disable', pluginId, null, setupActor);
  await assert.rejects(f.bridge.read(resource), /RESOURCE_ACTION_PLUGIN_UNAVAILABLE/); assert.equal(f.towerCalls.length, 0);
  await f.service.change('enable', pluginId, null, setupActor); await f.service.disable(setupActor);
  await assert.rejects(f.bridge.execute({ resource, actionId: 'vm.general.edit', values: { name: 'Denied' }, requestId: randomUUID() }), /RESOURCE_ACTION_PLUGIN_UNAVAILABLE/); assert.equal(f.writes().length, 0);
});

test('HTTP and service reject wrong VM identity and admin access without a business write', async t => {
  const f = await fixture(t); f.state.mismatch = true;
  await assert.rejects(f.bridge.read(resource), /RESOURCE_ACTION_RESPONSE_INVALID/); assert.equal(f.writes().length, 0);
  f.state.mismatch = false; await assert.rejects(f.bridge.read({ type: 'vm', id: 'another-vm' }), /RESOURCE_ACTION_NOT_FOUND/);
  f.state.actor = { ...f.state.actor, admin: false };
  await assert.rejects(f.bridge.execute({ resource, actionId: 'vm.general.edit', values: { name: 'Denied' }, requestId: randomUUID() }), /ADMIN_OR_ORIGIN_REQUIRED/);
  assert.equal(f.writes().length, 0);
});
