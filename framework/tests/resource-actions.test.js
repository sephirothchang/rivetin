import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createResourceActions } from '../server/resource-actions.js';

const pluginId = 'rivetin-context-menu', resource = { type: 'vm', id: 'example-vm' };
const actor = { id: 'example-root', name: 'Example administrator', source: 'tower', role: 'ROOT', admin: true, auth: { Authorization: 'EXAMPLE_TOKEN' } };
const vm = () => ({ id: resource.id, name: 'Example VM', description: 'Example description', status: 'STOPPED', protected: false, internal: false, in_recycle_bin: false, entityAsyncStatus: null, vm_tools_status: 'RUNNING', ips: ['192.0.2.10'], node_ip: '192.0.2.11' });
async function fixture(t, options = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'resource-actions-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const state = { vm: vm(), active: [], task: { id: 'example-task', resource_id: resource.id, status: 'EXECUTING' }, status: { frameworkEnabled: true, installed: true, enabled: true, compatible: true, manifest: { permissions: ['ui.context-menu', 'resource.actions'] } }, build: '4.9.0' }, calls = [], events = [];
  const request = async (url, body, current) => {
    calls.push({ url, body: structuredClone(body), actor: current });
    if (options.request) { const value = await options.request(url, body, current, state); if (value !== undefined) return value; }
    if (url === '/v2/api/get-vms') return [structuredClone(state.vm)];
    if (url === '/v2/api/get-tasks') return body.where.id ? [structuredClone(state.task)] : structuredClone(state.active);
    if (url.startsWith('/v2/api/get-')) return [{ id: body.where.id, name: 'Example object', serial: 'EXAMPLE_SERIAL', path: '/dev/sda', management_ip: '192.0.2.10' }];
    if (options.submit) return options.submit(url, body, current, state);
    return [{ data: { id: resource.id }, task_id: state.task.id }];
  };
  const configuration = { request, pluginStatus: async () => state.status, towerBuildProvider: async () => state.build,
    audit: async event => { events.push(event); if (options.audit) await options.audit(event); } };
  const provider = createResourceActions(root, configuration);
  const execute = patch => provider.execute({ pluginId, resource, actionId: 'vm.general.edit', values: { name: 'Updated example' }, requestId: randomUUID(), actor, ...patch });
  return { root, state, calls, events, provider, configuration, execute, writes: () => calls.filter(call => !call.url.startsWith('/v2/api/get-')) };
}

test('reads use exact caller-scoped REST filters, return only safe facts and 67 explicit capabilities', async t => {
  const f = await fixture(t), value = await f.provider.read({ pluginId, resource: { ...resource, name: 'Untrusted display name' }, actor });
  assert.deepEqual(f.calls.map(call => [call.url, call.body]), [
    ['/v2/api/get-vms', { where: { id: resource.id }, first: 2 }],
    ['/v2/api/get-tasks', { where: { resource_id: resource.id, status_in: ['EXECUTING', 'PENDING', 'PAUSED'] }, first: 2 }],
  ]);
  assert.ok(f.calls.every(call => call.actor === actor));
  assert.equal(value.snapshot.name, 'Example VM'); assert.equal(value.snapshot.hasActiveTask, false);
  assert.equal(Object.keys(value.capabilities).length, 67); assert.equal(value.capabilities['vm.general.edit'].allowed, true);
  assert.deepEqual(value.capabilities['vm.delete'], { allowed: false, reason: 'RESOURCE_ACTION_UNSUPPORTED' });
  assert.ok(!JSON.stringify(value).includes('192.0.2.')); assert.ok(!JSON.stringify(value).includes('EXAMPLE_TOKEN'));
});

test('host, cluster, physical disk and VM volume reads use their documented endpoints without leaking raw fields', async t => {
  const f = await fixture(t);
  for (const [type, endpoint] of [['host', 'get-hosts'], ['cluster', 'get-clusters'], ['disk', 'get-disks'], ['vmVolume', 'get-vm-volumes']]) {
    const value = await f.provider.read({ pluginId, resource: { type, id: 'example-resource' }, actor });
    assert.equal(f.calls.at(-1).url, '/v2/api/' + endpoint); assert.deepEqual(value.snapshot, { id: 'example-resource', type, name: 'Example object' });
    assert.ok(Object.values(value.capabilities).every(capability => capability.allowed === false));
  }
  await assert.rejects(f.provider.read({ pluginId, resource: { type: 'virtualDisk', id: 'example-resource' }, actor }), /RESOURCE_ACTION_RESOURCE_INVALID/);
});

test('fresh ROOT role is required for capability; admin names and tokens cannot manufacture action permissions', async t => {
  const f = await fixture(t), current = { ...actor, role: undefined, name: 'root', admin: true };
  const value = await f.provider.read({ pluginId, resource, actor: current });
  assert.deepEqual(value.capabilities['vm.general.edit'], { allowed: null, reason: 'RESOURCE_ACTION_PERMISSION_UNVERIFIED' });
  await assert.rejects(f.execute({ actor: current }), /RESOURCE_ACTION_PERMISSION_UNVERIFIED/); assert.equal(f.writes().length, 0);
});

test('plugin lifecycle, independent permission, Tower version and caller credentials gate all operations', async t => {
  const f = await fixture(t);
  for (const field of ['frameworkEnabled', 'installed', 'enabled', 'compatible']) {
    f.state.status[field] = false; await assert.rejects(f.execute(), /RESOURCE_ACTION_PLUGIN_UNAVAILABLE/); f.state.status[field] = true;
  }
  f.state.status.manifest.permissions = ['ui.context-menu']; await assert.rejects(f.execute(), /RESOURCE_ACTION_PERMISSION_REQUIRED/);
  f.state.status.manifest.permissions.push('resource.actions');
  for (const build of [null, '4.8.0', '4.9.1', '4.9.0-rc-EXAMPLE']) { f.state.build = build; await assert.rejects(f.execute(), /RESOURCE_ACTION_TOWER_UNSUPPORTED/); }
  f.state.build = '4.9.0'; await assert.rejects(f.execute({ actor: { ...actor, auth: {} } }), /AUTHENTICATION_REQUIRED/);
  assert.equal(f.calls.length, 0);
});

test('resource IDs, arbitrary API fields, unsupported actions and malformed parameters are rejected before any request', async t => {
  const f = await fixture(t);
  for (const patch of [{ resource: { ...resource, url: '/v2/api/delete-vm' } }, { resource: { type: 'vm', id: '../other' } }, { actionId: 'vm.delete' },
    { values: {} }, { values: { name: '' } }, { values: { name: 'unsafe\nname' } }, { values: { name: 'Example', where: { id: 'another-vm' } } },
    { values: { description: '\u0000' } }, { values: { description: 'x'.repeat(4097) } }, { requestId: '../arbitrary-path' },
    { actionId: 'vm.power.start', values: { host_id: 'another-host' } }]) {
    await assert.rejects(f.execute(patch), /RESOURCE_ACTION_(?:RESOURCE_INVALID|UNSUPPORTED|VALUES_INVALID|REQUEST_ID_INVALID)/);
  }
  assert.equal(f.calls.length, 0);
});

test('missing, mismatched, ambiguous or enveloped objects and denied reads fail closed', async t => {
  for (const value of [[], [vm(), vm()], [{ ...vm(), id: 'another-vm' }], { data: [vm()] }, { errors: [{ message: 'EXAMPLE_PRIVATE' }] }, [{ ...vm(), protected: undefined }]]) {
    const f = await fixture(t, { request: url => url === '/v2/api/get-vms' ? value : undefined });
    await assert.rejects(f.execute(), /RESOURCE_ACTION_(?:NOT_FOUND|RESPONSE_INVALID)/); assert.equal(f.writes().length, 0);
  }
  const f = await fixture(t, { request: () => { throw Object.assign(new Error('EXAMPLE_PRIVATE'), { status: 403 }); } });
  await assert.rejects(f.execute(), /^Error: RESOURCE_ACTION_PERMISSION_DENIED$/);
});

test('protected, internal, recycled, busy and active-task VMs cannot be modified', async t => {
  const f = await fixture(t);
  for (const [key, value] of [['protected', true], ['internal', true], ['in_recycle_bin', true], ['entityAsyncStatus', 'UPDATING'], ['status', 'UNKNOWN']]) {
    f.state.vm = { ...vm(), [key]: value }; await assert.rejects(f.execute(), /RESOURCE_ACTION_STATE_REJECTED/);
  }
  f.state.vm = vm(); f.state.active = [{ id: 'example-pending-task', resource_id: resource.id, status: 'PENDING' }];
  await assert.rejects(f.execute(), /RESOURCE_ACTION_STATE_REJECTED/); assert.equal(f.writes().length, 0);
});

test('general edit sends only explicitly supplied fields and null-task success requires actual readback', async t => {
  const f = await fixture(t, { submit: (url, body, current, state) => { Object.assign(state.vm, body.data); return [{ data: { id: resource.id, ips: ['192.0.2.10'] }, task_id: null }]; } });
  const result = await f.execute({ values: { description: 'EXAMPLE_NEW_DESCRIPTION\nSecond line' } });
  assert.equal(result.status, 'succeeded'); assert.deepEqual(f.writes()[0].body, { where: { id: resource.id }, data: { description: 'EXAMPLE_NEW_DESCRIPTION\nSecond line' } });
  const file = await readFile(path.join(f.root, 'resource-actions', result.operationId + '.json'), 'utf8');
  assert.ok(!file.includes('EXAMPLE_NEW_DESCRIPTION')); assert.ok(!file.includes('EXAMPLE_TOKEN'));
  assert.ok(!JSON.stringify(f.events).includes('EXAMPLE_TOKEN')); assert.ok(!JSON.stringify(f.events).includes('EXAMPLE_NEW_DESCRIPTION'));
  const bad = await fixture(t, { submit: () => [{ data: { id: resource.id }, task_id: null }] });
  assert.equal((await bad.execute()).status, 'unknown');
});

test('seven power operations use documented fixed payloads and enforce power/VM Tools states', async t => {
  const f = await fixture(t);
  for (const [suffix, status, endpoint] of [['start', 'STOPPED', 'start-vm'], ['shutdown', 'RUNNING', 'shutdown-vm'], ['poweroff', 'RUNNING', 'poweroff-vm'], ['restart', 'RUNNING', 'restart-vm'], ['forceRestart', 'RUNNING', 'force-restart-vm'], ['suspend', 'RUNNING', 'suspend-vm'], ['resume', 'SUSPENDED', 'resume-vm']]) {
    f.state.vm.status = status;
    assert.equal((await f.execute({ actionId: 'vm.power.' + suffix, values: {} })).status, 'running');
    assert.deepEqual(f.writes().at(-1).body, { where: { id: resource.id } }); assert.equal(f.writes().at(-1).url, '/v2/api/' + endpoint);
  }
  f.state.vm.status = 'RUNNING'; f.state.vm.vm_tools_status = 'NOT_RUNNING';
  await assert.rejects(f.execute({ actionId: 'vm.power.restart', values: {} }), /RESOURCE_ACTION_STATE_REJECTED/);
  await assert.rejects(f.execute({ actionId: 'vm.power.shutdown', values: {} }), /RESOURCE_ACTION_STATE_REJECTED/);
});

test('concurrent and process-restarted duplicate request IDs submit once; changed input conflicts', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const [a, b] = await Promise.all([f.execute({ requestId }), f.execute({ requestId })]);
  assert.deepEqual(a, b); assert.equal(f.writes().length, 1);
  const restarted = createResourceActions(f.root, f.configuration);
  assert.deepEqual(await restarted.execute({ pluginId, resource, actionId: 'vm.general.edit', values: { name: 'Updated example' }, requestId, actor }), a);
  await assert.rejects(f.execute({ requestId, values: { name: 'Different example' } }), /RESOURCE_ACTION_REQUEST_CONFLICT/);
  assert.equal(f.writes().length, 1);
});

test('transport timeouts and 5xx remain unknown across retries and restart; definite 403 is failed', async t => {
  for (const status of [undefined, 500, 503, 408, 403, 400]) {
    const f = await fixture(t, { submit: () => { throw Object.assign(new Error('EXAMPLE_PRIVATE_API_BODY'), { status }); } }), requestId = randomUUID();
    const result = await f.execute({ requestId });
    assert.equal(result.status, [403, 400].includes(status) ? 'failed' : 'unknown');
    assert.deepEqual(await f.execute({ requestId }), result); assert.equal(f.writes().length, 1);
    const restarted = createResourceActions(f.root, f.configuration);
    assert.deepEqual(await restarted.task({ pluginId, operationId: result.operationId, actor }), result);
    assert.ok(!JSON.stringify(result).includes('EXAMPLE_PRIVATE')); assert.equal(f.writes().length, 1);
  }
});

test('malformed asynchronous results never become success or authorize resubmission', async t => {
  for (const value of [[], [{ data: { id: 'another-vm' }, task_id: 'example-task' }], [{ data: { id: resource.id } }], { errors: [{ message: 'EXAMPLE_PRIVATE' }] }]) {
    const f = await fixture(t, { submit: () => value }), requestId = randomUUID(), result = await f.execute({ requestId });
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'RESOURCE_ACTION_RESPONSE_INVALID');
    await f.execute({ requestId }); assert.equal(f.writes().length, 1);
  }
});

test('task polls use exact task and VM identities under caller permissions without submitting again', async t => {
  const f = await fixture(t), result = await f.execute();
  assert.equal(result.status, 'running'); assert.equal(result.taskId, 'example-task');
  for (const status of ['PENDING', 'EXECUTING', 'PAUSED']) {
    f.state.task.status = status; assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).status, 'running');
  }
  f.state.task.status = 'SUCCESSED'; f.state.vm.name = 'Updated example'; assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).status, 'succeeded');
  assert.deepEqual(f.calls.find(call => call.body.where?.id === 'example-task').body, { where: { id: 'example-task' }, first: 2 });
  assert.equal(f.writes().length, 1);
  await assert.rejects(f.provider.task({ pluginId, operationId: result.operationId, actor: { ...actor, id: 'another-root' } }), /RESOURCE_ACTION_OPERATION_NOT_FOUND/);
});

test('mismatched or failing task lookup remains non-success; task errors are sanitized', async t => {
  const f = await fixture(t), result = await f.execute();
  f.state.task.resource_id = 'another-vm';
  assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).code, 'RESOURCE_ACTION_TASK_MISMATCH');
  f.state.task.resource_id = resource.id; f.state.task.status = 'FAILED'; f.state.task.error_message = 'EXAMPLE_PRIVATE_API_BODY';
  const failed = await f.provider.task({ pluginId, operationId: result.operationId, actor });
  assert.equal(failed.status, 'failed'); assert.equal(failed.code, 'RESOURCE_ACTION_TASK_FAILED'); assert.ok(!JSON.stringify(failed).includes('EXAMPLE_PRIVATE'));
});

test('audit unavailable before submission blocks mutation and persists the failure safely', async t => {
  const f = await fixture(t, { audit: () => { throw new Error('EXAMPLE_PRIVATE_LOG_ERROR'); } }), result = await f.execute();
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'RESOURCE_ACTION_AUDIT_UNAVAILABLE'); assert.equal(f.writes().length, 0);
  assert.equal((await readdir(path.join(f.root, 'resource-actions'))).filter(name => name.endsWith('.json')).length, 1);
});

test('console explicitly remains unsupported and never fetches or returns VNC tokens or URLs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.provider.openConsole({ pluginId, resource, actor }), /^Error: RESOURCE_ACTION_UNSUPPORTED$/);
  assert.ok(f.calls.every(call => call.url.startsWith('/v2/api/get-'))); assert.ok(!f.calls.some(call => call.url.includes('vnc')));
});

test('public errors have stable HTTP statuses and never expose unexpected provider diagnostics', async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute({ actor: { ...actor, role: 'ADMIN' } }), error => error.message === 'RESOURCE_ACTION_PERMISSION_UNVERIFIED' && error.status === 403);
  await assert.rejects(f.execute({ requestId: 'invalid' }), error => error.status === 400);
  const requestId = randomUUID(); await f.execute({ requestId });
  await assert.rejects(f.execute({ requestId, values: { name: 'conflicting' } }), error => error.status === 409);
  await assert.rejects(f.provider.task({ pluginId, operationId: 'a'.repeat(64), actor }), error => error.status === 404);
  await assert.rejects(f.provider.read({ pluginId, resource, actor, url: 'https://example.invalid' }), error => error.message === 'RESOURCE_ACTION_REQUEST_INVALID' && error.status === 400);
  const broken = createResourceActions(f.root, { request: async () => [], pluginStatus: async () => { throw new Error('EXAMPLE_PRIVATE_PROVIDER_DETAIL'); } });
  await assert.rejects(broken.read({ pluginId, resource, actor }), error => error.message === 'RESOURCE_ACTION_FAILED' && error.status === 503);
});

test('unknown VM Tools values preserve basic reads but cannot authorize guest operations', async t => {
  const f = await fixture(t); f.state.vm.status = 'RUNNING'; f.state.vm.vm_tools_status = 'NEED_UPGRADE';
  const value = await f.provider.read({ pluginId, resource, actor });
  assert.equal(value.snapshot.vm_tools_status, 'UNKNOWN'); assert.equal(value.capabilities['vm.general.edit'].allowed, true);
  assert.equal(value.capabilities['vm.power.shutdown'].allowed, false); assert.equal(value.capabilities['vm.power.restart'].allowed, false);
  f.state.vm.status = 'EXAMPLE_NEW_STATE';
  const unknown = await f.provider.read({ pluginId, resource, actor });
  assert.equal(unknown.snapshot.status, 'UNKNOWN'); assert.equal(unknown.capabilities['vm.general.edit'].allowed, false);
});

test('task success requires a post-completion exact object read and power post-state', async t => {
  const f = await fixture(t), result = await f.execute({ actionId: 'vm.power.start', values: {} });
  f.state.task.status = 'SUCCESSED';
  const before = f.calls.filter(call => call.url === '/v2/api/get-vms').length;
  assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).code, 'RESOURCE_ACTION_READBACK_UNVERIFIED');
  assert.equal(f.calls.filter(call => call.url === '/v2/api/get-vms').length, before + 2);
  f.state.vm.status = 'RUNNING'; assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).status, 'succeeded');
  assert.equal(f.writes().length, 1);
});

test('general-edit task completion verifies fingerprint against fields read only after task success', async t => {
  const observed = [];
  const f = await fixture(t, { request: (url, body, current, state) => {
    if (url === '/v2/api/get-vms') observed.push(state.vm.name);
    if (url === '/v2/api/get-tasks' && body.where.id && state.task.status === 'SUCCESSED') state.vm.name = 'Updated example';
  } });
  const result = await f.execute(); f.state.task.status = 'SUCCESSED';
  assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).status, 'succeeded');
  assert.deepEqual(observed.slice(-2), ['Example VM', 'Updated example']); assert.equal(f.writes().length, 1);
});

test('successful task with unchanged values stays unknown, persists only expected keys and can be rechecked without replay', async t => {
  const f = await fixture(t), result = await f.execute({ values: { description: 'EXAMPLE_CHANGED_DESCRIPTION', name: 'Updated example' } });
  f.state.task.status = 'SUCCESSED'; f.state.vm.name = 'Updated example';
  const unverified = await f.provider.task({ pluginId, operationId: result.operationId, actor });
  assert.equal(unverified.status, 'unknown'); assert.equal(unverified.code, 'RESOURCE_ACTION_READBACK_UNVERIFIED');
  const raw = await readFile(path.join(f.root, 'resource-actions', result.operationId + '.json'), 'utf8'), record = JSON.parse(raw);
  assert.deepEqual(record.expectedKeys, ['name', 'description']); assert.ok(!raw.includes('EXAMPLE_CHANGED_DESCRIPTION')); assert.ok(!raw.includes('Updated example'));
  f.state.vm.description = 'EXAMPLE_CHANGED_DESCRIPTION';
  assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).status, 'succeeded'); assert.equal(f.writes().length, 1);
});

test('task lookup uncertainty is reported as unknown and a later exact lookup can recover without replay', async t => {
  let mode = 'normal';
  const f = await fixture(t, { request: (url, body) => {
    if (url === '/v2/api/get-tasks' && body.where.id) {
      if (mode === 'timeout') throw new Error('EXAMPLE_PRIVATE_TIMEOUT');
      if (mode === 'missing') return [];
      if (mode === 'mismatch') return [{ id: 'example-task', resource_id: 'another-vm', status: 'EXECUTING' }];
    }
  } }), result = await f.execute();
  for (const value of ['timeout', 'missing', 'mismatch']) {
    mode = value; const current = await f.provider.task({ pluginId, operationId: result.operationId, actor });
    assert.equal(current.status, 'unknown'); assert.equal(current.code, value === 'mismatch' ? 'RESOURCE_ACTION_TASK_MISMATCH' : 'RESOURCE_ACTION_TASK_UNAVAILABLE');
  }
  mode = 'normal'; assert.equal((await f.provider.task({ pluginId, operationId: result.operationId, actor })).status, 'running'); assert.equal(f.writes().length, 1);
});

test('the final gate after slow audit blocks submission when emergency state, permission or version changes', async t => {
  for (const change of ['enabled', 'permission', 'version']) {
    const f = await fixture(t, { audit: event => {
      if (event.result !== 'started') return;
      if (change === 'enabled') f.state.status.frameworkEnabled = false;
      if (change === 'permission') f.state.status.manifest.permissions = [];
      if (change === 'version') f.state.build = null;
    } });
    const requestId = randomUUID(), result = await f.execute({ requestId });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'RESOURCE_ACTION_PLUGIN_UNAVAILABLE'); assert.equal(f.writes().length, 0);
    f.state.status.frameworkEnabled = true; f.state.status.manifest.permissions = ['ui.context-menu', 'resource.actions']; f.state.build = '4.9.0';
    assert.deepEqual(await f.execute({ requestId }), result); assert.equal(f.writes().length, 0);
  }
});
