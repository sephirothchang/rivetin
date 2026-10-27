import React from 'react';
import ReactDOM from 'react-dom';
import createPlugin from '../src/definition.js';
import manifest from '../rivetin.json';
import { createDemoActionProvider, demoFields } from './action-provider.js';
import { createProductionActionProvider } from '../src/actions/provider.js';

const h = React.createElement;
const copy = value => JSON.parse(JSON.stringify(value));
let stored = { revision: 0, updatedAt: null, settings: copy(manifest.configuration.defaults) };
const backend = { load: async () => copy(stored), save: async settings => {
  stored = { revision: stored.revision + 1, updatedAt: new Date().toISOString(), settings: copy(settings) };
  return copy(stored);
} };
let locale = 'zh-CN', notify = () => {};
let presentObjectAction = () => {};
const actionProvider = createDemoActionProvider(request => presentObjectAction(request));
const productionFormPreview = new URLSearchParams(window.location.hash.split('?')[1]).get('forms') === 'production';
const productionProvider = productionFormPreview ? createProductionActionProvider({ win: window, getLocale: () => locale,
  environmentNotice: '本地生产表单回归 / Local production form test · 仅使用模拟服务桥，不连接真实环境。',
  bridge: { read: async (resource, options) => {
    const result = await actionProvider.read(resource, options);
    result.snapshot = { ...result.snapshot, name: 'Ubuntu demo', description: 'Local fixture only', cpu_sockets: 1, cpu_cores: 2,
      cluster: { id: 'cluster-demo' }, gpu_devices: [], pci_nics: [], usb_devices: [],
      snapshots: result.snapshot.snapshots.map(snapshot => ({ ...snapshot, vm: { id: resource.id } })),
      availableHosts: [{ id: 'host-demo-2', name: 'Compute node 02', cluster: { id: 'cluster-demo' }, status: 'CONNECTED_HEALTHY' }] };
    return result;
  }, execute: async () => ({ status: 'succeeded', operationId: 'a'.repeat(64) }) },
}) : null;
const routeListeners = new Set();
const history = { listen: fn => { routeListeners.add(fn); return () => routeListeners.delete(fn); } };
function navigate(hash) { window.history.replaceState({}, '', '#' + hash); for (const fn of routeListeners) fn(); }
const plugin = createPlugin({ React, win: window, history, options: { configurationBackend: () => backend }, actionProvider: productionProvider || actionProvider, getLocale: () => locale });
const types = [
  ['vm', '虚拟机', 'Virtual machines', 'vms', 'ubuntu-demo', 'Ubuntu demo'],
  ['vmVolume', '虚拟卷', 'Virtual volumes', 'vm-volumes', 'volume-demo', 'Data volume'],
  ['disk', '物理硬盘', 'Physical disks', 'disks', 'disk-demo', 'NVMe demo disk'],
  ['host', '主机', 'Hosts', 'hosts', 'host-demo', 'Compute node 01'],
  ['cluster', '集群', 'Clusters', 'clusters', 'demo-cluster', 'Lab cluster'],
  ['datacenter', '数据中心', 'Datacenters', 'datacenters', 'demo-datacenter', 'Demo datacenter'],
];
const en = () => locale === 'en-US';
const words = (zh, english) => en() ? english : zh;
const href = item => `#/${item[3]}/${item[4]}?view=%22detail%22`;
const listViews = { vm: 'vms', vmVolume: 'vmVolumes', disk: 'disks', host: 'hosts', cluster: 'clusters', datacenter: 'datacenters' };
const listHash = type => `/clusters/demo-cluster?view=${encodeURIComponent(JSON.stringify(listViews[type]))}`;
function App() {
  const [language, setLanguage] = React.useState(locale), [type, setType] = React.useState('vm');
  const [selected, setSelected] = React.useState(null), [message, setMessage] = React.useState('');
  const [settings, setSettings] = React.useState(false), [revision, render] = React.useState(0), [confirm, setConfirm] = React.useState(null);
  const [diskExpanded, setDiskExpanded] = React.useState(false), [nicExpanded, setNicExpanded] = React.useState(false);
  const [rowMenu, setRowMenu] = React.useState(null);
  const [vmStatus, setVmStatus] = React.useState('RUNNING'), [readOnly, setReadOnly] = React.useState(false);
  const [objectDialog, setObjectDialog] = React.useState(null), [objectValues, setObjectValues] = React.useState({});
  const item = types.find(value => value[0] === type);
  React.useEffect(() => { notify = setMessage; return plugin.store.subscribe(() => render(value => value + 1)); }, []);
  React.useEffect(() => { presentObjectAction = request => {
    setObjectValues(Object.fromEntries(demoFields(request).map(field => [field.id, field.initial ?? ''])));
    setObjectDialog(request);
  }; return () => { presentObjectAction = () => {}; }; }, []);
  React.useEffect(() => {
    const outside = event => { if (!event.target.closest('.demo-native-menu,.menu-button')) setRowMenu(null); };
    document.addEventListener('mousedown', outside); return () => document.removeEventListener('mousedown', outside);
  }, []);
  function changeLanguage(value) { locale = value; document.documentElement.lang = value; setLanguage(value); window.dispatchEvent(new Event('languagechange')); }
  function choose(value) {
    setSelected(value);
    setDiskExpanded(false); setNicExpanded(false);
    const params = new URLSearchParams(); params.set('view', JSON.stringify(listViews[type]));
    params.set('sidebar', JSON.stringify({ type: value[0], view: 'detail', id: value[4] }));
    navigate(`/clusters/demo-cluster?${params}`);
  }
  function chooseType(value) { setType(value); setSelected(null); navigate(listHash(value)); }
  function changeObjectValue(id, event) {
    const next = event.target.value;
    setObjectValues(value => ({ ...value, [id]: next }));
  }
  function nativeAction(label, target = selected) { if (!target) return; setRowMenu(null); setConfirm({ label, name: target[5], id: target[4] }); }
  function toggleCard(event, kind) {
    if (event.type === 'keydown') { if (!['Enter', ' '].includes(event.key)) return; event.preventDefault(); }
    if (kind === 'disk') setDiskExpanded(value => !value); else setNicExpanded(value => !value);
  }
  const current = selected;
  const actionsFor = type => ({
    vm: [['打开终端', 'Open console'], ['开机', 'Power on'], ['关机', 'Shut down', 'danger'], ['重启', 'Restart', 'danger'], ['暂停', 'Suspend'], ['编辑', 'Edit'], ['迁移', 'Migrate', 'disabled'], ['克隆', 'Clone'], ['更多操作', 'More actions']],
    host: [['编辑', 'Edit'], ['进入维护模式', 'Enter maintenance mode'], ['更多操作', 'More actions']],
    cluster: [['设置', 'Settings'], ['更多操作', 'More actions']],
    vmVolume: [['克隆', 'Clone'], ['导出', 'Export'], ['删除', 'Delete', 'danger']],
    disk: [['闪灯', 'Blink'], ['停止闪灯', 'Stop blinking'], ['下载日志', 'Download logs'], ['卸载', 'Unmount', 'danger']],
    datacenter: [['编辑', 'Edit'], ['更多操作', 'More actions']],
  }[type] || []);
  const actions = actionsFor(current?.[0]);
  const fields = objectDialog ? demoFields(objectDialog, en()) : [];
  const objectValid = fields.every(field => !field.required || (field.type === 'number' ? Number.isFinite(Number(objectValues[field.id])) && Number(objectValues[field.id]) >= (field.min || 1) && Number(objectValues[field.id]) <= (field.max || Number.MAX_SAFE_INTEGER) : Boolean(String(objectValues[field.id] || '').trim()))) &&
    (!objectDialog || objectDialog.action.danger !== 'danger' || objectValues.confirmName === objectDialog.resource.name);
  const detailTabs = type === 'vm' ? [['详情', 'Details'], ['监控', 'Monitor'], ['快照', 'Snapshots'], ['备份与容灾', 'Backup and DR'], ['事件', 'Events'], ['标签', 'Labels']] :
    [['详情', 'Details'], ['监控', 'Monitor'], ['标签', 'Labels']];
  return h(React.Fragment, null,
    h('header', { className: 'demo-top' }, h('div', { className: 'demo-brand' }, h('span', { 'aria-hidden': true }, '◈'), 'CloudTower ', h('b', null, 'DEMO')),
      h('span', { className: 'demo-top-label' }, words('资源右键菜单 · 本地演示', 'Resource context menus · Local demo')),
      h('label', null, words('演示状态 ', 'Demo state '), h('select', { 'aria-label': 'Demo VM state', value: vmStatus, onChange: event => { actionProvider.setStatus(event.target.value); setVmStatus(event.target.value); } },
        h('option', { value: 'RUNNING' }, words('运行中', 'Running')), h('option', { value: 'STOPPED' }, words('已关机', 'Stopped')), h('option', { value: 'SUSPENDED' }, words('已暂停', 'Suspended')))),
      h('label', null, words('演示角色 ', 'Demo role '), h('select', { 'aria-label': 'Demo role', value: readOnly ? 'readonly' : 'admin', onChange: event => { const value = event.target.value === 'readonly'; actionProvider.setReadOnly(value); setReadOnly(value); } },
        h('option', { value: 'admin' }, words('管理员', 'Administrator')), h('option', { value: 'readonly' }, words('只读用户', 'Read-only user')))),
      h('label', null, words('语言 ', 'Language '), h('select', { 'aria-label': 'Language', value: language, onChange: event => changeLanguage(event.target.value) }, h('option', { value: 'zh-CN' }, '简体中文'), h('option', { value: 'en-US' }, 'English'))),
      h('button', { onClick: () => setSettings(!settings) }, words('插件设置', 'Plugin settings'))),
    h('div', { className: 'demo-body' },
      h('aside', { className: 'demo-tree', 'aria-label': words('资源树', 'Resource tree') },
        h('div', { className: 'organization-info info', 'data-test': 'demo-organization' }, h('a', { href: '#/overview' }, h('span', { className: 'name' }, words('演示 CloudTower', 'Demo CloudTower')))),
        h('div', { className: 'datacenter-info info', 'data-test': 'demo-datacenter' }, h('a', { href: href(types[5]) }, h('span', { className: 'name', title: 'Demo datacenter' }, 'Demo datacenter'))),
        h('div', { className: 'cluster-info info active' }, h('div', { className: 'cluster-term' }, h('span', { className: 'response-area', 'data-test': 'demo-cluster' }, '▾ '), h('a', { href: href(types[4]) }, h('span', { className: 'name', title: 'Lab cluster' }, 'Lab cluster')))),
        h('div', { className: 'host-info info', 'data-test': 'host-demo' }, h('div', { className: 'host-term' }, h('a', { href: href(types[3]) }, h('span', { className: 'name', title: 'Compute node 01' }, 'Compute node 01')))),
        h('p', { className: 'demo-tree-help' }, words('右键资源节点或列表行', 'Right-click a resource node or table row'))),
      h('main', { className: 'demo-main' },
        h('div', { className: 'demo-breadcrumb' }, 'Demo CloudTower / Demo datacenter / Lab cluster'),
        h('h1', null, 'Lab cluster'),
        h('div', { className: 'demo-tabs' }, ...types.map(value => h('button', { key: value[0], className: value[0] === type ? 'active' : '', onClick: () => chooseType(value[0]) }, en() ? value[2] : value[1]))),
        h('p', { className: 'demo-instruction' }, words('右键虚拟机直接查看完整分组操作，不需要侧边栏。此页面仅模拟状态、权限和表单，不连接真实 CloudTower；未核实的功能显示禁用原因。', 'Right-click a VM for grouped object actions without the sidebar. This page simulates state, permissions and forms only; no live CloudTower connection is made. Unverified functions show why they are unavailable.')),
        h('table', { className: 'demo-table' }, h('thead', null, h('tr', null, h('th', null, words('名称', 'Name')), h('th', null, words('状态', 'Status')), h('th', null, words('类型', 'Type')), h('th', null, 'ID'))),
          h('tbody', null, h('tr', { 'data-row-key': item[4], className: selected?.[4] === item[4] ? 'selected' : '', onClick: () => choose(item), tabIndex: 0, onKeyDown: event => { if (event.key === 'Enter') choose(item); } },
            h('td', { unique: type === 'disk' ? 'path' : 'name' }, h('a', { href: href(item), onClick: event => { event.preventDefault(); choose(item); } }, item[5])), h('td', null, h('span', { className: 'demo-dot' }), type === 'vm' ? ({ RUNNING: words('运行中', 'Running'), STOPPED: words('已关机', 'Stopped'), SUSPENDED: words('已暂停', 'Suspended') }[vmStatus]) : words('正常', 'Healthy')), h('td', null, en() ? item[2] : item[1]), h('td', null, item[4]),
            h('td', { unique: '_action_' }, h('button', { className: 'menu-button ant-dropdown-trigger', 'aria-label': words('更多操作', 'More actions'), onClick: event => { event.stopPropagation(); setRowMenu(value => value ? null : item); } }, '⋯'))))),
        h('div', { className: 'demo-card' }, h('h2', null, words('验证提示', 'Try it out')),
          h('p', null, words('树节点、列表行、详情标题均可右键。菜单支持键盘导航，Esc 关闭；空白处和输入框保留浏览器菜单。', 'Try the tree, rows and detail title. Use keyboard navigation and Esc to close. Blank areas and inputs keep the browser menu.')),
          h('label', null, words('普通输入框 ', 'Regular input '), h('input', { placeholder: words('这里保留浏览器右键菜单', 'The browser menu is preserved here') }))),
        h('div', { className: 'demo-status', role: 'status', 'aria-live': 'polite' }, message || words('演示模式：所有操作仅显示模拟确认，不连接真实环境。', 'Demo mode: actions only show simulated confirmation; no live environment is contacted.'))),
      current && h('aside', { className: 'drawer-content-inner frame demo-details', 'data-resource-type': current[0], 'data-resource-id': current[4] },
        h('div', { className: 'title-wrapper' }, h('h2', { className: 'header-title', title: current[5] }, current[5]), h('button', { 'aria-label': words('关闭详情', 'Close details'), onClick: () => { setSelected(null); navigate(listHash(type)); } }, '×')),
        h('div', { className: 'toolbar' }, h('div', { className: 'operation-button-content' }, ...actions.map(([zh, english, state]) => {
          const label = words(zh, english);
          return h('button', { key: english, disabled: state === 'disabled', onClick: () => nativeAction(label), 'aria-label': label, className: state === 'danger' ? 'ant-btn-dangerous' : '' }, label);
        }))),
        h('div', { className: 'demo-detail-tabs detail-tabs', role: 'tablist', 'aria-label': words('模拟详情导航', 'Simulated detail navigation') }, ...detailTabs.map(([zh, english]) => h('button', {
          key: english, className: 'tab-item', role: 'tab', 'aria-selected': false,
          onClick: () => setMessage(words(`模拟导航：${current[5]} / ${zh}（仅演示，不请求真实环境）`, `Simulated navigation: ${current[5]} / ${english} (demo only; no live requests)`)),
        }, words(zh, english)))),
        h('section', null, h('h3', null, words('基本信息', 'Basic information')), h('dl', null, h('dt', null, words('名称', 'Name')), h('dd', null, current[5]), h('dt', null, 'ID'), h('dd', null, current[4]), h('dt', null, words('类型', 'Type')), h('dd', null, current[0]))),
        current[0] === 'vm' && h('section', { className: 'disk-section' },
          h('header', { className: 'demo-component-header' }, h('h3', null, words('磁盘', 'Disks')), h('button', { className: 'edit-icon', title: words('编辑磁盘', 'Edit disks'), onClick: () => nativeAction(words('编辑磁盘', 'Edit disks')) }, words('编辑', 'Edit'))),
          h('div', { className: 'disk-item' }, h('div', { className: 'ant-collapse-header', role: 'button', tabIndex: 0, 'aria-expanded': diskExpanded, 'aria-controls': 'demo-disk-content', onClick: event => toggleCard(event, 'disk'), onKeyDown: event => toggleCard(event, 'disk') },
            h('span', { className: 'demo-component-icon', 'data-testid': 'VirtualDisk24GradientBlueIcon' }, '▱'), h('span', { className: 'name' }, 'Ubuntu demo-1'), h('small', null, 'VIRTIO · 40 GiB')),
            h('div', { id: 'demo-disk-content', hidden: !diskExpanded, style: { padding: '0 12px 12px', fontSize: '12px', color: '#71849b' } }, words('模拟磁盘信息：总容量 40 GiB，已使用 4 GiB。', 'Simulated disk information: 40 GiB capacity, 4 GiB used.')))),
        current[0] === 'vm' && h('section', { className: 'nic-section' },
          h('header', { className: 'demo-component-header' }, h('h3', null, words('网络设备', 'Network devices')), h('button', { className: 'edit-icon', title: words('编辑网络设备', 'Edit network devices'), onClick: () => nativeAction(words('编辑网络设备', 'Edit network devices')) }, words('编辑', 'Edit'))),
          h('div', { className: 'nic-item' }, h('div', { className: 'ant-collapse-header', role: 'button', tabIndex: 0, 'aria-expanded': nicExpanded, 'aria-controls': 'demo-nic-content', onClick: event => toggleCard(event, 'nic'), onKeyDown: event => toggleCard(event, 'nic') },
            h('span', { className: 'demo-component-icon', 'data-testid': 'Nic24GradientBlueIcon' }, '⇄'), h('span', { className: 'name' }, 'NIC0'), h('small', null, 'Demo network')),
            h('div', { id: 'demo-nic-content', hidden: !nicExpanded, style: { padding: '0 12px 12px', fontSize: '12px', color: '#71849b' } }, words('模拟网卡信息：VIRTIO，连接演示网络。', 'Simulated NIC information: VIRTIO, connected to the demo network.')))),
        h('p', { className: 'demo-detail-note' }, words('这些按钮是模拟的原生入口，迁移按钮演示禁用状态。右键菜单不会自动确认操作。', 'These are simulated native controls. Migrate demonstrates a disabled action. The context menu never auto-confirms operations.')))),
    objectDialog && h('div', { className: 'demo-modal' }, h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': words('对象操作预览', 'Object action preview') },
      h('h2', null, objectDialog.action.label), h('p', { className: 'demo-object-target' }, `${objectDialog.resource.name} · ${objectDialog.resource.id}`),
      h('p', { className: 'demo-mock-notice' }, words('本地模拟：不连接真实环境，不执行实际业务操作。', 'Local simulation: no live connection or real resource operation.')),
      objectDialog.action.form === 'native-console' && h('div', { className: 'demo-console-preview' }, words('模拟控制台预览\n真实终端连接尚未接入。', 'Simulated console preview\nA real console connection is not configured.')),
      objectDialog.action.form === 'vm-snapshot-browser' && h('ul', null, ...(objectDialog.snapshot.snapshots || []).map(value => h('li', { key: value.id }, value.name))),
      ...fields.map(field => h('label', { className: 'demo-object-field', key: field.id }, h('span', null, field.label),
        field.type === 'select' ? h('select', { value: objectValues[field.id] || '', onChange: event => changeObjectValue(field.id, event) },
          h('option', { value: '' }, words('请选择', 'Choose…')), ...field.options.map(option => h('option', { key: option.value, value: option.value }, option.label))) :
          h('input', { type: field.type, min: field.min, max: field.max, value: objectValues[field.id] ?? '', onChange: event => changeObjectValue(field.id, event) }))),
      objectDialog.action.danger === 'danger' && h(React.Fragment, null,
        h('p', null, words('该操作可能造成数据丢失或服务中断。真实操作必须单独确认；此处仅演示确认流程。', 'This action can cause data loss or service interruption. This page only demonstrates confirmation.')),
        h('label', { className: 'demo-object-field' }, h('span', null, words('输入虚拟机名称以确认', 'Type the VM name to confirm')), h('input', { value: objectValues.confirmName || '', onChange: event => changeObjectValue('confirmName', event) }))),
      h('div', { className: 'demo-settings-actions' }, h('button', { onClick: () => setObjectDialog(null) }, words('取消', 'Cancel')),
        h('button', { className: 'primary', disabled: !objectValid, onClick: () => {
          try {
            const result = actionProvider.confirm(objectDialog, objectValues); setVmStatus(result.status);
            setMessage(words(`模拟操作：${objectDialog.action.label} / ${objectDialog.resource.name}。没有执行真实操作。`, `Simulated: ${objectDialog.action.label} / ${objectDialog.resource.name}. No real operation was performed.`));
          } catch { setMessage(words('模拟状态或权限已变化，请重新打开菜单。没有执行真实操作。', 'The simulated state or permissions changed. Reopen the menu. No real operation was performed.')); }
          setObjectDialog(null);
        } }, words('确认模拟操作', 'Confirm simulation'))))),
    rowMenu && h('div', { className: 'ant-dropdown demo-native-menu', style: { position: 'fixed', right: '24px', top: '180px' } }, h('ul', { role: 'menu', 'aria-label': words('原生行操作', 'Native row actions') },
      ...actionsFor(rowMenu[0]).map(([zh, english, state]) => h('li', { key: english, role: 'menuitem', 'aria-disabled': state === 'disabled', className: state === 'danger' ? 'danger' : state === 'disabled' ? 'disabled' : '',
        onClick: () => { if (state !== 'disabled') nativeAction(words(zh, english), rowMenu); } }, words(zh, english))))),
    settings && h('div', { className: 'demo-modal', 'data-c89-plugin-ui': '' }, h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': words('插件设置', 'Plugin settings') },
      h('h2', null, words('资源右键菜单设置', 'Resource context menu settings')),
      h(plugin.Settings, { preferences: plugin.store.getDraft(), store: plugin.store, locale: language, t: value => value }),
      h('div', { className: 'demo-settings-actions' }, h('span', { role: 'status' }, plugin.store.status().error || words(`内存配置 · 修订 ${plugin.store.status().revision}`, `In-memory settings · Revision ${plugin.store.status().revision}`)),
        h('button', { onClick: () => plugin.store.discard() }, words('丢弃修改', 'Discard')),
        h('button', { className: 'primary', disabled: !plugin.store.status().dirty, onClick: async () => { if (await plugin.store.save()) setMessage(words('设置已保存到演示内存；刷新后重置。', 'Settings saved in demo memory; reloading resets them.')); } }, words('保存', 'Save')),
        h('button', { onClick: () => { if (plugin.store.status().dirty) { setMessage(words('请先保存或丢弃设置修改。', 'Save or discard settings changes first.')); return; } setSettings(false); } }, words('完成', 'Done'))))),
    confirm && h('div', { className: 'demo-modal' }, h('section', { role: 'alertdialog', 'aria-modal': true, 'aria-label': words('模拟原生确认', 'Simulated native confirmation') },
      h('h2', null, words('模拟原生确认', 'Simulated native confirmation')), h('p', null, `${confirm.label} · ${confirm.name}`),
      h('p', null, words('仅演示原生确认流程，不执行任何资源操作。', 'This only demonstrates native confirmation; no resource operation is performed.')),
      h('div', { className: 'demo-settings-actions' }, h('button', { onClick: () => setConfirm(null) }, words('取消', 'Cancel')), h('button', { className: 'primary', onClick: () => { setMessage(words(`模拟操作已确认：${confirm.label} / ${confirm.id}`, `Simulated action confirmed: ${confirm.label} / ${confirm.id}`)); setConfirm(null); } }, words('确认演示', 'Confirm demo'))))));
}
if (!window.location.hash) window.location.hash = '/clusters/demo-cluster?view=%22vms%22';
await plugin.store.load();
ReactDOM.render(h(App), document.getElementById('demo-root'));
const stop = plugin.activate(message => notify(message));
window.addEventListener('pagehide', () => { stop?.(); plugin.store.dispose(); }, { once: true });
