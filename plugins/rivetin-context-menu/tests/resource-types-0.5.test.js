import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { identifyResource, resourceUrl, currentResource } from '../src/resources.js';
import { RESOURCE_TYPES, defaults, validate } from '../src/configuration.js';
import createPlugin from '../src/definition.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const signatures = [
  ['host', ['名称', '管理 IP', 'CPU 型号'], ['Name', 'Management IP', 'CPU model'], 'hosts'],
  ['disk', ['名称', '序列号', '容量'], ['Name', 'Serial number', 'Capacity'], 'disks'],
  ['nic', ['名称', 'MAC 地址', 'RDMA', '网口用途'], ['Name', 'MAC address', 'RDMA', 'NIC usage']],
  ['vmGroup', ['名称', '组目录', '虚拟机数量'], ['Name', 'Group directory', 'VM count']],
  ['vmPlacementGroup', ['名称', '状态', '虚拟机数', '描述', '创建时间'], ['Name', 'Status', 'VM count', 'Description', 'Created at']],
  ['vmVolume', ['名称', '容量', '关联虚拟机'], ['Name', 'Capacity', 'VM'], 'vmVolumes'],
  ['vmNetwork', ['名称', 'VLAN 类型', 'VLAN ID', '所属虚拟分布式交换机'], ['Name', 'VLAN type', 'VLAN ID', 'Distributed virtual switch']],
  ['systemNetwork', ['名称', '类型', '子网掩码', '网关', 'IP 地址'], ['Name', 'Type', 'Subnet mask', 'Gateway', 'IP address']],
  ['vmSnapshot', ['名称', '源虚拟机', '独占物理容量', '快照时间', '关联快照计划'], ['Name', 'Source VM', 'Exclusive physical capacity', 'Snapshot time', 'Associated snapshot plan']],
  ['snapshotPlan', ['名称', '上次快照任务结果', '快照对象数', '可用快照组'], ['Name', 'Last snapshot task result', 'Snapshot object count', 'Available snapshot groups']],
  ['vds', ['名称', '关联主机数', '网口绑定模式', '网口连通性检测'], ['Name', 'Associated host count', 'NIC bonding mode', 'NIC connectivity check']],
];
const table = (primary, secondary, id = 'resource-a', name = 'Same resource name') => `<table><thead><tr>${(Array.isArray(primary) ? primary : [primary, secondary]).map((text, index) => `<th${index ? '' : ' class="cell_name"'}>${text}</th>`).join('')}</tr></thead><tbody><tr data-row-key="${id}"><td unique="name"><span id="target">${name}</span></td><td>Example</td></tr></tbody></table>`;
function fixture(t, markup, hash = '#/overview?view=%22futureResourceTab%22') {
  const dom = new JSDOM(markup, { url: 'https://tower.example.invalid/' + hash });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{ width: 150, height: 30 }]; };
  dom.window.fetch = () => { throw new Error('NO_NETWORK_IN_RESOURCE_FIXTURE'); };
  t.after(() => dom.window.close());
  return { win: dom.window, doc: dom.window.document, identify: selector => identifyResource(dom.window.document.querySelector(selector || '#target'), dom.window) };
}

for (const [type, zh, en, view] of signatures) for (const [locale, headers] of [['Chinese', zh], ['English', en]]) test(`${locale} ${type} screenshot header combination or verified view uses its row key only`, t => {
  // New types use the supplied screenshot's full combination. Existing types
  // retain their previously verified view mapping, not invented new routes.
  const f = fixture(t, table(headers), view ? '#/hosts/host-a?view=' + encodeURIComponent(JSON.stringify(view)) : undefined); const resource = f.identify();
  assert.equal(resource?.type, type); assert.equal(resource.id, 'resource-a'); assert.equal(resource.name, 'Same resource name'); assert.equal(resource.href, null);
  assert.equal(resource.element, f.doc.querySelector('tr[data-row-key]')); assert.equal(resource.select, f.doc.querySelector('td[unique="name"]'));
});

test('all 15 resource types are configurable while existing saved choices remain unchanged', () => {
  const all = ['organization', 'datacenter', 'cluster', 'host', 'vm', 'vmVolume', 'disk', 'nic', 'vmGroup', 'vmPlacementGroup', 'vmNetwork', 'systemNetwork', 'vmSnapshot', 'snapshotPlan', 'vds'];
  assert.deepEqual(RESOURCE_TYPES, all); assert.deepEqual(defaults().resourceTypes, all); assert.deepEqual(validate(defaults()), defaults());
  const old = { version: 1, enabled: true, nativeActions: true, resourceTypes: ['vm', 'host', 'disk'] };
  assert.deepEqual(defaults(old), old); assert.deepEqual(old.resourceTypes, ['vm', 'host', 'disk']);
  assert.throws(() => validate({ ...defaults(), resourceTypes: [...all, 'nic'] })); assert.throws(() => validate({ ...defaults(), resourceTypes: ['unverifiedType'] }));
});

test('settings render a Chinese and English checkbox for each resource type without activation or network calls', t => {
  const f = fixture(t, ''), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const plugin = createPlugin({ React, win: f.win, options: { configurationBackend: () => ({}) } });
  for (const locale of ['zh-CN', 'en-US']) {
    const html = renderToStaticMarkup(React.createElement(plugin.Settings, { preferences: defaults(), locale }));
    for (const type of RESOURCE_TYPES) assert.ok(html.includes(`id="rvcm-${type}"`), `${locale} must display ${type}`);
    assert.ok(!html.includes('undefined')); assert.match(html, locale === 'zh-CN' ? /新增类型/ : /new types/);
  }
});

for (const type of RESOURCE_TYPES.filter(type => type !== 'organization')) test(`an explicit ${type} sidebar uses only its exact URL identity`, () => {
  const url = 'https://tower.example.invalid/#/overview?sidebar=' + encodeURIComponent(JSON.stringify({ type, id: 'resource-a', view: 'detail' }));
  assert.deepEqual(resourceUrl(url, 'https://tower.example.invalid'), { type, id: 'resource-a', href: url });
  const forged = url.replace('resource-a', 'bad%2Fid'); assert.equal(resourceUrl(forged, 'https://tower.example.invalid'), null);
});

test('unknown direct routes are not invented from the new type identifiers', () => {
  for (const route of ['nics', 'vmGroups', 'vm-placement-groups', 'vm-networks', 'system-networks', 'vm-snapshots', 'snapshot-plans', 'vdses']) assert.equal(resourceUrl(`https://tower.example.invalid/#/${route}/resource-a`, 'https://tower.example.invalid'), null);
});

test('unknown generic tables and incomplete or hidden signatures retain browser behavior', t => {
  const f = fixture(t, table('名称', 'MAC 地址')); assert.equal(f.identify(), null);
  f.doc.body.innerHTML = table(signatures.find(([type]) => type === 'nic')[1]); const last = f.doc.querySelectorAll('th')[3];
  last.hidden = true; assert.equal(f.identify(), null); last.hidden = false; last.style.display = 'none'; assert.equal(f.identify(), null);
  last.style.display = ''; f.doc.querySelector('tr[data-row-key]').setAttribute('data-row-key', 'bad/id'); assert.equal(f.identify(), null);
});

test('a related VDS column cannot turn a virtual network into a VDS or identify an incomplete generic table', t => {
  const f = fixture(t, table(signatures.find(([type]) => type === 'vmNetwork')[1]));
  assert.equal(f.identify()?.type, 'vmNetwork');
  f.doc.body.innerHTML = table(['名称', '所属虚拟分布式交换机', '所属集群']); assert.equal(f.identify(), null);
});

const snapshotHeaders = '<thead><tr><th class="cell_name">名称</th><th class="cell_size">独占物理容量</th><th class="cell_local_created_at">快照时间</th><th class="cell_snapshot_group">关联快照计划</th></tr></thead>';
const snapshotRow = '<tbody><tr data-row-key="snapshot-a"><td unique="name"><span id="snapshot-target">Same VM name</span></td><td unique="size">1</td><td unique="local_created_at">Example time</td><td unique="snapshot_group">Example plan</td></tr></tbody>';
const vmSidebar = '#/clusters/cluster-a?view=%22vms%22&sidebar=' + encodeURIComponent(JSON.stringify({ type: 'vm', id: 'vm-a', view: 'snapshot' }));
test('the observed snapshot table inside a VM drawer cannot inherit the outer VM list type or parent ID', t => {
  const f = fixture(t, '<table><tbody><tr data-row-key="vm-b"><td unique="name" id="vm-target">Same VM name</td></tr></tbody></table><aside class="drawer-content-inner"><table>' + snapshotHeaders + snapshotRow + '</table></aside>', vmSidebar);
  assert.equal(currentResource(f.win).id, 'vm-a');
  const snapshot = f.identify('#snapshot-target'); assert.equal(snapshot.type, 'vmSnapshot'); assert.equal(snapshot.id, 'snapshot-a'); assert.equal(snapshot.parentVmId, 'vm-a');
  assert.equal(f.identify('#vm-target').type, 'vm'); assert.equal(f.identify('#vm-target').id, 'vm-b');
});

test('an unverified child table in a VM pane cannot inherit view=vms', t => {
  const f = fixture(t, '<aside class="drawer-content-inner">' + table('名称', '时间') + '</aside>', vmSidebar); assert.equal(f.identify(), null);
});

test('partial snapshot headers block a forged VM-name link instead of classifying the snapshot as VM', t => {
  const f = fixture(t, '<table><thead><tr><th>名称</th><th class="cell_snapshot_group">关联快照计划</th></tr></thead><tbody><tr data-row-key="snapshot-a"><td unique="name"><a id="target" href="#/vms/snapshot-a">Same VM name</a></td></tr></tbody></table>', vmSidebar);
  assert.equal(f.identify(), null);
});

test('snapshot name links cannot replace the row identity with a parent VM identity', t => {
  const f = fixture(t, '<table>' + snapshotHeaders + snapshotRow.replace('<span id="snapshot-target">Same VM name</span>', '<a id="snapshot-target" href="#/vms/vm-a">Same VM name</a>') + '</table>', vmSidebar);
  assert.equal(f.identify('#snapshot-target'), null);
});

test('same-name physical disks and NICs use their independent exact row IDs', t => {
  const nic = signatures.find(([type]) => type === 'nic')[1];
  const f = fixture(t, table(nic, null, 'nic-a', 'eth0') + table(nic, null, 'nic-b', 'eth0').replace('id="target"', 'id="other"'));
  assert.equal(f.identify().id, 'nic-a'); assert.equal(f.identify('#other').id, 'nic-b');
  f.win.history.replaceState({}, '', '#/hosts/host-a?view=%22disks%22');
  f.doc.body.innerHTML = table('硬盘', '序列号', 'disk-a', '/dev/sda') + table('硬盘', '序列号', 'disk-b', '/dev/sda').replace('id="target"', 'id="other"');
  assert.equal(f.identify().id, 'disk-a'); assert.equal(f.identify('#other').id, 'disk-b');
});

test('VM internal disk and NIC cards keep parent VM identity without fabricating child IDs', t => {
  const f = fixture(t, '<aside class="drawer-content-inner"><div class="detail-sidebar-header"><div class="frame"><div class="title-wrapper"><span class="header-title">VM A</span></div></div></div><div class="disk-item"><div class="ant-collapse-header"><span id="disk-target" class="name">Disk 1</span></div></div><div class="nic-item"><div class="ant-collapse-header"><span data-testid="Nic24GradientBlueIcon"></span><span id="nic-target">NIC 1</span></div></div></aside>', vmSidebar);
  for (const [selector, internal] of [['#disk-target', 'vmDisk'], ['#nic-target', 'nic']]) {
    const result = f.identify(selector); assert.equal(result.type, 'vm'); assert.equal(result.id, 'vm-a'); assert.equal(result.parentVmId, 'vm-a'); assert.equal(result.internal, internal);
  }
});

test('split Ant table header and body remain scoped to the same wrapper', t => {
  const header = table(signatures.find(([type]) => type === 'systemNetwork')[1]).split('<tbody>')[0] + '</table>';
  const f = fixture(t, '<div class="ant-table-wrapper"><div class="ant-table-header">' + header + '</div><div class="ant-table-body"><table><tbody><tr data-row-key="network-a"><td unique="name" id="target">Network A</td></tr></tbody></table></div></div>' + table(signatures.find(([type]) => type === 'nic')[1]).replace('id="target"', 'id="unrelated"'));
  assert.equal(f.identify().type, 'systemNetwork'); assert.equal(f.identify().id, 'network-a'); assert.equal(f.identify('#unrelated').type, 'nic');
});

test('the new resource menu is excluded from resource identification even if it contains a typed fixture row', t => {
  const f = fixture(t, '<div data-rivetin-resource-menu>' + table(signatures.find(([type]) => type === 'nic')[1]) + '</div>'); assert.equal(f.identify(), null);
});

for (const types of [['nic', 'systemNetwork'], ['vmGroup', 'vmPlacementGroup'], ['vmNetwork', 'vds'], ['vmSnapshot', 'snapshotPlan']]) test(`conflicting ${types.join('/')} screenshot signatures fail closed`, t => {
  const headers = [...new Set(types.flatMap(type => signatures.find(([kind]) => kind === type)[1]))];
  const f = fixture(t, table(headers)); assert.equal(f.identify(), null);
});

test('a shared outer wrapper cannot borrow headers from an unrelated VM drawer', t => {
  const childHeader = table(signatures.find(([type]) => type === 'nic')[1]);
  const f = fixture(t, '<div class="ant-table-wrapper"><table><tbody><tr data-row-key="unknown-a"><td unique="name" id="target">Unknown</td></tr></tbody></table><aside class="drawer-content-inner">' + childHeader.replace('id="target"', 'id="child"') + '</aside></div>');
  assert.equal(f.identify(), null); assert.equal(f.identify('#child').type, 'nic');
});

test('a name link cannot override conflicting header combinations even when it has the same exact row ID', t => {
  const headers = [...new Set(['vmGroup', 'vmPlacementGroup'].flatMap(type => signatures.find(([kind]) => kind === type)[1]))];
  const f = fixture(t, table(headers).replace('<span id="target">Same resource name</span>', '<a href="#/vms/resource-a" id="target">Same resource name</a>'));
  assert.equal(f.identify(), null);
});

test('a global snapshot row cannot borrow an unrelated open VM drawer as its parent', t => {
  const f = fixture(t, '<table>' + snapshotHeaders + snapshotRow + '</table><aside class="drawer-content-inner"><div class="frame"><div class="title-wrapper"><span class="header-title">Other VM</span></div></div></aside>', vmSidebar);
  const result = f.identify('#snapshot-target'); assert.equal(result.type, 'vmSnapshot'); assert.equal(result.id, 'snapshot-a'); assert.equal(result.parentVmId, undefined);
});
