import test from 'node:test';
import assert from 'node:assert/strict';
import { readActionData } from '../src/actions/action-data.js';
const resource = { type: 'vm', id: 'vm-a', name: 'VM A' }, actionId = 'vm.hardware.nic.add';
const data = () => ({ actionId, snapshot: { id: 'vm-a', type: 'vm' }, capabilities: { [actionId]: { allowed: true } }, choices: { snapshot: { id: 'vm-other' } } });
test('action-specific choices preserve identity/capabilities separately and copy the host envelope', async () => {
  const source = data(), signal = new AbortController().signal;
  const result = await readActionData({ choices: async (target, options) => {
    assert.deepEqual(target, { type: 'vm', id: 'vm-a' }); assert.equal(options.actionId, actionId); assert.equal(options.signal, signal); return source;
  } }, resource, actionId, { signal });
  assert.equal(result.snapshot.id, 'vm-a'); assert.equal(result.choices.snapshot.id, 'vm-other'); result.capabilities[actionId].allowed = false;
  assert.equal(source.capabilities[actionId].allowed, true);
});
for (const change of [value => { value.actionId = 'vm.hardware.disk.add'; }, value => { value.snapshot.id = 'vm-b'; },
  value => { value.snapshot.type = 'host'; }, value => { delete value.snapshot.type; }, value => { value.choices = []; }, value => { value.capabilities = null; }]) {
  test('mismatched or malformed action envelope is rejected before a form can consume it', async () => {
    const source = data(); change(source); await assert.rejects(readActionData({ choices: async () => source }, resource, actionId), /ACTION_CHOICES_INVALID/);
  });
}
test('missing choice bridge and cancellation never fall back to stale resource lists', async () => {
  await assert.rejects(readActionData({ read: async () => data() }, resource, actionId), /ACTION_CHOICES_UNAVAILABLE/);
  const controller = new AbortController(); let calls = 0;
  const bridge = { choices: async () => { calls++; controller.abort(); return data(); } };
  await assert.rejects(readActionData(bridge, resource, actionId, { signal: controller.signal }), /ACTION_READ_CANCELLED/);
  await assert.rejects(readActionData(bridge, resource, actionId, { signal: controller.signal }), /ACTION_READ_CANCELLED/); assert.equal(calls, 1);
});
