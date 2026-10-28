import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderSnapshotList } from '../src/actions/snapshot-list.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
test('snapshot list shows exact VM-owned IDs as text without mutation controls', t => {
  const dom = new JSDOM(); t.after(() => dom.window.close());
  const list = renderSnapshotList(dom.window.document, { id: 'vm-a', snapshots: [{ id: 'snap-a', name: '<img onerror=example>', vm: { id: 'vm-a' } }] });
  assert.equal(list.querySelectorAll('tbody tr').length, 1); assert.equal(list.querySelectorAll('button,input,img').length, 0);
  assert.ok(list.textContent.includes('<img onerror=example>')); assert.ok(list.textContent.includes('snap-a'));
});
test('snapshot list distinguishes empty lists, pending items and unverified ownership', t => {
  const dom = new JSDOM(); t.after(() => dom.window.close()); const doc = dom.window.document;
  assert.ok(renderSnapshotList(doc, { id: 'vm-a', snapshots: [] }, 'en-US').textContent.includes('no snapshots'));
  assert.ok(renderSnapshotList(doc, { id: 'vm-a', snapshots: [{ id: 'snap-a', vm: { id: 'vm-a' }, entityAsyncStatus: 'UPDATING' }] }).textContent.includes('变更中'));
  for (const snapshots of [undefined, [{ id: 'snap-a' }], [{ id: 'snap-a', vm: { id: 'vm-b' } }], Array(2).fill({ id: 'snap-a', vm: { id: 'vm-a' } })]) {
    assert.throws(() => renderSnapshotList(doc, { id: 'vm-a', snapshots }), /SNAPSHOT_LIST_UNVERIFIED/);
  }
});
