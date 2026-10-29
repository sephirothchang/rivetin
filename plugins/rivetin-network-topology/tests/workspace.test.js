import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mountTopologyWorkspace } from '../src/workspace.js';
import { workspaceSnapshot } from './fixtures/workspace.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div><p id="unrelated">Other content</p></body></html>', { url: 'http://127.0.0.1/' });
  const root = dom.window.document.querySelector('#host'), calls = [], time = Date.now();
  dom.window.fetch = () => { throw new Error('Unexpected direct network call'); };
  const source = options.source || { async listClusters({ signal }) { calls.push({ kind: 'clusters', signal }); return [{ id: 'cluster-fixture', name: 'Fixture Cluster' }]; }, async read({ clusterId, signal }) { calls.push({ kind: 'read', signal }); return workspaceSnapshot(clusterId, time); } };
  const dispose = mountTopologyWorkspace(root, dom.window, { source, initialClusterId: 'cluster-fixture', now: () => time, ...options });
  return { dom, root, calls, dispose, click(text) { const button = [...root.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(button, text); button.click(); }, stop() { dispose(); dom.window.close(); } };
}
test('workspace uses injected source only, renders actual four-column relationships and escapes labels', async () => {
  const ctx = setup({ source: { async listClusters() { return [{ id: 'cluster-fixture', name: '<img src=x onerror=alert(1)>' }]; }, async read({ clusterId }) { const value = workspaceSnapshot(clusterId); value.switches[1].name = '<script>bad()</script>'; return value; } } });
  try {
    await tick(); assert.equal(ctx.root.querySelectorAll('.topo-column').length, 4); assert.equal(ctx.root.querySelectorAll('[data-kind=uplink]').length, 1);
    assert.equal(ctx.root.querySelectorAll('[data-kind=lldp]').length, 1); assert.equal(ctx.root.querySelectorAll('script,img').length, 0); assert.match(ctx.root.textContent, /<script>bad/);
    assert.match(ctx.root.textContent, /资源关系只读/); assert.match(ctx.root.textContent, /unknown/); assert.doesNotMatch(ctx.root.textContent, /active-backup|Demo-Node/);
    assert.equal([...ctx.root.querySelectorAll('button')].find(button => button.textContent === '真实网络应用尚不可用').disabled, true);
  } finally { ctx.stop(); }
});
test('layout keyboard parent/child movement tracks links without mutating resource relationships', async () => {
  const ctx = setup(); try {
    await tick(); ctx.click('编辑布局'); const parent = ctx.root.querySelector('[data-key="vds:vds-workload"]'), child = ctx.root.querySelector('[data-key="network:net-workload"]');
    const x = parseFloat(parent.style.left), childX = parseFloat(child.style.left), link = ctx.root.querySelectorAll('path[data-kind=network]')[1], before = link.getAttribute('d');
    parent.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(parseFloat(parent.style.left), x + 10); assert.equal(parseFloat(child.style.left), childX + 10); assert.notEqual(link.getAttribute('d'), before);
    assert.equal(ctx.calls.filter(call => call.kind === 'read').length, 1); assert.equal(ctx.root.querySelector('.topo-details:not([hidden])'), null);
  } finally { ctx.stop(); }
});
test('local relationship drafts show exact diff, keep actual edges, block reload until explicit discard and never call a write provider', async () => {
  const ctx = setup(); try {
    await tick(); ctx.click('编辑关联草稿'); ctx.root.querySelector('[data-key="network:net-workload"]').click();
    const target = ctx.root.querySelector('.topo-details select'); target.value = 'vds-target'; ctx.click('加入关联草稿');
    assert.match(ctx.root.textContent, /network net-workload: Workload A → Workload B/); assert.equal(ctx.root.querySelectorAll('[data-kind=draft]').length, 1);
    assert.match(ctx.root.textContent, /当前真实虚拟网络迁移未开放/);
    assert.equal(ctx.root.querySelectorAll('path[data-kind=network]').length, 2); assert.equal([...ctx.root.querySelectorAll('button')].find(button => button.textContent === '重新读取').disabled, true);
    ctx.click('丢弃关联草稿'); assert.equal(ctx.root.querySelectorAll('[data-kind=draft]').length, 0); assert.equal(ctx.calls.length, 2);
  } finally { ctx.stop(); }
});
test('incomplete snapshots retain warning, block draft mode and do not invent physical neighbors', async () => {
  const ctx = setup({ source: { async listClusters() { return [{ id: 'cluster-fixture', name: 'Fixture' }]; }, async read({ clusterId }) { const value = workspaceSnapshot(clusterId); value.complete = false; value.peers = []; value.nics[0].peerId = null; return value; } } });
  try { await tick(); assert.match(ctx.root.textContent, /清单不完整/); assert.match(ctx.root.textContent, /物理交换机关系未知/); assert.equal([...ctx.root.querySelectorAll('button')].find(button => button.textContent === '编辑关联草稿').disabled, true); }
  finally { ctx.stop(); }
});
test('source error/timeout use a sanitized failure with no fixture fallback', async () => {
  for (const read of [async () => { throw new Error('secret internal stack'); }, () => new Promise(() => {})]) {
    const ctx = setup({ source: { async listClusters() { return [{ id: 'cluster-fixture', name: 'Fixture' }]; }, read }, timeoutMs: 10 });
    try { await new Promise(resolve => setTimeout(resolve, 25)); assert.match(ctx.root.querySelector('[role=alert]').textContent, /无法读取可信拓扑/); assert.doesNotMatch(ctx.root.textContent, /secret|Demo-Node/); assert.equal(ctx.root.querySelectorAll('.topo-node').length, 0); }
    finally { ctx.stop(); }
  }
});
test('dispose aborts an in-flight read, is idempotent and prevents late content from reappearing', async () => {
  let resolveRead, signal;
  const ctx = setup({ source: { async listClusters() { return [{ id: 'cluster-fixture', name: 'Fixture' }]; }, read(args) { signal = args.signal; return new Promise(resolve => { resolveRead = resolve; }); } } });
  try { await tick(); ctx.dispose(); ctx.dispose(); assert.equal(signal.aborted, true); resolveRead(workspaceSnapshot()); await tick(); assert.equal(ctx.root.childNodes.length, 0); assert.equal(ctx.dom.window.document.querySelector('#unrelated').textContent, 'Other content'); }
  finally { ctx.stop(); }
});
test('native second-cluster entry reads only that cluster and the selector cannot override route context', async () => {
  const reads = [];
  const ctx = setup({ initialClusterId: 'second-cluster', source: { async listClusters() { return [{ id: 'first-cluster', name: 'First' }, { id: 'second-cluster', name: 'Second' }]; }, read({ clusterId }) { reads.push(clusterId); return workspaceSnapshot(clusterId); } } });
  try {
    await tick(); const select = ctx.root.querySelector('select'); assert.deepEqual(reads, ['second-cluster']); assert.equal(select.value, 'second-cluster'); assert.equal(select.disabled, true);
    select.value = 'first-cluster'; select.dispatchEvent(new ctx.dom.window.Event('change')); await tick();
    assert.deepEqual(reads, ['second-cluster']); assert.equal(select.value, 'second-cluster');
  } finally { ctx.stop(); }
});
test('missing or unauthorized entry cluster fails closed instead of falling back to the first allowed cluster', async () => {
  for (const id of [undefined, null, '', 'not-in-list']) {
    const reads = [], ctx = setup({ initialClusterId: id, source: { async listClusters() { return [{ id: 'first-cluster', name: 'First' }]; }, read({ clusterId }) { reads.push(clusterId); return workspaceSnapshot(clusterId); } } });
    try { await tick(); assert.deepEqual(reads, []); assert.match(ctx.root.querySelector('[role=alert]').textContent, /无法读取可信拓扑/); }
    finally { ctx.stop(); }
  }
});
test('dragging an association adds a draft; protected source rejects; dirty lifecycle is reported and signal cleans page', async () => {
  const lifecycle = new AbortController(), dirty = [], ctx = setup({ signal: lifecycle.signal, onDirtyChange: value => dirty.push(value) });
  function connect(id) {
    const event = new ctx.dom.window.Event('dragstart', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { setData() {} } });
    ctx.root.querySelector(`[data-connection-id="${id}"]`).dispatchEvent(event);
    ctx.root.querySelector('[data-key="vds:vds-target"]').dispatchEvent(new ctx.dom.window.Event('drop', { bubbles: true, cancelable: true }));
  }
  try {
    await tick(); ctx.click('编辑关联草稿'); connect('net-management'); assert.match(ctx.root.textContent, /拒绝生成草稿/); assert.deepEqual(dirty, []);
    connect('net-workload'); assert.deepEqual(dirty, [true]); assert.equal(ctx.root.querySelectorAll('path[data-kind=draft]').length, 1);
    lifecycle.abort(); assert.equal(ctx.root.childNodes.length, 0); assert.deepEqual(dirty, [true, false]);
  } finally { ctx.stop(); }
});
test('pointer cancellation restores layout positions, and missing provider fails without making direct requests', async () => {
  const ctx = setup(); try {
    await tick(); ctx.click('编辑布局'); const parent = ctx.root.querySelector('[data-key="vds:vds-workload"]'), x = parent.style.left;
    parent.dispatchEvent(new ctx.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 400, clientY: 250 }));
    ctx.dom.window.dispatchEvent(new ctx.dom.window.MouseEvent('pointermove', { clientX: 450, clientY: 300 })); assert.notEqual(parent.style.left, x);
    ctx.dom.window.dispatchEvent(new ctx.dom.window.Event('pointercancel')); assert.equal(parent.style.left, x);
  } finally { ctx.stop(); }
  const missing = setup({ source: {} }); try { await tick(); assert.match(missing.root.querySelector('[role=alert]').textContent, /无法读取可信拓扑/); assert.equal(missing.root.querySelectorAll('.topo-node').length, 0); }
  finally { missing.stop(); }
});
