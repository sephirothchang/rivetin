import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataProviders } from '../src/data-providers.js';
import { createClient } from '../src/client.js';

const pluginId = 'rivetin-example';
const identity = { diskId: 'disk-example', hostId: 'host-example', generation: 'a'.repeat(64), deviceId: 'a'.repeat(64), path: '', model: 'Example disk' };

test('SMART provider scopes queries, unwraps identity and preserves errors and opaque cursor', async () => {
  const calls = [], api = async (route, method, body, options) => {
    calls.push({ route, method, body, options });
    return route.startsWith('/data/disk-smart/identity?') ? { schemaVersion: 1, identity } : { source: 'host-smartctl' };
  };
  const provider = createDataProviders(api, pluginId).diskSmart, controller = new AbortController();
  assert.deepEqual(await provider.resolveDisk({ diskId: identity.diskId, signal: controller.signal }), identity);
  await provider.readLatest({ identity, signal: controller.signal });
  await provider.readHistory({ identity, cursor: 'opaque+/=cursor', signal: controller.signal });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.signal === controller.signal && call.route.includes('pluginId=rivetin-example')));
  assert.ok(calls[2].route.includes('cursor=opaque%2B%2F%3Dcursor'));
  assert.ok(!calls[1].route.includes('path='));
  assert.throws(() => provider.readHistory({ identity, limit: 31 }), /SMART_HISTORY_REQUEST_INVALID/);
  const denied = Object.assign(new Error('SMART_GENERATION_CHANGED'), { status: 409, code: 'SMART_GENERATION_CHANGED' });
  await assert.rejects(createDataProviders(async () => { throw denied; }, pluginId).diskSmart.readLatest({ identity }), error => error === denied);
});

test('cancelled or late responses cannot reach a consuming plugin', async () => {
  const controller = new AbortController(); let calls = 0;
  const provider = createDataProviders(async () => { calls++; controller.abort(); return { schemaVersion: 1, identity }; }, pluginId).diskSmart;
  await assert.rejects(provider.resolveDisk({ diskId: identity.diskId, signal: controller.signal }), /REQUEST_CANCELLED/);
  await assert.rejects(provider.resolveDisk({ diskId: identity.diskId, signal: controller.signal }), /REQUEST_CANCELLED/);
  assert.equal(calls, 1);
});

test('resource operations send one scoped request without credentials or URL forwarding', async () => {
  const calls = [], bridge = createDataProviders(async (...args) => { calls.push(args); return { status: 'unknown', operationId: 'b'.repeat(64) }; }, pluginId).resourceActions;
  const resource = { type: 'vm', id: 'vm-example', name: 'Display only' };
  await bridge.read(resource);
  await bridge.execute({ resource, actionId: 'vm.general.edit', values: { description: '' }, requestId: 'example-operation' });
  await bridge.task('b'.repeat(64));
  await bridge.openConsole(resource);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1].slice(0, 3), ['/resource-actions/execute', 'POST', { pluginId, resource, actionId: 'vm.general.edit', values: { description: '' }, requestId: 'example-operation' }]);
  assert.deepEqual(Object.keys(calls[1][2]).sort(), ['actionId', 'pluginId', 'requestId', 'resource', 'values']);
});

test('client propagates fixed HTTP status and caller abort without retrying writes', async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = createClient({ localStorage: { getItem: () => null }, fetch: async (_url, options) => {
    calls++; assert.equal(options.signal.aborted, true);
    return { status: 403, ok: false, json: async () => ({ error: 'RESOURCE_ACTION_DENIED' }) };
  } });
  controller.abort();
  await assert.rejects(client('/resource-actions/execute', 'POST', { pluginId }, { signal: controller.signal }), error => error.status === 403 && error.code === 'RESOURCE_ACTION_DENIED');
  assert.equal(calls, 1);
});
