import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoActionProvider } from '../demo/action-provider.js';
import { buildActionTree } from '../src/actions/catalog.js';
const resource = { type: 'vm', id: 'ubuntu-demo', name: 'Ubuntu demo' };
async function request(provider, actionId) {
  const data = await provider.read(resource);
  return { resource, actionId, snapshot: data.snapshot, action: buildActionTree({ resource, ...data }).flatMap(group => group.items).find(action => action.id === actionId) };
}
test('demo opens a form without changing mock power state or contacting a transport', async () => {
  let opened = null; const provider = createDemoActionProvider(value => { opened = value; });
  const action = await request(provider, 'vm.power.shutdown');
  await provider.open(action); assert.equal(opened.actionId, action.actionId); assert.equal((await provider.read(resource)).snapshot.status, 'RUNNING');
  provider.confirm(action, {}); assert.equal((await provider.read(resource)).snapshot.status, 'STOPPED');
});
test('demo confirmation rejects stale authority and wrong child identities', async () => {
  const provider = createDemoActionProvider(() => {}), shutdown = await request(provider, 'vm.power.shutdown');
  provider.setReadOnly(true); assert.throws(() => provider.confirm(shutdown, {}), /UNAVAILABLE/);
  provider.setReadOnly(false); provider.setStatus('STOPPED');
  const restore = await request(provider, 'vm.snapshots.restore');
  assert.throws(() => provider.confirm(restore, { snapshotId: 'other-vm-snapshot' }), /SUBRESOURCE_MISMATCH/);
  assert.throws(() => provider.confirm({ ...restore, resource: { ...resource, id: 'other-vm' } }, {}), /RESOURCE_NOT_FOUND/);
});
test('demo snapshot creation changes only its own synthetic list', async () => {
  const provider = createDemoActionProvider(() => {}), create = await request(provider, 'vm.snapshots.create');
  const count = create.snapshot.snapshots.length;
  provider.confirm(create, { name: 'Demo checkpoint' });
  const fresh = await provider.read(resource); assert.equal(fresh.snapshot.snapshots.length, count + 1); assert.equal(fresh.snapshot.snapshots.at(-1).name, 'Demo checkpoint');
});
