import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNativeActionProvider } from '../src/native/provider.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const list = 'https://tower.example.invalid/#/clusters/cluster-a?view=%22vms%22';
const target = { type: 'vm', id: 'vm-a', name: 'VM A' };
const titles = { basic: '编辑虚拟机', disk: '编辑磁盘', nic: '编辑虚拟机的网络设备', migration: '迁移虚拟机' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(t, options = {}) {
  const dom = new JSDOM('<table><tr data-row-key="vm-a"><td unique="name">VM A</td></tr></table>', { url: list });
  const win = dom.window, doc = win.document, row = doc.querySelector('tr'), source = doc.querySelector('td');
  win.HTMLElement.prototype.getClientRects = () => [{ width: 10, height: 10 }];
  const counts = { navigate: 0, entry: 0, submit: 0, fields: 0, http: 0, guide: 0 }, listeners = new Set(), pulses = new Set(), observers = new Set();
  const BaseObserver = win.MutationObserver, interval = win.setInterval.bind(win), clear = win.clearInterval.bind(win);
  win.MutationObserver = class extends BaseObserver { constructor(fn) { super(fn); observers.add(this); } disconnect() { observers.delete(this); super.disconnect(); } };
  win.setInterval = (...args) => { const id = interval(...args); pulses.add(id); return id; };
  win.clearInterval = id => { pulses.delete(id); clear(id); };
  win.fetch = () => { counts.http++; throw new Error('NO_RESOURCE_TRANSPORT'); };
  const history = { listen(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const route = (id = 'vm-a', view = 'detail') => {
    win.history.replaceState({}, '', '#/clusters/cluster-a?view=%22vms%22&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id, view })));
    for (const fn of [...listeners]) fn();
  };
  function modal(intent, title = titles[intent]) {
    const node = doc.createElement('section'); node.className = 'ant-modal';
    node.innerHTML = '<h2 class="ant-modal-title"></h2><input><button>保存</button><button>取消</button>';
    node.querySelector('h2').textContent = title;
    const field = node.querySelector('input'); Object.defineProperty(field, 'value', { get() { counts.fields++; throw new Error('NO_FIELD_READ'); }, set() { counts.fields++; throw new Error('NO_FIELD_WRITE'); } });
    node.querySelector('button').onclick = () => counts.submit++; doc.body.append(node); return node;
  }
  function pane({ explicitId, name = 'VM A', disabled = false, duplicate = false, onEntry } = {}) {
    const node = doc.createElement('aside'); node.className = 'drawer-content-inner';
    if (explicitId) node.dataset.resourceId = explicitId;
    node.innerHTML = '<div class="frame"><div class="title-wrapper"><span class="header-title"></span></div><div class="toolbar"><button title="迁移"><svg data-testid="Migrate16GradientBlueIcon"></svg>迁移</button></div></div><div class="detail-tabs"><span class="tab-item active">详情</span><span class="tab-item">快照</span></div>';
    node.querySelector('.header-title').textContent = name;
    for (const [intent, title] of [['basic', '基本信息'], ['disk', '磁盘'], ['nic', '网络设备']]) {
      const section = doc.createElement('div'); section.innerHTML = `${title}<span class="extra-action"><button class="edit-icon">编辑</button></span>`;
      section.querySelector('button').disabled = disabled;
      section.querySelector('button').onclick = () => { counts.entry++; onEntry ? onEntry(intent, node) : modal(intent); };
      node.append(section);
      if (duplicate && intent === 'basic') node.append(section.cloneNode(true));
    }
    const migration = node.querySelector('.toolbar button'); migration.disabled = disabled;
    migration.onclick = () => { counts.entry++; onEntry ? onEntry('migration', node) : modal('migration'); };
    node.querySelectorAll('.tab-item')[1].onclick = () => {
      counts.entry++; route('vm-a', 'snapshot'); node.querySelectorAll('.tab-item')[0].classList.remove('active'); node.querySelectorAll('.tab-item')[1].classList.add('active');
    };
    doc.body.append(node); return node;
  }
  let selectedPane;
  source.onclick = () => {
    counts.navigate++;
    const navigate = () => { route(); row.classList.add('active-row'); if (options.navigate) options.navigate({ pane, route, modal }); else selectedPane = pane(options); };
    if (options.delay) win.setTimeout(navigate, options.delay); else navigate();
  };
  const provider = createNativeActionProvider({ win, history, timeoutMs: options.timeoutMs || 180, onGuide: () => counts.guide++ });
  t.after(() => { provider.stop(); win.close(); });
  const open = (actionId = 'vm.hardware.cpu', config) => { provider.bindSource(source); const data = provider.read(target); return provider.open({ resource: target, actionId, snapshot: data.snapshot }, config); };
  const clean = () => { assert.equal(pulses.size, 0, 'no waiting interval survives handoff'); assert.equal(observers.size, 0, 'no waiting observer survives handoff'); };
  const untouched = () => { assert.equal(counts.submit + counts.fields + counts.http + counts.guide, 0); clean(); };
  return { win, doc, row, source, route, pane, modal, counts, provider, open, untouched, clean, notifyRoute() { for (const fn of [...listeners]) fn(); }, get selectedPane() { return selectedPane; } };
}

for (const [id, intent] of [['vm.general.edit', 'basic'], ['vm.hardware.cpu', 'basic'], ['vm.hardware.memory', 'basic'],
  ['vm.hardware.disk.add', 'disk'], ['vm.hardware.disk.expand', 'disk'], ['vm.hardware.disk.remove', 'disk'],
  ['vm.hardware.nic.add', 'nic'], ['vm.hardware.nic.remove', 'nic'], ['vm.migration.withinCluster', 'migration']]) {
  test(`${id} opens the actual host editor surface without configuration or submit`, async t => {
    const f = fixture(t); assert.deepEqual(await f.open(id), { status: 'opened', surface: 'dialog' });
    assert.equal(f.doc.querySelector('.ant-modal-title').textContent, titles[intent]);
    assert.equal(f.counts.navigate, 1); assert.equal(f.counts.entry, 1); f.untouched();
    f.provider.stop(); assert.ok(f.doc.querySelector('.ant-modal'), 'stop leaves official UI under host control');
  });
}
test('navigation and host pane can arrive asynchronously after the menu is gone', async t => {
  const f = fixture(t, { delay: 15, navigate({ pane }) { setTimeout(() => pane(), 15); } });
  assert.equal((await f.open()).surface, 'dialog'); assert.equal(f.counts.entry, 1); f.untouched();
});
test('snapshot list directly selects the official snapshot page and observes its active route', async t => {
  const f = fixture(t); assert.deepEqual(await f.open('vm.snapshots.list'), { status: 'opened', surface: 'tab' });
  assert.equal(f.counts.entry, 1); assert.equal(f.doc.querySelector('.ant-modal'), null); f.untouched();
});
for (const [name, options] of [['wrong exact public ID', { explicitId: 'vm-b' }], ['wrong displayed target', { name: 'VM B' }],
  ['disabled official editor', { disabled: true }], ['ambiguous section editors', { duplicate: true }]]) {
  test(`${name} cannot click an editor or claim success`, async t => {
    const f = fixture(t, options); assert.equal((await f.open()).status, 'unsupported'); assert.equal(f.counts.entry, 0); f.untouched();
  });
}
test('same-name old pane with a reused header cannot be mistaken for a newly navigated VM', async t => {
  const f = fixture(t, { navigate() {} }); f.pane();
  assert.equal((await f.open()).status, 'unsupported'); assert.equal(f.counts.entry, 0); f.untouched();
});
test('two visible panes cannot be resolved by selecting the first matching name', async t => {
  const f = fixture(t); f.pane(); assert.equal((await f.open()).status, 'unsupported'); assert.equal(f.counts.entry, 0); f.untouched();
});
test('an existing native dialog prevents navigation and editor clicks', async t => {
  const f = fixture(t); f.modal('basic'); assert.equal((await f.open()).status, 'unsupported'); assert.equal(f.counts.navigate + f.counts.entry, 0); f.untouched();
});
test('an unrelated popup appearing while waiting blocks the subsequent editor click', async t => {
  const f = fixture(t, { navigate({ pane }) { pane(); const p = f.doc.createElement('div'); p.className = 'ant-dropdown'; f.doc.body.append(p); } });
  assert.equal((await f.open()).status, 'unsupported'); assert.equal(f.counts.entry, 0); f.untouched();
});
test('a different dialog or simultaneous native dialogs never becomes a successful handoff', async t => {
  for (const multiple of [false, true]) {
    const f = fixture(t, { onEntry(intent) { f.modal(intent, multiple ? titles[intent] : 'Unexpected operation'); if (multiple) f.modal(intent); } });
    assert.equal((await f.open()).status, 'unsupported'); assert.equal(f.counts.entry, 1); f.untouched();
  }
});
test('route A to B to A while waiting cancels rather than resumes a delayed editor click', async t => {
  const f = fixture(t, { navigate({ pane, route }) { route('vm-b'); route(); pane(); } });
  assert.equal((await f.open()).status, 'cancelled'); assert.equal(f.counts.entry, 0); f.untouched();
});
test('abort and provider stop cancel waiting work and never close or submit official UI', async t => {
  for (const stop of [false, true]) {
    const f = fixture(t, { navigate() {} }), controller = new f.win.AbortController(); const pending = f.open('vm.hardware.cpu', { signal: controller.signal });
    await tick(); if (stop) f.provider.stop(); else controller.abort();
    assert.equal((await pending).status, 'cancelled'); assert.equal(f.counts.entry, 0); f.untouched();
  }
});
test('ambiguous power semantics and snapshot operations without an exact snapshot remain unsupported', async t => {
  const f = fixture(t);
  for (const id of ['vm.power.start', 'vm.power.poweroff', 'vm.power.forceRestart', 'vm.snapshots.restore', 'vm.snapshots.delete']) assert.equal((await f.open(id)).status, 'unsupported');
  assert.equal(f.counts.navigate + f.counts.entry, 0); f.untouched();
});
test('a disabled official Details tab cannot be clicked to reach hidden configuration', async t => {
  let tabClicks = 0;
  const f = fixture(t, { navigate({ pane }) {
    const node = pane(), tab = node.querySelector('.tab-item'); tab.classList.remove('active');
    tab.parentElement.setAttribute('aria-disabled', 'true'); tab.onclick = () => tabClicks++;
  } });
  assert.equal((await f.open()).status, 'unsupported'); assert.equal(tabClicks + f.counts.entry, 0); f.untouched();
});
test('an additional same-VM route change after owned navigation cancels the pending handoff', async t => {
  const f = fixture(t, { navigate({ pane }) {
    f.win.history.replaceState({}, '', f.win.location.hash + '&unexpected=1'); f.notifyRoute(); pane();
  } });
  assert.equal((await f.open()).status, 'cancelled'); assert.equal(f.counts.entry, 0); f.untouched();
});
test('a recycled original list row cannot authorize a late target editor', async t => {
  const f = fixture(t, { navigate({ pane }) { pane(); f.row.setAttribute('data-row-key', 'vm-b'); } });
  assert.equal((await f.open()).status, 'unsupported'); assert.equal(f.counts.entry, 0); f.untouched();
});
