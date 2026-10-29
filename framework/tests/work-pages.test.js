import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installUiContributions } from '../src/ui-contributions.js';
import { createTowerWorkPageHost } from '../src/tower-workpage-host.js';
import { readUiContributions } from '../shared/ui-contributions.js';

const fixture = `<main><aside><ul class="ant-menu-root" role="menu"><li class="ant-menu-item-group"><ul><li class="ant-menu-item-selected"><a href="#/everoute/service">服务</a></li></ul></li><li class="split ant-menu-item-group"><ul><li><button>设置</button></li></ul></li></ul></aside><main class="ant-layout-content" aria-label="native">Native content</main></main>`;
const manifest = { name: { 'zh-CN': '安全策略转换', 'en-US': 'Policy converter' }, compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.6' } };
const entry = (id = 'rivetin-example') => ({ id, packageId: 'example-package', manifest, ui: { schemaVersion: 1, pages: [{ id: 'main', Component() {} }], actions: [], contributions: [{ id: 'open', slot: 'everoute.navigation.tools', label: { 'zh-CN': '安全策略转换', 'en-US': 'Policy converter' }, target: { type: 'page', id: 'main' } }] } });
const settle = () => new Promise(setImmediate);
function setup(t, html = fixture, initial = { pathname: '/everoute/overview', search: '' }) {
  const dom = new JSDOM(html, { url: 'https://tower.example.invalid/#' + initial.pathname + initial.search });
  const { window: win } = dom, listeners = new Set(), blockers = new Set(), mounts = [], statuses = [];
  const history = { location: initial,
    listen(fn) { listeners.add(fn); return () => listeners.delete(fn); }, block(fn) { blockers.add(fn); return () => blockers.delete(fn); },
    push(next) { go(next, 'PUSH'); }, replace(next) { go(next, 'REPLACE'); }, pop(next) { go(next, 'POP'); } };
  function go(next, action) { if ([...blockers].some(fn => fn(next, action) === false)) return; history.location = next; win.history.replaceState({}, '', '#' + next.pathname + next.search); for (const fn of listeners) fn(next, action); }
  const host = createTowerWorkPageHost(win);
  const pages = installUiContributions({ win, history, resolveHost: host, onStatus: value => statuses.push(value), renderPage(e, root, props, controls) {
    const view = { entry: e, root, props, controls, disposed: false, update(next) { this.props = next; }, dispose() { this.disposed = true; } }; mounts.push(view); root.textContent = 'Example page'; return view;
  } });
  t.after(() => { pages.dispose(); dom.window.close(); });
  return { win, history, pages, host, mounts, statuses, listeners, blockers };
}

test('legacy UI is unavailable while Settings plugins without UI stay valid', () => {
  assert.equal(readUiContributions({}, manifest).status, 'none');
  assert.equal(readUiContributions({ workPage: {} }, manifest).code, 'UI_LEGACY_WORKPAGE_UNAVAILABLE');
  assert.equal(readUiContributions(entry(), manifest).status, 'registered');
});

test('native Everoute locator matches observed separate groups/button and rejects ambiguous or unrelated content', t => {
  const f = setup(t); assert.ok(f.host('everoute.navigation.tools')); assert.equal(f.host('unknown'), null);
  const clone = f.win.document.querySelector('main.ant-layout-content').cloneNode(true); f.win.document.body.append(clone); assert.equal(f.host('everoute.navigation.tools'), null); clone.remove();
  f.history.push({ pathname: '/overview', search: '' }); assert.equal(f.host('everoute.navigation.tools'), null);
});

test('single navigation entry mounts right content, preserves left navigation, and restores exact native attributes', async t => {
  const f = setup(t), original = f.win.document.body.innerHTML; f.pages.sync([entry()], 'zh-CN'); f.pages.sync([entry()], 'zh-CN');
  assert.equal(f.win.document.querySelectorAll('[data-rivetin-ui-contribution]').length, 1);
  const menu = f.win.document.querySelector('[role="menu"]'); assert.equal(menu.children[1].textContent, '安全策略转换');
  menu.querySelector('[data-rivetin-ui-contribution]').click(); await settle();
  assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].props.active, true); assert.equal(f.mounts[0].props.context.clusterId, null);
  assert.equal(f.win.document.querySelector('main.ant-layout-content').hidden, true); assert.equal(menu.closest('[hidden]'), null);
  assert.equal(f.win.document.querySelectorAll('[data-rivetin-workpage]').length, 1);
  f.mounts[0].controls.close(); await settle(); assert.equal(f.mounts[0].props.signal.aborted, true); assert.equal(f.mounts[0].disposed, true);
  f.pages.dispose(); assert.equal(f.win.document.body.innerHTML, original); assert.equal(f.listeners.size, 0); assert.equal(f.blockers.size, 0);
});

test('cancel keeps dirty page and signal; discard permits route transition and does not call configuration save', async t => {
  const f = setup(t); f.pages.sync([entry()], 'zh-CN'); f.win.document.querySelector('[data-rivetin-ui-contribution]').click(); await settle();
  const view = f.mounts[0], signal = view.props.signal; view.props.onDirtyChange(true);
  f.history.push({ pathname: '/everoute/service', search: '' });
  assert.ok(f.win.document.querySelector('[role="alertdialog"]')); assert.equal(signal.aborted, false);
  f.win.document.querySelector('[data-rv-workpage-cancel]').click(); assert.equal(signal.aborted, false); assert.equal(view.disposed, false); assert.equal(f.history.location.pathname, '/everoute/overview');
  f.history.pop({ pathname: '/everoute/service', search: '' }); f.win.document.querySelector('[data-rv-workpage-discard]').click(); await settle();
  assert.equal(signal.aborted, true); assert.equal(view.disposed, true); assert.equal(f.history.location.pathname, '/everoute/service');
});

test('security disable bypasses dirty guard, cancels page, removes entry and isolates stale callbacks', async t => {
  const f = setup(t); f.pages.sync([entry()], 'zh-CN'); f.win.document.querySelector('[data-rivetin-ui-contribution]').click(); await settle();
  const old = f.mounts[0]; old.props.onDirtyChange(true); f.pages.sync([], 'zh-CN'); await settle();
  assert.equal(old.props.signal.aborted, true); assert.equal(f.win.document.querySelector('[role="alertdialog"]'), null); assert.equal(f.win.document.querySelector('[data-rivetin-ui-contribution]'), null);
  f.pages.sync([entry()], 'zh-CN'); await settle(); const next = f.mounts.at(-1); old.props.onDirtyChange(true); next.controls.close(); await settle();
  assert.equal(next.disposed, true); assert.equal(f.win.document.querySelector('[role="alertdialog"]'), null);
});

test('locale update preserves session while changing owned label and component props', async t => {
  const f = setup(t); f.pages.sync([entry()], 'zh-CN'); f.win.document.querySelector('[data-rivetin-ui-contribution]').click(); await settle();
  const view = f.mounts[0]; f.pages.sync([entry()], 'en-US'); await settle();
  assert.equal(f.mounts.length, 1); assert.equal(view.props.locale, 'en-US'); assert.equal(view.props.signal.aborted, false); assert.equal(f.win.document.querySelector('[data-rivetin-ui-contribution]').textContent, 'Policy converter');
});

test('cluster topology action is confined to exact view, carries only cluster context, and replaces only canvas', async t => {
  const html = '<main><aside>Cluster tree</aside><div><div class="tab-bar">Tabs</div><div><div id="networkTopology" class="react-flow"><div class="right item"><div class="show-line"><input type="checkbox"></div><span class="refresh-wrapper"></span></div></div></div></div></main>';
  const f = setup(t, html, { pathname: '/clusters/example-cluster', search: '?view=%22networkTopology%22' });
  const item = entry('rivetin-network-topology'); item.ui.contributions[0].slot = 'cluster-network-topology.toolbar.actions'; item.ui.contributions[0].label = { 'zh-CN': '可视化编辑', 'en-US': 'Visual editor' }; f.pages.sync([item], 'zh-CN');
  const button = f.win.document.querySelector('[data-rivetin-ui-contribution]'); assert.equal(button.textContent, '可视化编辑'); button.click(); await settle();
  assert.equal(f.mounts[0].props.context.clusterId, 'example-cluster'); assert.equal(f.win.document.querySelector('.tab-bar').closest('[hidden]'), null); assert.equal(f.win.document.getElementById('networkTopology').hidden, true);
  f.history.push({ pathname: '/clusters/second-cluster', search: f.history.location.search }); await settle();
  assert.equal(f.mounts[0].disposed, true); assert.equal(f.mounts.at(-1).props.context.clusterId, 'second-cluster');
  f.history.push({ pathname: '/clusters/second-cluster', search: '?view=%22detail%22' }); await settle(); assert.equal(f.win.document.querySelector('[data-rivetin-ui-contribution]'), null);
});

test('native content disappears or becomes ambiguous without hiding another surface', async t => {
  const f = setup(t); f.pages.sync([entry()], 'zh-CN'); f.win.document.querySelector('[data-rivetin-ui-contribution]').click(); await settle();
  const clone = f.win.document.querySelector('main.ant-layout-content').cloneNode(true); clone.removeAttribute('data-rivetin-workpage-native'); clone.removeAttribute('hidden'); clone.removeAttribute('aria-hidden'); f.win.document.body.append(clone); await settle();
  assert.equal(f.mounts[0].disposed, true); assert.equal(clone.hidden, false); assert.equal(f.win.document.querySelector('[data-rivetin-workpage]'), null);
});

test('third plugin contributes through descriptors only with stable sorting and shared-page aliases', async t => {
  const f = setup(t), a = entry('rivetin-alpha'), b = entry('rivetin-beta'), third = entry('rivetin-third');
  a.ui.contributions[0].order = 1; b.ui.contributions[0].order = 1; third.ui.contributions[0].order = -1;
  a.ui.contributions.push({ ...a.ui.contributions[0], id: 'alias', label: { 'zh-CN': '别名', 'en-US': 'Alias' } });
  f.pages.sync([b, a, third], 'zh-CN');
  const keys = () => [...f.win.document.querySelectorAll('[data-rivetin-ui-contribution]')].map(x => x.getAttribute('data-rivetin-ui-contribution'));
  assert.deepEqual(keys(), ['rivetin-third:open', 'rivetin-alpha:alias', 'rivetin-alpha:open', 'rivetin-beta:open']);
  f.pages.sync([third, b, a], 'en-US'); assert.deepEqual(keys(), ['rivetin-third:open', 'rivetin-alpha:alias', 'rivetin-alpha:open', 'rivetin-beta:open']);
  f.win.document.querySelector('[data-rivetin-ui-contribution="rivetin-alpha:alias"]').click(); await settle();
  const view = f.mounts[0]; view.props.onDirtyChange(true);
  f.win.document.querySelector('[data-rivetin-ui-contribution="rivetin-alpha:open"]').click(); await settle();
  assert.equal(f.mounts.length, 1); assert.equal(view.props.signal.aborted, false); assert.equal(f.win.document.querySelector('[role="alertdialog"]'), null);
  assert.equal(new URLSearchParams(f.history.location.search).get('rivetinPage'), 'rivetin-alpha:main');
});

test('same action aliases share an in-flight key and disable cancels without late failure UI', async t => {
  const f = setup(t), item = entry(); let calls = 0, signal, reject;
  item.ui.pages = []; item.ui.actions = [{ id: 'inspect', run(input) { calls++; signal = input.signal; assert.deepEqual(Object.keys(input).sort(), ['context', 'locale', 'signal']); return new Promise((resolve, no) => { reject = no; }); } }];
  item.ui.contributions[0].target = { type: 'action', id: 'inspect' }; item.ui.contributions.push({ ...item.ui.contributions[0], id: 'alias' });
  f.pages.sync([item], 'zh-CN'); const buttons = [...f.win.document.querySelectorAll('[data-rivetin-ui-contribution]')];
  buttons[0].click(); buttons[1].click(); await settle(); assert.equal(calls, 1); assert.ok(buttons.every(x => x.disabled));
  f.pages.sync([item], 'en-US'); assert.equal(signal.aborted, false); assert.ok(buttons.every(x => x.disabled));
  f.pages.sync([], 'en-US'); assert.equal(signal.aborted, true); reject(new Error('EXAMPLE_PRIVATE_ERROR')); await settle();
  assert.equal(f.statuses.includes('UI_ACTION_FAILED'), false); assert.equal(f.win.document.querySelector('[data-rivetin-ui-contribution]'), null);
});

test('deep links require explicit page/slot eligibility; no legacy alias or arbitrary first page', async t => {
  const f = setup(t); f.pages.sync([entry()], 'zh-CN');
  f.history.push({ pathname: '/everoute/overview', search: '?keep=yes&rivetinPage=rivetin-example' }); await settle();
  assert.equal(f.mounts.length, 0); assert.equal(f.win.document.querySelector('main.ant-layout-content').hidden, false); assert.ok(f.statuses.includes('UI_PAGE_TARGET_UNAVAILABLE'));
  f.history.push({ pathname: '/everoute/overview', search: '?keep=yes&rivetinPage=rivetin-example%3Amain' }); await settle();
  assert.equal(f.mounts.length, 1); assert.equal(new URLSearchParams(f.history.location.search).get('keep'), 'yes');
  f.mounts[0].controls.close(); const hidden = entry(); hidden.ui.contributions[0].visibility = { requiresContext: ['clusterId'] };
  f.pages.sync([hidden], 'zh-CN'); assert.equal(f.win.document.querySelector('[data-rivetin-ui-contribution]'), null);
  f.history.push({ pathname: '/everoute/overview', search: '?rivetinPage=rivetin-example%3Amain' }); await settle(); assert.equal(f.win.document.querySelector('main.ant-layout-content').hidden, false);
});

test('package replacement cancels old action and next package can run without old settlement unlocking it', async t => {
  const f = setup(t), item = entry(); let oldSignal, oldResolve, newCalls = 0;
  item.ui.pages = []; item.ui.actions = [{ id: 'run', run({ signal }) { oldSignal = signal; return new Promise(resolve => { oldResolve = resolve; }); } }]; item.ui.contributions[0].target = { type: 'action', id: 'run' };
  f.pages.sync([item], 'zh-CN'); f.win.document.querySelector('button[data-rivetin-ui-contribution]').click(); await settle();
  const next = { ...item, packageId: 'new-package', ui: { ...item.ui, actions: [{ id: 'run', async run() { newCalls++; } }] } };
  f.pages.sync([next], 'zh-CN'); assert.equal(oldSignal.aborted, true); f.win.document.querySelector('button[data-rivetin-ui-contribution]').click(); oldResolve(); await settle(); assert.equal(newCalls, 1);
});

test('global contribution cap is deterministic and never destroys an already open dirty page', async t => {
  const f = setup(t), current = entry('rivetin-zz'); f.pages.sync([current], 'zh-CN'); f.win.document.querySelector('[data-rivetin-ui-contribution]').click(); await settle();
  const view = f.mounts[0]; view.props.onDirtyChange(true);
  const many = Array.from({ length: 9 }, (_, i) => { const row = entry('rivetin-p' + i); row.ui.contributions = Array.from({ length: 16 }, (_, j) => ({ ...row.ui.contributions[0], id: 'open-' + j })); return row; });
  f.pages.sync([current, ...many.reverse()], 'zh-CN'); await settle();
  assert.equal(f.win.document.querySelectorAll('[data-rivetin-ui-contribution]').length, 128); assert.equal(f.mounts.length, 1); assert.equal(view.props.signal.aborted, false); assert.ok(f.statuses.includes('UI_CONTRIBUTION_LIMIT'));
});
