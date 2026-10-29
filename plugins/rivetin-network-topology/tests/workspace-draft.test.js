import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceDraft } from '../src/workspace-draft.js';
import { normalizeSnapshot } from '../src/snapshot.js';
import { workspaceSnapshot } from './fixtures/workspace.js';
const now = Date.parse('2026-10-29T06:00:00Z');
function setup(mutate = () => {}) { const value = workspaceSnapshot('cluster-fixture', now); mutate(value); return normalizeSnapshot(value, 'cluster-fixture', now); }

test('network/NIC proposals retain real baseline and host identity; undo and discard never execute transactions', () => {
  const snapshot = setup(), original = JSON.stringify(snapshot), draft = createWorkspaceDraft(snapshot, () => now);
  draft.reparent('net-workload', 'vds-target'); draft.bindNic('nic-fixture', 'vds-target');
  assert.deepEqual(draft.changes(), [{ kind: 'network', id: 'net-workload', from: 'vds-workload', to: 'vds-target' }, { kind: 'nic', id: 'nic-fixture', hostId: 'host-fixture', from: 'vds-workload', to: 'vds-target' }]);
  assert.equal(JSON.stringify(snapshot), original); assert.equal(draft.apply, undefined); assert.equal(draft.rollback, undefined);
  draft.reparent('net-workload', 'vds-workload'); assert.equal(draft.changes().length, 1); draft.clear(); assert.deepEqual(draft.changes(), []);
});
test('protected, mixed, unknown, incomplete, stale and missing identities reject local proposals atomically', () => {
  for (const mutate of [value => { value.complete = false; }, value => { value.switches[1].purpose = null; }, value => { value.switches[1].purpose = 'system'; }, value => { value.switches[1].networks[0].purpose = 'storage'; }, value => { value.switches[2].purpose = 'management'; }]) {
    const draft = createWorkspaceDraft(setup(mutate), () => now); assert.throws(() => draft.reparent('net-workload', 'vds-target'), /NOT_ALLOWED/); assert.deepEqual(draft.changes(), []);
  }
  const draft = createWorkspaceDraft(setup(), () => now);
  assert.throws(() => draft.reparent('net-management', 'vds-target'), /NOT_ALLOWED/); assert.throws(() => draft.bindNic('nic-fixture', 'vds-management'), /NOT_ALLOWED/);
  assert.throws(() => draft.reparent('missing', 'vds-target'), /NOT_ALLOWED/); assert.throws(() => draft.bindNic('missing', 'vds-target'), /NOT_ALLOWED/);
  const stale = createWorkspaceDraft(setup(), () => now + 60000); assert.throws(() => stale.reparent('net-workload', 'vds-target'), /NOT_ALLOWED/);
  const unassigned = createWorkspaceDraft(setup(value => { value.nics[0].switchId = null; }), () => now);
  assert.throws(() => unassigned.bindNic('nic-fixture', 'vds-target'), /NOT_ALLOWED/); assert.deepEqual(unassigned.changes(), []);
});
