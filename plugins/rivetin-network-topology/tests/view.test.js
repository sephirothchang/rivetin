import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mountDemo } from '../src/view.js';
import { createMockTopology } from '../src/mock.js';
import { createMockSession } from '../src/model.js';
import factory from '../src/definition.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
function setup(edit = false) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div id="app"></div></body></html>');
  let now = 0; const session = createMockSession(createMockTopology(), () => now), root = dom.window.document.querySelector('#app');
  const dispose = mountDemo(root, dom.window, { session });
  const click = selector => { const el = root.querySelector(selector); assert.ok(el, selector); el.click(); };
  if (edit) click('[data-action="enter-edit"]');
  return { dom, root, session, click, time: value => { now = value; }, stop: () => { dispose(); dom.window.close(); } };
}
function drag(ctx, from, to) {
  const start = new ctx.dom.window.Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(start, 'dataTransfer', { value: { setData() {}, effectAllowed: '' } });
  ctx.root.querySelector(from).dispatchEvent(start);
  ctx.root.querySelector(to).dispatchEvent(new ctx.dom.window.Event('drop', { bubbles: true, cancelable: true }));
}
function addSpare(ctx, target = 'migration') {
  ctx.click('[data-action="unused"][data-host="host-a"]');
  drag(ctx, '[data-drag-nic="host-a-eth8"]', `[data-drop-bond="${target}"][data-host="host-a"]`);
}
function apply(ctx) { ctx.click('[data-action="review"]'); ctx.click('#ack'); ctx.click('[data-action="apply"]'); }

function pointerEvent(ctx, type, source, x, y) {
  source.dispatchEvent(new ctx.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
}

test('free node movement changes coordinates only, scales correctly and Escape cancels a gesture', t => {
  const ctx = setup(true); t.after(ctx.stop);
  const node = ctx.root.querySelector('[data-anchor="vds:workload"]'), handle = node.querySelector('[data-move-node]');
  const left = parseFloat(node.style.left), top = parseFloat(node.style.top);
  pointerEvent(ctx, 'pointerdown', handle, 100, 100); pointerEvent(ctx, 'pointermove', ctx.root, 175, 130);
  assert.ok(Math.abs(parseFloat(node.style.left) - left - 100) < .001); assert.ok(Math.abs(parseFloat(node.style.top) - top - 40) < .001);
  assert.ok(ctx.root.querySelector('[data-trash]').hidden); assert.equal(ctx.session.review().operationCount, 0);
  handle.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(parseFloat(node.style.left), left); assert.equal(parseFloat(node.style.top), top);
  pointerEvent(ctx, 'pointerdown', handle, 100, 100); pointerEvent(ctx, 'pointermove', ctx.root, 175, 130); pointerEvent(ctx, 'pointerup', ctx.root, 175, 130);
  assert.equal(parseFloat(ctx.root.querySelector('[data-anchor="vds:workload"]').style.left), left + 100);
  assert.equal(ctx.session.review().operationCount, 0);
  ctx.click('[data-action="refresh-view"]'); assert.equal(parseFloat(ctx.root.querySelector('[data-anchor="vds:workload"]').style.left), left);
});

test('keyboard VDS movement carries current child networks with normal and Shift steps', t => {
  const ctx = setup(true); t.after(ctx.stop);
  const node = ctx.root.querySelector('[data-anchor="vds:workload"]'), handle = node.querySelector('[data-move-node]');
  const child = ctx.root.querySelector('[data-anchor="network:net-production"]');
  const unrelated = ctx.root.querySelector('[data-anchor="vds:migration"]'), unrelatedLeft = unrelated.style.left;
  const parentStart = { x: parseFloat(node.style.left), y: parseFloat(node.style.top) }, childStart = { x: parseFloat(child.style.left), y: parseFloat(child.style.top) };
  handle.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  handle.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  assert.equal(parseFloat(node.style.left), parentStart.x + 10); assert.equal(parseFloat(node.style.top), parentStart.y + 40);
  assert.equal(parseFloat(child.style.left), childStart.x + 10); assert.equal(parseFloat(child.style.top), childStart.y + 40);
  assert.equal(parseFloat(child.style.left) - parseFloat(node.style.left), childStart.x - parentStart.x);
  assert.equal(parseFloat(child.style.top) - parseFloat(node.style.top), childStart.y - parentStart.y);
  assert.equal(unrelated.style.left, unrelatedLeft); assert.equal(ctx.session.review().operationCount, 0);
});

test('keyboard VDS boundary uses its clamped delta for children and leaves protected nodes locked', t => {
  const ctx = setup(true); t.after(ctx.stop);
  const node = ctx.root.querySelector('[data-anchor="vds:workload"]'), handle = node.querySelector('[data-move-node]');
  const child = ctx.root.querySelector('[data-anchor="network:net-production"]');
  const left = () => parseFloat(node.style.left), childLeft = () => parseFloat(child.style.left);
  const offset = childLeft() - left();
  for (let i = 0; i < 8; i++) handle.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
  const before = left(), childBefore = childLeft();
  handle.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
  assert.equal(left(), 12); assert.ok(before - left() < 40);
  assert.equal(childLeft() - childBefore, left() - before); assert.equal(childLeft() - left(), offset);
  const stopped = childLeft();
  handle.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
  assert.equal(left(), 12); assert.equal(childLeft(), stopped);
  const protectedNode = ctx.root.querySelector('[data-anchor="vds:storage"]'), protectedLeft = protectedNode.style.left;
  assert.equal(protectedNode.querySelector('[data-move-node]'), null);
  protectedNode.querySelector('.node-heading').dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(protectedNode.style.left, protectedLeft); assert.equal(ctx.session.review().operationCount, 0);
});

test('network connector changes association and review diff; protected parents have no move/connector handles', t => {
  const ctx = setup(true); t.after(ctx.stop);
  for (const id of ['net-management', 'net-default', 'net-storage', 'net-internal']) {
    const net = ctx.root.querySelector(`[data-anchor="network:${id}"]`);
    assert.equal(net.querySelector('[data-drag-network]'), null); assert.equal(net.hasAttribute('data-move-node'), false);
  }
  const net = ctx.root.querySelector('[data-anchor="network:net-production"]'), top = net.style.top;
  drag(ctx, '[data-drag-network="net-production"]', '[data-drop-vds="migration"]');
  assert.equal(ctx.session.review().relations[0].to, 'migration');
  assert.equal(ctx.root.querySelector('[data-anchor="network:net-production"]').style.top, top);
  drag(ctx, '[data-drag-network="net-production"]', '[data-drop-vds="storage"]');
  assert.match(ctx.root.querySelector('.toast').textContent, /保护/); assert.equal(ctx.session.review().relations.length, 1);
  ctx.click('[data-action="review"]'); assert.match(ctx.root.querySelector('.change-list').textContent, /VDS-Workload → VDS-Migration/);
  assert.match(ctx.root.querySelector('.risk-list').textContent, /虚拟网络所属 VDS/);
});

test('trash appears only while dragging a new placed object; drop deletes atomically and pending forbids it', t => {
  const ctx = setup(true); t.after(ctx.stop); ctx.click('[data-palette="network"]');
  ctx.click('[data-action="close-drawer"]');
  const net = ctx.root.querySelector('[data-anchor="network:created-network-1"]');
  pointerEvent(ctx, 'pointerdown', net, 100, 100); pointerEvent(ctx, 'pointermove', ctx.root, 200, 250);
  const trash = ctx.root.querySelector('[data-trash]'); assert.equal(trash.hidden, false);
  ctx.dom.window.document.elementFromPoint = () => trash;
  pointerEvent(ctx, 'pointerup', ctx.root, 100, 600);
  assert.equal(ctx.root.querySelector('[data-anchor="network:created-network-1"]'), null);
  assert.equal(ctx.session.review().operationCount, 1); assert.ok(ctx.root.querySelector('[data-trash]').hidden);
  const vds = ctx.root.querySelector('[data-anchor="vds:created-vds-1"] [data-move-node]');
  pointerEvent(ctx, 'pointerdown', vds, 100, 100); pointerEvent(ctx, 'pointermove', ctx.root, 200, 250);
  ctx.dom.window.document.elementFromPoint = () => ctx.root.querySelector('[data-trash]');
  pointerEvent(ctx, 'pointerup', ctx.root, 100, 600); assert.equal(ctx.session.review().operationCount, 0);
  ctx.click('[data-palette="network"]'); apply(ctx);
  assert.equal(ctx.root.querySelectorAll('[data-move-node], [data-drag-network]').length, 0);
  assert.ok(ctx.root.querySelector('[data-trash]').hidden);
});

test('new VDS trash drop refuses existing children, restores position and reports a repair path', t => {
  const ctx = setup(true); t.after(ctx.stop); ctx.click('[data-palette="vds"]'); ctx.click('[data-action="close-drawer"]');
  drag(ctx, '[data-drag-network="net-production"]', '[data-drop-vds="created-vds-1"]');
  const node = ctx.root.querySelector('[data-anchor="vds:created-vds-1"]'), top = node.style.top;
  pointerEvent(ctx, 'pointerdown', node.querySelector('[data-move-node]'), 100, 100); pointerEvent(ctx, 'pointermove', ctx.root, 200, 250);
  ctx.dom.window.document.elementFromPoint = () => ctx.root.querySelector('[data-trash]');
  pointerEvent(ctx, 'pointerup', ctx.root, 100, 600);
  assert.equal(ctx.root.querySelector('[data-anchor="vds:created-vds-1"]').style.top, top);
  assert.match(ctx.root.querySelector('.toast').textContent, /已有虚拟网络/);
  assert.equal(ctx.session.review().relations.length, 1);
});

test('independent network movement and canceled new-object drags never mutate associations or leak trash UI', t => {
  const ctx = setup(true); t.after(ctx.stop);
  const network = ctx.root.querySelector('[data-anchor="network:net-production"]'), originalLeft = parseFloat(network.style.left);
  const parent = ctx.root.querySelector('[data-anchor="vds:workload"]'), parentLeft = parent.style.left;
  network.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(parseFloat(network.style.left), originalLeft + 10); assert.equal(ctx.session.review().operationCount, 0);
  network.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  assert.equal(parseFloat(network.style.left), originalLeft + 50); assert.equal(parent.style.left, parentLeft);
  const locked = ctx.root.querySelector('[data-anchor="network:net-storage"]'), original = locked.style.top;
  pointerEvent(ctx, 'pointerdown', locked, 100, 100); pointerEvent(ctx, 'pointermove', ctx.root, 500, 500); pointerEvent(ctx, 'pointerup', ctx.root, 500, 500);
  assert.equal(ctx.root.querySelector('[data-anchor="network:net-storage"]').style.top, original);
  ctx.click('[data-palette="vds"]'); ctx.click('[data-action="close-drawer"]');
  const handle = ctx.root.querySelector('[data-anchor="vds:created-vds-1"] [data-move-node]');
  pointerEvent(ctx, 'pointerdown', handle, 100, 100); pointerEvent(ctx, 'pointermove', ctx.root, 200, 200);
  assert.equal(ctx.root.querySelector('[data-trash]').hidden, false);
  ctx.dom.window.document.dispatchEvent(new ctx.dom.window.Event('pointercancel'));
  assert.equal(ctx.root.querySelector('[data-trash]').hidden, true); assert.equal(ctx.session.review().operationCount, 1);
});

test('observed four-column structure: VMs, independent VDS networks, host bonds, LLDP peers; starts read-only', t => {
  const ctx = setup(); t.after(ctx.stop);
  assert.equal(ctx.root.querySelectorAll('.layer').length, 4); assert.equal(ctx.root.querySelectorAll('.vds-card').length, 5);
  assert.equal(ctx.root.querySelectorAll('.virtual-network').length, 6); assert.equal(ctx.root.querySelectorAll('.bond').length, 12);
  assert.equal(ctx.root.querySelectorAll('.peer-card').length, 2); assert.equal(ctx.root.querySelectorAll('[data-nic]').length, 24);
  assert.equal(ctx.root.querySelectorAll('[draggable="true"]').length, 0); assert.equal(ctx.root.querySelectorAll('[data-edge]').length, 44);
});

test('protected management/storage ports and local bridge stay out of edit choices', t => {
  const ctx = setup(true); t.after(ctx.stop);
  assert.equal(ctx.root.querySelectorAll('[data-drag-vds]').length, 2);
  for (const id of ['host-a-eth0','host-a-eth2']) { ctx.click(`[data-nic="${id}"]`); assert.equal(ctx.root.querySelector('#target'), null); }
  ctx.click('[data-nic="host-a-eth4"]'); assert.equal(ctx.root.querySelector('#target option[value="system"]'), null);
  assert.equal(ctx.root.querySelector('#target option[value="storage"]'), null); assert.equal(ctx.root.querySelector('#target option[value="internal"]'), null);
});

test('unused NIC drag targets a same-host bond; cross-host and protected targets are rejected', t => {
  const ctx = setup(true); t.after(ctx.stop); addSpare(ctx);
  assert.equal(ctx.session.review().changes[0].to, 'migration');
  drag(ctx, '[data-drag-nic="host-a-eth8"]', '[data-drop-bond="workload"][data-host="host-b"]');
  assert.match(ctx.root.querySelector('.toast').textContent, /跨主机/); assert.equal(ctx.session.review().changes.length, 1);
  drag(ctx, '[data-drag-nic="host-a-eth4"]', '[data-drop-bond="storage"][data-host="host-a"]');
  assert.match(ctx.root.querySelector('.toast').textContent, /保护/); assert.equal(ctx.session.review().changes.length, 1);
});

test('VDS dropped on one host opens binding review without a bulk swap; other hosts unchanged', t => {
  const ctx = setup(true); t.after(ctx.stop);
  drag(ctx, '[data-drag-vds="workload"]', '[data-drop-host="host-a"]');
  assert.match(ctx.root.querySelector('#dialog-title').textContent, /配置主机上联/); assert.equal(ctx.session.review().changes.length, 0);
  assert.equal(ctx.root.querySelector('[data-bind-nic="host-a-eth0"]'), null);
  ctx.click('[data-bind-nic="host-a-eth8"]'); ctx.click('[data-action="save-binding"]');
  assert.deepEqual(ctx.session.review().changes.map(c => c.hostId), ['host-a']);
  const before = ctx.session.view().current.nics.filter(n => n.hostId !== 'host-a');
  assert.deepEqual(before, ctx.session.view().draft.nics.filter(n => n.hostId !== 'host-a'));
  drag(ctx, '[data-drag-vds="workload"]', '[data-drop-vds="migration"]'); assert.equal(ctx.session.review().changes.length, 1);
});

test('pointer drag is zoom-safe, updates bond and does not suppress immediate risk review', t => {
  const ctx = setup(true); t.after(ctx.stop); ctx.click('[data-action="unused"][data-host="host-a"]');
  const source = ctx.root.querySelector('[data-drag-nic="host-a-eth8"] span'), target = ctx.root.querySelector('[data-drop-bond="migration"][data-host="host-a"]');
  ctx.dom.window.document.elementFromPoint = () => target;
  for (const [type,el,x,y] of [['pointerdown',source,20,30],['pointermove',ctx.root,200,250],['pointerup',ctx.root,200,250]]) el.dispatchEvent(new ctx.dom.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y}));
  assert.equal(ctx.session.review().changes.length, 1); ctx.click('[data-action="review"]'); assert.ok(ctx.root.querySelector('[role="dialog"]'));
});

test('show-lines, folding, zoom and view reset affect presentation without editing bindings', t => {
  const ctx = setup(); t.after(ctx.stop); ctx.click('#show-lines'); assert.equal(ctx.root.querySelectorAll('[data-edge]').length, 0);
  ctx.click('#show-lines'); assert.equal(ctx.root.querySelectorAll('[data-edge]').length, 44);
  ctx.click('[data-fold="host:host-a"]'); assert.equal(ctx.root.querySelectorAll('[data-nic]').length, 16);
  ctx.click('[data-action="zoom-in"]'); assert.ok(ctx.root.querySelector('.zoom-100'));
  ctx.click('[data-action="refresh-view"]'); assert.ok(ctx.root.querySelector('.zoom-75')); assert.equal(ctx.root.querySelectorAll('[data-nic]').length, 24);
  assert.equal(ctx.session.review().changes.length, 0);
});

test('selection preserves canvas scroll and the explicit view reset returns to origin', t => {
  const ctx = setup(); t.after(ctx.stop);
  const viewport = ctx.root.querySelector('.viewport'); viewport.scrollLeft = 180; viewport.scrollTop = 260;
  ctx.click('[data-action="select-vds"][data-vds="system"]');
  assert.equal(ctx.root.querySelector('.viewport').scrollLeft, 180); assert.equal(ctx.root.querySelector('.viewport').scrollTop, 260);
  ctx.click('[data-action="vds-info"]'); assert.match(ctx.root.querySelector('.details-drawer').textContent, /整个 VDS/);
  ctx.click('[data-action="refresh-view"]'); assert.equal(ctx.root.querySelector('.viewport').scrollLeft, 0); assert.equal(ctx.root.querySelector('.viewport').scrollTop, 0);
});

test('left component library offers VDS/network drag sources and keeps physical hardware as read-only legends', t => {
  const ctx = setup(); t.after(ctx.stop);
  assert.equal(ctx.root.querySelectorAll('.palette-item').length, 2);
  assert.ok(ctx.root.querySelector('[data-palette="vds"]').disabled);
  assert.match(ctx.root.querySelector('.inventory-legend').textContent, /物理交换机/);
  ctx.click('[data-action="enter-edit"]'); assert.equal(ctx.root.querySelector('[data-palette="vds"]').disabled, false);
  drag(ctx, '[data-palette="vds"]', '.creation-dropzone');
  assert.equal(ctx.root.querySelectorAll('.vds-card').length, 6);
  assert.equal(ctx.session.review().operationCount, 1); assert.ok(ctx.root.querySelector('.creation-fields'));
  assert.equal(ctx.root.querySelector('[data-action="review"]').disabled, false);
});

test('network component drop uses the target VDS and empty canvas creates its parent atomically', t => {
  const ctx = setup(true); t.after(ctx.stop);
  drag(ctx, '[data-palette="network"]', '[data-drop-vds="workload"]');
  assert.equal(ctx.session.review().creations[0].switchId, 'workload'); assert.equal(ctx.root.querySelector('#created-vlan').value, '120');
  ctx.click('[data-action="discard"]');
  drag(ctx, '[data-palette="network"]', '.creation-dropzone');
  assert.deepEqual(ctx.session.review().creations.map(c => c.kind), ['vds', 'network']);
  assert.equal(ctx.root.querySelectorAll('.created-object').length, 1); assert.equal(ctx.root.querySelectorAll('.created-network').length, 1);
  ctx.root.querySelector('#created-name').value = 'new-vm-network'; ctx.root.querySelector('#created-vlan').value = '210';
  ctx.click('[data-action="update-created"]'); assert.equal(ctx.session.review().creations[1].vlan, 210);
});

test('palette drop cannot add networks to protected VDS or create hardware on a host card', t => {
  const ctx = setup(true); t.after(ctx.stop);
  drag(ctx, '[data-palette="network"]', '[data-drop-vds="storage"]');
  assert.equal(ctx.session.review().operationCount, 0); assert.match(ctx.root.querySelector('.toast').textContent, /保护/);
  drag(ctx, '[data-palette="vds"]', '[data-drop-host="host-a"]');
  assert.equal(ctx.session.review().operationCount, 0); assert.match(ctx.root.querySelector('.toast').textContent, /空白/);
});

test('creation-only dirty state warns on exit, reviews object additions, and times out with stale details cleared', t => {
  const ctx = setup(true); t.after(ctx.stop); ctx.click('[data-palette="network"]');
  ctx.click('[data-action="exit-edit"]'); assert.ok(ctx.root.querySelector('[data-action="review-exit"]'));
  ctx.click('[data-action="close-modal"]');
  const event = new ctx.dom.window.Event('beforeunload', { cancelable: true }); ctx.dom.window.dispatchEvent(event); assert.ok(event.defaultPrevented);
  ctx.click('[data-action="review"]'); assert.match(ctx.root.querySelector('.change-list').textContent, /创建 VDS/);
  assert.match(ctx.root.querySelector('.risk-list').textContent, /未关联|尚未关联/);
  ctx.click('#ack'); ctx.click('[data-action="apply"]'); assert.equal(ctx.root.querySelector('#seconds').textContent, '90');
  ctx.time(90_000); ctx.dom.window.document.dispatchEvent(new ctx.dom.window.Event('visibilitychange'));
  assert.equal(ctx.root.querySelectorAll('.vds-card').length, 5); assert.equal(ctx.root.querySelector('.details-drawer'), null);
});

test('review acknowledgement, pending lock, retained diff and confirm are explicit', t => {
  const ctx = setup(true); t.after(ctx.stop); addSpare(ctx); ctx.click('[data-action="review"]');
  assert.ok(ctx.root.querySelector('[data-action="apply"]').disabled); assert.match(ctx.root.querySelector('.risk-list').textContent, /中断/);
  ctx.click('#ack'); ctx.click('[data-action="apply"]'); assert.equal(ctx.root.querySelector('#seconds').textContent, '90');
  assert.equal(ctx.root.querySelectorAll('[draggable="true"]').length, 0); assert.match(ctx.root.querySelector('#transaction').textContent, /等待人工二次确认/);
  ctx.click('[data-action="confirm"]'); assert.equal(ctx.session.view().outcome, 'confirmed'); assert.match(ctx.root.querySelector('#transaction').textContent, /人工二次确认/);
});

test('MTU blocker has no acknowledgement bypass; manual rollback and visibility timeout restore', t => {
  const ctx = setup(true); t.after(ctx.stop); ctx.click('[data-action="unused"][data-host="host-a"]');
  drag(ctx, '[data-drag-nic="host-a-eth9"]', '[data-drop-bond="workload"][data-host="host-a"]'); ctx.click('[data-action="review"]');
  assert.match(ctx.root.querySelector('.risk-list').textContent, /MTU/); assert.equal(ctx.root.querySelector('#ack'), null);
  assert.ok(ctx.root.querySelector('[data-action="apply"]').disabled); ctx.click('[data-action="close-modal"]'); ctx.click('[data-action="discard"]');
  drag(ctx, '[data-drag-nic="host-a-eth8"]', '[data-drop-bond="migration"][data-host="host-a"]'); apply(ctx); ctx.click('[data-action="cancel"]');
  assert.deepEqual(ctx.session.view().current, createMockTopology());
  drag(ctx, '[data-drag-nic="host-a-eth8"]', '[data-drop-bond="migration"][data-host="host-a"]'); apply(ctx); ctx.time(90_000);
  ctx.dom.window.document.dispatchEvent(new ctx.dom.window.Event('visibilitychange')); assert.equal(ctx.session.view().outcome, 'timeout');
});

test('leaving draft offers cancel/discard/save; locale follows host; dispose rolls back and removes UI', async () => {
  const ctx = setup(true); addSpare(ctx); ctx.click('[data-action="exit-edit"]');
  assert.ok(ctx.root.querySelector('[data-action="discard-exit"]')); assert.ok(ctx.root.querySelector('[data-action="review-exit"]'));
  ctx.click('[data-action="close-modal"]'); assert.equal(ctx.session.review().changes.length, 1);
  const event = new ctx.dom.window.Event('beforeunload',{cancelable:true}); ctx.dom.window.dispatchEvent(event); assert.ok(event.defaultPrevented);
  ctx.dom.window.document.documentElement.lang = 'en-US'; await new Promise(resolve => setTimeout(resolve,0));
  assert.match(ctx.root.textContent, /Distributed switches/); assert.match(ctx.root.textContent, /Physical switches/);
  ctx.session.apply(true); ctx.stop(); assert.equal(ctx.root.children.length, 0); assert.deepEqual(ctx.session.view().current, createMockTopology());
});

test('Rivetin package entry is dormant, exposes shared config contract and performs no topology calls', async () => {
  const dom = new JSDOM('', { url: 'http://127.0.0.1/' });
  let loads = 0;
  const definition = factory({ React: { createElement: (tag, props, text) => ({ tag, text }) }, win: dom.window,
    options: { configurationBackend: () => ({ load: async () => { loads++; return { revision: 0, updatedAt: null, settings: {} }; } }) } });
  assert.equal(definition.id, 'rivetin-network-topology');
  assert.equal(typeof definition.activate(), 'function'); definition.activate()();
  assert.match(definition.Settings({ locale: 'en-US' }).text, /not implemented/);
  await definition.store.load(); assert.equal(loads, 1); assert.equal(definition.store.status().dirty, false);
  definition.store.dispose(); dom.window.close();
});
