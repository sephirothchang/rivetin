import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installContextMenu } from '../src/menu.js';
import { defaults } from '../src/configuration.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const frame = '<aside class="frame"><div class="title-wrapper"><span class="header-title">Twin VM</span></div><div class="toolbar"><button id="power">关机</button></div><section><header>磁盘<button class="edit-icon" id="edit">编辑</button></header><div class="disk-item"><div class="ant-collapse-header" id="disk">Disk 1</div></div></section></aside>';
const url = id => 'https://tower.example.invalid/#/vms?sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id, view: 'detail' }));
function fixture(t, { initial = 'vm-b', bridge = true } = {}) {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td unique="name" id="target">Twin VM</td></tr></table>' + frame, { url: url(initial) }), win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  let notified, unlistens = 0, wrongCalls = 0, correctCalls = 0;
  doc.querySelector('#power').onclick = doc.querySelector('#edit').onclick = () => wrongCalls++;
  const history = bridge ? { listen: fn => { notified = fn; return () => unlistens++; } } : undefined;
  const store = { get: defaults, status: () => ({ loaded: true }), subscribe: () => () => {} };
  const stop = installContextMenu({ win, store, history });
  // These controls were rendered while the subscribed initial route was current.
  doc.querySelector('.frame').outerHTML = frame;
  doc.querySelector('#power').onclick = doc.querySelector('#edit').onclick = () => wrongCalls++;
  t.after(() => { stop(); win.close(); });
  function route(id) { win.history.replaceState({}, '', url(id)); }
  function open(selector = '#target') { doc.querySelector(selector).dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }
  const action = text => [...doc.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.includes(text));
  function fresh() { doc.querySelector('.frame').outerHTML = frame; doc.querySelector('#power').onclick = () => correctCalls++; }
  if (bridge) { open('.header-title'); assert.ok(action('关机'), 'precondition: current controls are usable before navigation'); }
  return { win, doc, route, open, action, fresh, notify: () => notified(), stop, counts: () => ({ wrongCalls, correctCalls, unlistens }) };
}
for (const event of ['popstate', 'hashchange', 'host-history', 'silent']) test(`same-name navigation via ${event} cannot dispatch old toolbar handlers`, t => {
  const f = fixture(t); f.route('vm-a');
  if (event === 'host-history') f.notify();
  else if (event !== 'silent') f.win.dispatchEvent(new f.win.Event(event));
  f.open(); assert.equal(f.action('关机'), undefined); assert.equal(f.counts().wrongCalls, 0);
  f.fresh(); f.open(); f.action('关机').click(); assert.equal(f.counts().correctCalls, 1); assert.equal(f.counts().wrongCalls, 0);
});
for (const event of ['popstate', 'hashchange', 'host-history']) test(`queued ${event} during A-B-A quarantines reused controls even at the original URL`, t => {
  const f = fixture(t, { initial: 'vm-a' }); f.route('vm-b'); f.route('vm-a');
  if (event === 'host-history') f.notify();
  else if (event === 'hashchange') f.win.dispatchEvent(new f.win.HashChangeEvent(event, { oldURL: url('vm-a'), newURL: url('vm-b') }));
  else f.win.dispatchEvent(new f.win.PopStateEvent(event));
  f.open(); assert.equal(f.action('关机'), undefined); assert.equal(f.counts().wrongCalls, 0);
});
test('a stale saved native callback cannot execute after host navigation', t => {
  const f = fixture(t, { initial: 'vm-a' }); f.fresh(); f.open(); const old = f.action('关机'); assert.ok(old);
  f.route('vm-b'); f.route('vm-a'); f.notify(); old.click(); assert.equal(f.counts().wrongCalls, 0); assert.equal(f.counts().correctCalls, 0);
});
test('internal device editors are quarantined with the parent toolbar', t => {
  const f = fixture(t); f.route('vm-a'); f.notify(); f.open('#disk');
  assert.equal(f.action('配置'), undefined); assert.equal(f.action('展开详情'), undefined); assert.equal(f.counts().wrongCalls, 0);
});
test('without a host history subscription only safe navigation and copy entries are offered', t => {
  const f = fixture(t, { initial: 'vm-a', bridge: false }); f.route('vm-b'); f.route('vm-a'); f.open();
  assert.equal(f.action('关机'), undefined); assert.equal(f.action('显示可用操作'), undefined); assert.ok(f.action('打开详情'));
  assert.equal(f.counts().wrongCalls, 0);
});
test('stopping the plugin unsubscribes host history exactly once', t => {
  const f = fixture(t); f.stop(); f.stop(); assert.equal(f.counts().unlistens, 1);
});
for (const phase of ['initial activation', 'plugin re-enable', 'framework emergency recovery']) test(`${phase} quarantines a toolbar that predates the history subscription`, t => {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td unique="name" id="target">Twin VM</td></tr></table>' + frame, { url: url('vm-b') }), win = dom.window, doc = win.document;
  win.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }];
  let wrongCalls = 0;
  doc.querySelector('#power').onclick = doc.querySelector('#edit').onclick = () => wrongCalls++;
  const args = { win, store: { get: defaults, status: () => ({ loaded: true }), subscribe: () => () => {} }, history: { listen: () => () => {} } };
  if (phase !== 'initial activation') { const previousStop = installContextMenu(args); previousStop(); }
  win.history.replaceState({}, '', url('vm-a'));
  const stop = installContextMenu(args); t.after(() => { stop(); win.close(); });
  const open = selector => doc.querySelector(selector).dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const actions = () => [...doc.querySelectorAll('[role="menuitem"]')];
  open('#target'); assert.ok(!actions().some(node => node.textContent.includes('关机'))); assert.ok(actions().some(node => node.textContent.includes('打开详情')));
  open('#disk'); assert.ok(!actions().some(node => /配置|展开详情/.test(node.textContent))); assert.equal(wrongCalls, 0);
});
