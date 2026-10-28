import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './helpers/native-aba-fixture.js';
import { queuedExternalReset } from './helpers/queued-reset.js';

test('020: exact list source rebuilds a new A pane after retained A/B/A without restoring its B callback', async t => {
  const f = await createFixture(); t.after(() => f.dispose());
  await f.cpu(); assert.equal(f.host.counts.freshA, 1); f.doc.querySelector('[data-cancel]').click();
  const oldPane = f.host.pane, oldEditor = oldPane.querySelector('.edit-icon');
  f.host.select('vm-b'); f.host.select('vm-a');
  assert.equal(f.host.pane, oldPane, 'host deliberately retains the DOM and stale B callback');
  await f.cpu();
  assert.equal(f.host.counts.freshA, 2, 'second native editor must be a fresh exact A entry');
  assert.notEqual(f.host.pane, oldPane); assert.equal(oldEditor.isConnected, false);
  assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
  assert.deepEqual(f.errors, []);
});

for (const base of ['#/vms', '#/clusters/cluster-a?view=%22vms%22', '#/hosts/host-a?view=%22vms%22', '#/datacenters/dc-a?view=%22vms%22']) {
  test(`020: verified list sidebar recovery preserves its scope on ${base}`, async t => {
    const f = await createFixture(undefined, { base, staleOnReturn: false, providerTimeoutMs: 400 }); t.after(() => f.dispose());
    await f.cpu(); f.doc.querySelector('[data-cancel]').click();
    const previous = f.host.pane; f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
    assert.equal(f.host.counts.freshA, 2); assert.notEqual(f.host.pane, previous);
    assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
    assert.deepEqual(f.errors, []);
  });
}

for (const base of ['#/unknown?view=%22vms%22', '#/vms/?view=%22vms%22&view=%22vms%22', '#/vms/?action=delete']) {
  test(`020: recovery refuses an unknown or action-shaped list route ${base}`, async t => {
    const f = await createFixture(undefined, { base, providerTimeoutMs: 150 }); t.after(() => f.dispose());
    f.host.select('vm-a'); f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
    assert.equal(f.host.counts.reset, 0); assert.equal(f.host.counts.freshA + f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
  });
}

for (const options of [{ retainOnReset: true }, { moveOldEditor: true }]) {
  test(`020: failed recovery cannot reuse retained or moved retired DOM ${JSON.stringify(options)}`, async t => {
    const f = await createFixture(undefined, { ...options, providerTimeoutMs: 250 }); t.after(() => f.dispose());
    await f.cpu(); f.doc.querySelector('[data-cancel]').click(); f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
    assert.equal(f.host.counts.freshA, 1); assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
    assert.match(f.doc.querySelector('[data-rivetin-native-feedback]')?.textContent || '', /source-retired/);
    f.doc.querySelector('[data-rivetin-native-feedback] button').click();
    assert.equal(f.doc.querySelector('[data-rivetin-native-feedback]'), null);
  });
}

test('020: changing the exact source row during reset invalidates recovery', async t => {
  const f = await createFixture(undefined, { providerTimeoutMs: 200, onReset({ table }) { table.querySelector('[data-row-key="vm-a"]').dataset.rowKey = 'vm-other'; } }); t.after(() => f.dispose());
  await f.cpu(); f.doc.querySelector('[data-cancel]').click(); f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
  assert.equal(f.host.counts.freshA, 1); assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
});

test('020: an external object navigation during owned reset still cancels the operation', async t => {
  const f = await createFixture(undefined, { providerTimeoutMs: 200, onReset({ select }) { select('vm-b'); } }); t.after(() => f.dispose());
  await f.cpu(); f.doc.querySelector('[data-cancel]').click(); f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
  assert.equal(f.host.counts.freshA, 1); assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
});

for (const viaA of [false, true]) test(`020: queued external B/${viaA ? 'A/' : ''}reset must cancel even when current URL equals reset`, async t => {
  const f = await createFixture(undefined, { providerTimeoutMs: 400, onReset: queuedExternalReset(viaA) }); t.after(() => f.dispose());
  await f.cpu(); f.doc.querySelector('[data-cancel]').click(); f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
  assert.equal(f.host.counts.freshA, 1, 'external queued trip must not select a new A editor');
  assert.equal(f.host.counts.navigation, 3, 'no owned row selection after external reset evidence');
  assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
});

test('020: a URL-less history notification cannot replace or invalidate the later exact owned native edge', async t => {
  const f = await createFixture(undefined, { providerTimeoutMs: 400, onReset({ notify }) { notify(); } }); t.after(() => f.dispose());
  await f.cpu(); f.doc.querySelector('[data-cancel]').click(); f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
  assert.equal(f.host.counts.freshA, 2); assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
  assert.deepEqual(f.errors, []);
});

test('020: the same native reset edge cannot be claimed twice before row selection', async t => {
  let sent = false;
  const f = await createFixture(undefined, { providerTimeoutMs: 300, onReset({ win, edge }) {
    if (sent) return; sent = true;
    win.setTimeout(() => win.dispatchEvent(new win.HashChangeEvent('hashchange', edge)), 0);
  } }); t.after(() => f.dispose());
  await f.cpu(); f.doc.querySelector('[data-cancel]').click(); f.host.select('vm-b'); f.host.select('vm-a'); await f.cpu();
  assert.equal(f.host.counts.freshA, 1); assert.equal(f.host.counts.navigation, 3);
  assert.equal(f.host.counts.staleB + f.host.counts.submit + f.transport, 0);
});
