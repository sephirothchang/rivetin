import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nativeIntent, nativeEntry, findNativeControl, findNativeSurface } from '../src/native/controls.js';
import { NATIVE_ACTION_CATALOG, buildNativeActionTree, getNativeAction } from '../src/native/catalog.js';

const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const resource = { type: 'vm', id: 'vm-a' };
const editors = [
  ['vm.availability.ha', 'ha', '编辑高可用', 'EditPen24GradientBlueIcon', '编辑虚拟机高可用'],
  ['vm.placementGroup', 'placement', '编辑虚拟机放置组', 'VmPlacementGroup24GradientBlueIcon', '编辑虚拟机放置组'],
  ['vm.hostAutostart', 'autostart', '编辑随主机开机', 'EditPen24GradientBlueIcon', '编辑虚拟机随主机开机'],
  ['vm.ownership', 'ownership', '编辑所属用户', 'UserAccount24GradientBlueIcon', '编辑所属用户'],
  ['vm.guest.hostname', 'hostname', '编辑主机名', 'EditPen24GradientBlueIcon', '编辑客户机操作系统的主机名'],
  ['vm.guest.dns', 'dns', '编辑 DNS 服务器地址', 'EditPen24GradientBlueIcon', '编辑客户机操作系统的 DNS 服务器'],
];
function fixture(t) {
  const dom = new JSDOM('<aside class="drawer-content-inner"></aside>', { url: 'https://tower.example.invalid/#/vms/vm-a?view=%22detail%22' });
  const win = dom.window, doc = win.document, pane = doc.querySelector('aside');
  win.HTMLElement.prototype.getClientRects = () => [{ width: 200, height: 30 }];
  let clicks = 0; doc.addEventListener('click', () => clicks++);
  win.fetch = () => { throw new Error('NO_BUSINESS_TRANSPORT'); };
  t.after(() => { assert.equal(clicks, 0, 'entry discovery must never click native controls'); win.close(); });
  function menu(label, icon, submenu = false) {
    const node = doc.createElement('div'); node.className = 'ant-dropdown';
    node.innerHTML = `<ul role="menu"><li role="menuitem" class="${submenu ? 'ant-dropdown-menu-submenu' : 'ant-dropdown-menu-item'}">${submenu ? '<div class="ant-dropdown-menu-submenu-title">' : ''}<svg data-testid="${icon}"></svg><span>${label}</span>${submenu ? '</div><ul role="menu"><li role="menuitem" class="ant-dropdown-menu-item">移至组...</li></ul>' : ''}</li></ul>`;
    doc.body.append(node); return node;
  }
  const control = (intent, menu) => findNativeControl({ win, pane, intent, menu });
  function modal(title) { const node = doc.createElement('section'); node.className = 'ant-modal'; node.innerHTML = `<h2 class="ant-modal-title">${title}</h2><input><button>保存</button>`; doc.body.append(node); return node; }
  return { win, doc, pane, menu, modal, control, surface: (intent, before = new Set()) => findNativeSurface({ win, intent, before }) };
}

test('six observed safe editors have precise item labels, icons and corresponding modal titles', () => {
  for (const [id, intent, label, icon, title] of editors) {
    assert.equal(nativeIntent(id), intent);
    const definition = nativeEntry(intent);
    assert.equal(definition.kind, 'edit-item'); assert.equal(definition.result, 'dialog');
    assert.ok(definition.labels.includes(label)); assert.ok(definition.icons.includes(icon)); assert.ok(definition.modalTitles.includes(title));
    assert.ok(Object.isFrozen(definition)); assert.ok(Object.isFrozen(definition.labels)); assert.ok(Object.isFrozen(definition.icons));
    assert.throws(() => definition.labels.push('删除'), TypeError);
  }
});

test('production catalog contains registered real entry points without permanent SDK placeholders or API operations', () => {
  const all = NATIVE_ACTION_CATALOG.flatMap(group => group.items), ids = all.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of all) {
    assert.ok(nativeEntry(nativeIntent(item.id)), item.id);
    assert.ok(item.labels['zh-CN']); assert.ok(item.labels['en-US']);
    assert.equal(Object.hasOwn(item, 'form'), false); assert.equal(Object.hasOwn(item, 'operation'), false);
  }
  for (const id of ['vm.power.forceRestart', 'vm.power.poweroff', 'vm.power.start', 'vm.power.resume', 'vm.snapshots.restore', 'vm.snapshots.delete', 'vm.migration.cutover', 'vm.export', 'vm.hardware.tpm']) {
    assert.ok(!ids.includes(id), `${id} has no equivalent verified VM entry`);
    assert.equal(getNativeAction(id, resource), null);
  }
  const data = { snapshot: { type: 'vm', id: 'vm-a' }, native: { canNavigate: true } };
  for (const locale of ['zh-CN', 'en-US']) {
    const tree = buildNativeActionTree({ resource, data, locale });
    assert.deepEqual(tree.flatMap(group => group.items).map(item => item.id), ids);
    assert.ok(tree.flatMap(group => group.items).every(item => item.enabled && !item.reason && !item.mutation && item.operation === null && item.guide === ''));
  }
  assert.ok(buildNativeActionTree({ resource, data: { ...data, snapshot: { type: 'vm', id: 'vm-b' } } }).flatMap(group => group.items).every(item => !item.enabled));
  assert.deepEqual(buildNativeActionTree({ resource: { type: 'host', id: 'vm-a' }, data }), []);
});

test('shared official editors cover disk cache, CD-ROM and NIC QoS without inventing operation-specific dialogs', () => {
  for (const id of ['vm.hardware.disk.cache', 'vm.hardware.cdrom.configure', 'vm.hardware.cdrom.add', 'vm.hardware.cdrom.mount', 'vm.hardware.cdrom.eject']) assert.equal(nativeIntent(id), 'disk');
  assert.equal(nativeIntent('vm.hardware.nic.qos'), 'nic');
  assert.equal(nativeIntent('vm.migration.acrossCluster'), nativeIntent('vm.migration.withinCluster'));
  assert.equal(nativeIntent('vm.power.forceRestart'), null);
  assert.equal(nativeEntry(nativeIntent('vm.power.shutdown')).labels[0], '关机');
  assert.equal(nativeEntry(nativeIntent('vm.power.menu')).kind, 'row-menu');
  assert.equal(nativeEntry('console').result, 'handoff');
});

for (const [, intent, label, icon, title] of editors) test(`${intent} requires the explicitly owned popup and recognizes only its newly opened safe editor`, t => {
  const f = fixture(t), menu = f.menu(label, icon);
  assert.equal(f.control(intent), null, 'a matching global popup is not proof of ownership');
  assert.equal(f.control(intent, menu), menu.querySelector('[role="menuitem"]'));
  const modal = f.modal(title); assert.equal(f.surface(intent), modal); assert.equal(f.surface(intent, new Set([modal])), null);
  modal.querySelector('h2').textContent = '另一个对象的设置'; assert.equal(f.surface(intent), null);
});

test('a same-label item in another global popup cannot replace the supplied interaction popup', t => {
  const f = fixture(t); f.menu('编辑高可用', 'EditPen24GradientBlueIcon');
  const owned = f.menu('编辑所属用户', 'UserAccount24GradientBlueIcon');
  assert.equal(f.control('ha', owned), null); assert.ok(f.control('ownership', owned));
  owned.className = 'unrelated-panel'; assert.equal(f.control('ownership', owned), null);
});

test('menu item ambiguity, inherited hiding and native disabled states fail closed', t => {
  const f = fixture(t), menu = f.menu('编辑高可用', 'EditPen24GradientBlueIcon'), item = menu.querySelector('li');
  menu.querySelector('ul').append(item.cloneNode(true)); assert.equal(f.control('ha', menu), null); menu.querySelector('ul').lastChild.remove();
  for (const attribute of ['hidden', 'inert', 'aria-disabled', 'aria-hidden']) {
    item.setAttribute(attribute, attribute.startsWith('aria-') ? 'true' : ''); assert.equal(f.control('ha', menu), null); item.removeAttribute(attribute);
  }
  item.classList.add('ant-dropdown-menu-item-disabled'); assert.equal(f.control('ha', menu), null); item.classList.remove('ant-dropdown-menu-item-disabled');
  menu.style.display = 'none'; assert.equal(f.control('ha', menu), null); menu.style.display = '';
  item.querySelector('svg').setAttribute('data-testid', 'Delete24RedIcon'); assert.equal(f.control('ha', menu), null);
});

test('VM group and template submenu entries select only the native submenu opener, never a group mutation', t => {
  const f = fixture(t), menu = f.menu('编辑虚拟机组', 'VmgroupFolder24GradientBlueIcon', true);
  const opener = menu.querySelector('.ant-dropdown-menu-submenu-title');
  assert.equal(f.control('vmgroup', menu), opener); assert.equal(nativeEntry('vmgroup').result, 'handoff');
  assert.notEqual(f.control('vmgroup', menu), menu.querySelector('li li'));
  menu.querySelector('li').classList.add('ant-dropdown-menu-submenu-disabled'); assert.equal(f.control('vmgroup', menu), null);
  const template = f.menu('创建虚拟机模板', 'Vmtemplate24GradientBlueIcon', true); template.querySelector('li').classList.add('ant-dropdown-menu-submenu-disabled');
  assert.equal(f.control('template', template), null);
});

test('toolbar labels and observed icons must agree; a restart icon is never a force restart equivalent', t => {
  const f = fixture(t); f.pane.innerHTML = '<div class="toolbar"><button title="打开终端"><svg data-testid="OpenTerminal16WhiteIcon"></svg>打开终端</button><button><svg data-testid="RestartNew16GradientGrayIcon"></svg></button><button><svg data-testid="SuspendedPause16GradientOrangeIcon"></svg></button><button><svg data-testid="MoreEllipsis316BoldBlueIcon"></svg></button></div>';
  for (const intent of ['console', 'restart', 'suspend', 'more-menu']) assert.ok(f.control(intent), intent);
  const restart = f.control('restart'); restart.title = '强制重启'; assert.equal(f.control('restart'), null);
  const console = f.control('console'); console.title = '删除'; assert.equal(f.control('console'), null);
  assert.equal(f.control('power-menu'), null, 'row menu handoff belongs to the row adapter, not an inferred toolbar chooser');
});

test('toolbar and more-menu queries reject duplicate, wrong-scope and wrong-icon candidates', t => {
  const f = fixture(t); const button = '<button title="克隆"><svg data-testid="Clone16GradientBlueIcon"></svg>克隆</button>';
  f.pane.innerHTML = `<div class="toolbar">${button}${button}</div>`; assert.equal(f.control('clone'), null);
  f.pane.querySelector('.toolbar').lastChild.remove(); assert.ok(f.control('clone'));
  f.pane.querySelector('svg').setAttribute('data-testid', 'Migrate16GradientBlueIcon'); assert.equal(f.control('clone'), null);
  const menu = f.menu('移至回收站', 'VmRecycleBinMoveToBin24RedIcon'); assert.ok(f.control('recycle', menu));
  assert.equal(nativeEntry('recycle').result, 'handoff'); assert.equal(f.surface('recycle'), null);
  menu.querySelector('li').setAttribute('aria-disabled', 'true'); assert.equal(f.control('recycle', menu), null);
});

test('snapshot creation discovers one official pane button after tab handoff, never modal submit or a global button', t => {
  const f = fixture(t); const spec = nativeEntry(nativeIntent('vm.snapshots.create'));
  assert.equal(spec.kind, 'snapshot-action'); assert.equal(spec.tabView, 'snapshot'); assert.equal(spec.result, 'handoff');
  f.doc.body.insertAdjacentHTML('beforeend', '<button>创建快照</button>'); assert.equal(f.control('snapshot-create'), null);
  f.pane.innerHTML = '<button id="create">创建快照</button><div class="ant-modal"><button>创建快照</button></div>';
  assert.equal(f.control('snapshot-create'), f.doc.getElementById('create'));
  f.doc.getElementById('create').disabled = true; assert.equal(f.control('snapshot-create'), null);
});

test('observed monitoring, security, backup, event and label tabs are navigation handoffs without guessed query aliases', t => {
  const f = fixture(t);
  const tabs = [['vm.monitor.view', 'monitor', '监控'], ['vm.network.security', 'network-security', '网络安全'], ['vm.backup', 'backup', '备份与容灾'], ['vm.events.view', 'events', '事件'], ['vm.labels.view', 'labels', '标签']];
  f.pane.innerHTML = '<div class="detail-tabs">' + tabs.map(([, , label]) => `<button class="tab-item">${label}</button>`).join('') + '</div>';
  for (const [actionId, intent, label] of tabs) {
    assert.equal(nativeIntent(actionId), intent);
    const spec = nativeEntry(intent); assert.equal(spec.kind, 'tab'); assert.equal(spec.result, 'handoff'); assert.equal(Object.hasOwn(spec, 'tabView'), false);
    assert.equal(f.control(intent)?.textContent, label); assert.equal(f.surface(intent), null);
    assert.ok(getNativeAction(actionId, resource));
  }
});

test('unknown, inherited object names and undefined entries do not produce native controls', t => {
  const f = fixture(t);
  for (const intent of ['unknown', '__proto__', 'constructor', 'toString', null, undefined]) {
    assert.equal(nativeEntry(intent), null); assert.equal(f.control(intent), null); assert.equal(f.surface(intent), null);
  }
});
