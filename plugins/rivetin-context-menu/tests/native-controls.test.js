import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nativeIntent, findNativeControl, findNativeSurface } from '../src/native/controls.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const section = title => `<section><header><h3>${title}</h3><span class="extra-action"><button class="edit-icon">编辑</button></span></header><div class="content"></div></section>`;
const migration = '<div class="toolbar"><button title="迁移"><svg data-testid="Migrate16GradientBlueIcon"></svg>迁移</button></div>';
function fixture(t, html = section('基本信息') + section('磁盘') + section('网络设备') + migration + '<div class="detail-tabs"><div class="tab-item">详情</div><div class="tab-item">快照</div></div>') {
  const dom = new JSDOM(`<aside id="pane">${html}</aside>`, { url: 'https://tower.example.invalid/#/vms/example-vm?view=%22detail%22' });
  const win = dom.window, doc = win.document, pane = doc.getElementById('pane');
  win.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
  let clicks = 0;
  doc.addEventListener('click', () => clicks++);
  win.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  t.after(() => { assert.equal(clicks, 0, 'query helpers must never click'); win.close(); });
  return { win, doc, pane, control: intent => findNativeControl({ win, pane, intent }),
    modal(title) { const modal = doc.createElement('section'); modal.className = 'ant-modal'; modal.innerHTML = `<h2 class="ant-modal-title">${title}</h2><button>保存</button>`; doc.body.append(modal); return modal; },
    surface: (intent, before = new Set()) => findNativeSurface({ win, intent, before }) };
}

test('registered native entries map to their precise controls without inventing destructive SDK equivalents', () => {
  for (const action of ['vm.general.edit', 'vm.hardware.cpu', 'vm.hardware.memory']) assert.equal(nativeIntent(action), 'basic');
  for (const action of ['add', 'edit', 'expand', 'remove']) assert.equal(nativeIntent('vm.hardware.disk.' + action), 'disk');
  for (const action of ['add', 'edit', 'remove']) assert.equal(nativeIntent('vm.hardware.nic.' + action), 'nic');
  assert.equal(nativeIntent('vm.migration.withinCluster'), 'migration'); assert.equal(nativeIntent('vm.snapshots.list'), 'snapshots');
  assert.equal(nativeIntent('vm.snapshots.create'), 'snapshot-create'); assert.equal(nativeIntent('vm.power.shutdown'), 'shutdown'); assert.equal(nativeIntent('vm.console.open'), 'console'); assert.equal(nativeIntent('vm.clone'), 'clone');
  for (const id of ['vm.snapshots.restore', 'vm.snapshots.delete', 'vm.power.start', 'vm.power.forceRestart', 'vm.power.poweroff', 'vm.hardware.disk.delete', '__proto__', null]) assert.equal(nativeIntent(id), null);
});

test('section queries select only their exact immediate title editor', t => {
  const f = fixture(t);
  for (const [intent, index] of [['basic', 0], ['disk', 1], ['nic', 2]]) assert.equal(f.control(intent), f.pane.querySelectorAll('button.edit-icon')[index]);
  for (const intent of ['unknown', 'toString', 'constructor', '__proto__', null]) {
    assert.equal(f.control(intent), null); assert.equal(f.surface(intent), null);
  }
});
test('English observed-layout labels use exact section matching', t => {
  const f = fixture(t, section('Basic information') + section('Disks') + section('Network devices'));
  for (const intent of ['basic', 'disk', 'nic']) assert.ok(f.control(intent));
});
test('a global edit, broad ancestor title or nested unrelated editor cannot match', t => {
  const f = fixture(t, '<div>磁盘<section><span class="extra-action"><button class="edit-icon">编辑</button></span></section></div><button class="edit-icon">编辑</button>' + section('磁盘详情'));
  f.doc.body.insertAdjacentHTML('beforeend', section('磁盘')); assert.equal(f.control('disk'), null);
});
test('duplicate section titles or duplicate edit buttons reject ambiguous target', t => {
  const f = fixture(t, section('磁盘') + section('磁盘')); assert.equal(f.control('disk'), null);
  f.pane.lastElementChild.remove(); f.pane.querySelector('.extra-action').insertAdjacentHTML('beforeend', '<button class="edit-icon">编辑</button>');
  assert.equal(f.control('disk'), null);
});

for (const block of ['hidden', 'aria-hidden', 'disabled', 'aria-disabled', 'inert', '__hidden', 'ant-dropdown-hidden', 'is-disabled', 'ant-btn-loading', 'display', 'visibility', 'fieldset']) test(`section editor excludes inherited ${block}`, t => {
  const f = fixture(t, section('磁盘')), parent = f.pane;
  if (block === 'hidden' || block === 'disabled' || block === 'inert') parent.setAttribute(block, '');
  else if (block.startsWith('aria-')) parent.setAttribute(block, 'true');
  else if (block === 'display') parent.style.display = 'none';
  else if (block === 'visibility') parent.style.visibility = 'hidden';
  else if (block === 'fieldset') { const fieldset = f.doc.createElement('fieldset'); fieldset.disabled = true; parent.replaceWith(fieldset); fieldset.append(parent); }
  else parent.classList.add(block);
  assert.equal(f.control('disk'), null);
});
test('detached, foreign-window or invisible panes are rejected', t => {
  const f = fixture(t); f.pane.remove(); assert.equal(f.control('basic'), null);
  assert.equal(findNativeControl({ win: { document: {} }, pane: f.pane, intent: 'basic' }), null);
});
test('migration requires exact text/title and icon inside the pane toolbar', t => {
  const f = fixture(t); const button = f.pane.querySelector('.toolbar button');
  assert.equal(f.control('migration'), button);
  button.title = '删除'; assert.equal(f.control('migration'), null);
  button.title = '迁移'; button.querySelector('svg').remove(); assert.equal(f.control('migration'), null);
});
test('migration never selects modal submit or same-text unrelated button', t => {
  const f = fixture(t, '<button title="迁移"><svg data-testid="Migrate16GradientBlueIcon"></svg>迁移</button><div class="ant-modal"><div class="toolbar"><button title="迁移"><svg data-testid="Migrate16GradientBlueIcon"></svg>迁移</button></div></div>');
  assert.equal(f.control('migration'), null);
});
test('migration rejects duplicate, disabled and loading controls', t => {
  const f = fixture(t, migration + migration); assert.equal(f.control('migration'), null);
  f.pane.lastElementChild.remove(); const button = f.pane.querySelector('button'); button.disabled = true; assert.equal(f.control('migration'), null);
  button.disabled = false; button.parentElement.classList.add('ant-btn-loading'); assert.equal(f.control('migration'), null);
});
test('snapshots selects only unique exact native tab and never decides active state', t => {
  const f = fixture(t); const tab = f.control('snapshots'); assert.equal(tab.textContent, '快照');
  tab.textContent = 'Snapshots'; assert.equal(f.control('snapshots'), tab);
  tab.setAttribute('aria-selected', 'true'); assert.equal(f.control('snapshots'), tab);
  tab.parentElement.append(tab.cloneNode(true)); assert.equal(f.control('snapshots'), null);
});
test('snapshots excludes hidden, disabled and modal tabs', t => {
  const f = fixture(t); f.pane.querySelector('.detail-tabs').setAttribute('aria-disabled', 'true'); assert.equal(f.control('snapshots'), null);
});

for (const [intent, title] of [['basic', '编辑虚拟机'], ['disk', '编辑磁盘'], ['nic', '编辑虚拟机的网络设备'], ['migration', '迁移虚拟机']]) test(`new ${intent} modal is recognized without reading or changing form fields`, t => {
  const f = fixture(t); const modal = f.modal(title); assert.equal(f.surface(intent), modal);
  assert.equal(f.surface(intent, new Set([modal])), null); assert.equal(f.surface('snapshots'), null);
});
test('wrong or duplicate titles and multiple new visible modals fail closed', t => {
  const f = fixture(t); const modal = f.modal('不是编辑磁盘'); assert.equal(f.surface('disk'), null);
  modal.querySelector('h2').textContent = '编辑磁盘'; modal.insertAdjacentHTML('beforeend', '<h2 class="ant-modal-title">编辑磁盘</h2>'); assert.equal(f.surface('disk'), null);
  modal.lastElementChild.remove(); const other = f.modal('其他操作'); assert.equal(f.surface('disk'), null);
  other.hidden = true; assert.equal(f.surface('disk'), modal);
});
test('old modal node becoming visible is never claimed as newly opened', t => {
  const f = fixture(t); const old = f.modal('编辑磁盘'); old.hidden = true; const before = new Set([old]); old.hidden = false;
  assert.equal(f.surface('disk', before), null);
});
test('hidden or disabled modal ancestors and unavailable title are rejected', t => {
  const f = fixture(t); const modal = f.modal('编辑磁盘'); modal.parentElement.classList.add('is-disabled'); assert.equal(f.surface('disk'), null);
  modal.parentElement.classList.remove('is-disabled'); modal.querySelector('h2').hidden = true; assert.equal(f.surface('disk'), null);
});
