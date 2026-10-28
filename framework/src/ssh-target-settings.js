const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
export const DEVICE_CLASSES = ['disk', 'gpu', 'usb', 'pcie'];
export function defaultDevicePolicy() { return { version: 1, classes: Object.fromEntries(DEVICE_CLASSES.map(category => [category, { mode: 'all', ids: [] }])) }; }
export function validateDevicePolicy(policy) {
  if (!exact(policy, ['version', 'classes']) || policy.version !== 1 || !exact(policy.classes, DEVICE_CLASSES) || Object.keys(policy.classes).length !== 4) throw new Error('SSH_DEVICE_POLICY_INVALID');
  const classes = {};
  for (const category of DEVICE_CLASSES) {
    const value = policy.classes[category];
    if (!exact(value, ['mode', 'ids']) || !['all', 'custom'].includes(value.mode) || !Array.isArray(value.ids) || value.ids.length > 1000 || value.ids.some(id => !identifier(id)) || new Set(value.ids).size !== value.ids.length || value.mode === 'all' && value.ids.length) throw new Error('SSH_DEVICE_POLICY_INVALID');
    classes[category] = { mode: value.mode, ids: [...value.ids].sort() };
  }
  return { version: 1, classes };
}
export function validManagementAddress(value) {
  if (typeof value !== 'string' || value.includes('%')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return value.split('.').every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) && !/^(?:0\.|127\.|169\.254\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(value);
  try { const address = new URL(`http://[${value}]/`).hostname.slice(1, -1); return !['::', '::1'].includes(address) && !/^(?:fe[89ab]|ff|::ffff:)/i.test(address); } catch { return false; }
}
export function hostTargetReason(host, existing) {
  if (existing.some(row => row.hostId === host.id)) return 'existing';
  return identifier(host.id) && identifier(host.clusterId) && validManagementAddress(host.address) ? 'available' : 'invalid';
}
export function addHostTargets(existing, inventory, hostIds, port = 22) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(hostIds) || !hostIds.length || new Set(hostIds).size !== hostIds.length) throw new Error('SSH_HOST_SELECTION_INVALID');
  const additions = hostIds.map(id => {
    const matches = inventory.filter(host => host.id === id);
    if (matches.length !== 1 || hostTargetReason(matches[0], existing) !== 'available') throw new Error('SSH_HOST_SELECTION_CHANGED');
    const host = matches[0]; return { hostId: host.id, clusterId: host.clusterId, address: host.address, port, hostKeySha256: '', connection: null, devicePolicy: defaultDevicePolicy() };
  });
  if (existing.length + additions.length > 500) throw new Error('SSH_HOST_SELECTION_LIMIT');
  return [...existing, ...additions];
}
export function validateDeviceInventory(value, hostId, now = Date.now()) {
  if (!exact(value, ['version', 'hostId', 'category', 'complete', 'inventoryRevision', 'expiresAt', 'items']) || value.version !== 1 || value.hostId !== hostId || !identifier(hostId) || value.category !== 'disk' || value.complete !== true || !text(value.inventoryRevision, 4096) || !text(value.expiresAt, 64) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + 600000 || !Array.isArray(value.items) || value.items.length > 1000) throw new Error('SSH_DEVICE_INVENTORY_INVALID');
  const ids = new Set();
  for (const row of value.items) {
    if (!exact(row, ['id', 'label', 'model', 'selectable', 'selectionToken', 'reason']) || !identifier(row.id) || ids.has(row.id) || !text(row.label, 512) || !text(row.model, 512) || typeof row.selectable !== 'boolean' || row.selectable && !text(row.selectionToken, 8192) || !row.selectable && row.reason !== 'SSH_DEVICE_IDENTITY_UNVERIFIED') throw new Error('SSH_DEVICE_INVENTORY_INVALID');
    ids.add(row.id);
  }
  return JSON.parse(JSON.stringify(value));
}
export const TARGET_CSS = `
.pk-ssh-scope-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.pk-ssh-scope-option{border:1px solid #dfe8f2;border-radius:7px;padding:12px;background:#fbfcff;font-size:12px}.pk-ssh-scope-title{display:flex;gap:8px;justify-content:space-between;margin-bottom:12px}.pk-ssh-scope-option label{display:flex;align-items:center;gap:7px;margin:10px 0}.pk-ssh-scope-option input{accent-color:#1385ee}.pk-ssh-target-muted{font-size:12px;color:#71849b;line-height:1.6}.pk-ssh-scope-badge{font-size:10px;background:#edf3fb;color:#637d9a;padding:2px 5px;border-radius:4px}.pk-ssh-device-list{max-height:280px;overflow:auto;margin:12px 0;border:1px solid #dfe8f2;border-radius:7px}.pk-ssh-device-list table{width:100%;border-collapse:collapse;font-size:12px}.pk-ssh-device-list td,.pk-ssh-device-list th{padding:9px;text-align:left;border-bottom:1px solid #e8eef6;overflow-wrap:anywhere}.pk-ssh-device-list th{background:#f5f8fc;position:sticky;top:0}.pk-ssh-scope-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.pk-ssh-scope-search{display:flex;gap:8px;align-items:center}.pk-ssh-scope-search input{font:inherit;min-width:0;flex:1;border:1px solid #d7e3f0;padding:8px;border-radius:6px}.pk-ssh-bulk-backdrop{position:fixed;inset:0;z-index:1650;background:#142c4b66;display:grid;place-items:center;padding:24px}.pk-ssh-bulk{background:#fff;color:#243650;width:min(980px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;border-radius:12px;overflow:hidden;box-shadow:0 20px 70px #102b4a44;font-size:13px;outline:none}.pk-ssh-bulk header{padding:22px 26px 16px;display:flex;gap:16px;justify-content:space-between;flex-shrink:0}.pk-ssh-bulk h3{margin:0 0 8px}.pk-ssh-bulk button{font:inherit;background:white;border:1px solid #d7e3f0;border-radius:6px;padding:7px 12px;cursor:pointer}.pk-ssh-bulk button:disabled{opacity:.5;cursor:default}.pk-ssh-bulk .pk-ssh-bulk-primary.pk-ssh-bulk-primary{background:#087ef5;border-color:#087ef5;color:white}.pk-ssh-bulk-body{padding:0 26px 12px;overflow:auto;min-height:0}.pk-ssh-bulk-filters{display:grid;grid-template-columns:200px minmax(0,1fr);gap:16px}.pk-ssh-bulk-filters label{display:flex;flex-direction:column;gap:6px}.pk-ssh-bulk input:not([type=checkbox]),.pk-ssh-bulk select{font:inherit;background:white;border:1px solid #d7e3f0;border-radius:6px;padding:8px;min-width:0}.pk-ssh-bulk input[type=checkbox]{accent-color:#1385ee}.pk-ssh-bulk footer{padding:16px 26px;border-top:1px solid #e7edf5;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0}.pk-ssh-bulk footer button+button{margin-left:10px}.pk-ssh-bulk-defaults{background:#f7f9fc;border:1px solid #e7edf5;border-radius:7px;padding:14px;margin-top:14px}.pk-ssh-bulk-defaults label{display:flex;align-items:center;gap:12px;margin-bottom:8px}.pk-ssh-bulk-defaults input{width:90px}.pk-ssh-bulk-notice{padding:12px;background:#fff8e8;color:#80551b;border-radius:7px;margin-top:12px;line-height:1.7}.pk-ssh-bulk button:focus-visible,.pk-ssh-bulk input:focus-visible,.pk-ssh-bulk select:focus-visible{outline:2px solid #1385ee;outline-offset:2px}@media(max-width:720px){.pk-ssh-scope-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pk-ssh-bulk-filters{grid-template-columns:1fr}.pk-ssh-bulk-body{padding:0 18px 12px}.pk-ssh-bulk header,.pk-ssh-bulk footer{padding:16px 18px}.pk-ssh-bulk footer{flex-wrap:wrap}}
`;

export function createSshTargetSettings(React) {
  const h = React.createElement, { useState, useEffect, useRef } = React;
  function BulkHostPicker({ inventory, hosts, locale = 'zh-CN', onAdd, onClose, disabled = false }) {
    const t = (zh, en) => locale === 'en-US' ? en : zh;
    const [query, setQuery] = useState(''), [cluster, setCluster] = useState(''), [selected, setSelected] = useState([]), [port, setPort] = useState(22), [error, setError] = useState(false);
    const dialog = useRef(null), focus = useRef(null);
    useEffect(() => { focus.current = document.activeElement; dialog.current?.focus(); return () => focus.current?.focus(); }, []);
    useEffect(() => { const node = dialog.current; node?.addEventListener('keydown', keydown); return () => node?.removeEventListener('keydown', keydown); }, [disabled, onClose]);
    const visible = inventory.hosts.filter(host => (!cluster || host.clusterId === cluster) && [host.name, host.address, host.id].some(value => value.toLowerCase().includes(query.toLowerCase())));
    const selectedHosts = inventory.hosts.filter(host => selected.includes(host.id) && hostTargetReason(host, hosts) === 'available');
    const available = visible.filter(host => hostTargetReason(host, hosts) === 'available');
    function add() { if (disabled || !selectedHosts.length) return; try { const next = addHostTargets(hosts, inventory.hosts, selectedHosts.map(row => row.id), Number(port)); onAdd(next); onClose(); } catch { setError(true); } }
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!disabled) onClose(); return; }
      if (event.key !== 'Tab') return;
      event.stopPropagation(); const controls = [...dialog.current.querySelectorAll('button,input,select')].filter(node => !node.disabled), first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && [first, dialog.current].includes(document.activeElement) || !event.shiftKey && document.activeElement === last) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    }
    return h('div', { className: 'pk-ssh-bulk-backdrop' }, h('section', { className: 'pk-ssh-bulk', ref: dialog, tabIndex: -1, role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'pk-ssh-bulk-title' },
      h('style', null, TARGET_CSS), h('header', null, h('div', null, h('h3', { id: 'pk-ssh-bulk-title' }, t('从 CloudTower 批量添加主机', 'Add hosts from CloudTower')), h('div', { className: 'pk-ssh-target-muted' }, t('先选主机，再统一加入连接草稿。已有目标保持原配置。', 'Select hosts for the connection draft. Existing targets keep their settings.'))), h('button', { type: 'button', disabled, 'aria-label': t('关闭批量选择', 'Close host selection'), onClick: onClose }, '×')),
      h('div', { className: 'pk-ssh-bulk-body' },
        h('div', { className: 'pk-ssh-bulk-filters' }, h('label', null, t('集群', 'Cluster'), h('select', { value: cluster, disabled, onChange: event => setCluster(event.target.value) }, h('option', { value: '' }, t('全部集群', 'All clusters')), ...inventory.clusters.map(row => h('option', { key: row.id, value: row.id }, row.name)))), h('label', null, t('搜索主机名称、地址或 ID', 'Search host name, address or ID'), h('input', { value: query, disabled, onChange: event => setQuery(event.target.value.slice(0, 512)) }))),
        h('div', { className: 'pk-ssh-scope-actions' }, h('strong', null, t(`已选 ${selectedHosts.length} 台`, `${selectedHosts.length} selected`)), h('button', { type: 'button', disabled: disabled || !available.length, onClick: () => setSelected([...new Set([...selected, ...available.map(row => row.id)])]) }, t('全选当前可添加项', 'Select available results')), h('button', { type: 'button', disabled: disabled || !selected.length, onClick: () => setSelected([]) }, t('清空选择', 'Clear selection'))),
        h('div', { className: 'pk-ssh-device-list' }, h('table', null, h('thead', null, h('tr', null, ...[t('选择', 'Select'), t('主机 / ID', 'Host / ID'), t('所属集群', 'Cluster'), t('管理地址', 'Management address'), t('状态', 'Status')].map(label => h('th', { key: label, scope: 'col' }, label)))), h('tbody', null, ...visible.map(host => {
          const reason = hostTargetReason(host, hosts); return h('tr', { key: host.id }, h('td', null, h('input', { type: 'checkbox', 'aria-label': t(`选择主机 ${host.id}`, `Select host ${host.id}`), disabled: disabled || reason !== 'available', checked: selected.includes(host.id) && reason === 'available', onChange: event => setSelected(event.target.checked ? [...selected, host.id] : selected.filter(id => id !== host.id)) })), h('td', null, host.name, h('div', { className: 'pk-ssh-target-muted' }, host.id)), h('td', null, inventory.clusters.find(row => row.id === host.clusterId)?.name || host.clusterId), h('td', null, host.address || '—'), h('td', null, reason === 'existing' ? t('已配置', 'Configured') : reason === 'available' ? t('可添加', 'Available') : t('管理地址不可用', 'Management address unavailable')));
        })))), !visible.length && h('p', null, t('没有匹配主机。', 'No matching hosts.')),
        h('div', { className: 'pk-ssh-bulk-defaults' }, h('label', null, t('SSH 端口', 'SSH port'), h('input', { type: 'number', min: 1, max: 65535, value: port, disabled, onChange: event => setPort(event.target.value) })), h('p', null, t('继承主机 / 集群 / 全局凭据，不复制秘密。', 'Inherit host / cluster / global credentials without copying secrets.')), h('p', null, t('硬盘、GPU、USB、PCIe 默认全部允许，加入后可逐主机自定义。未接入类别不产生执行能力。', 'Disks, GPU, USB and PCIe default to allow all; customize per host after adding. Unimplemented classes grant no execution capability.'))),
        h('div', { className: 'pk-ssh-bulk-notice' }, t('加入草稿不会连接主机。每台新主机仍须独立确认指纹，再统一保存；采集命令另行审核。', 'Adding a draft does not connect. Independently confirm each new host key before saving; collection commands require a separate review.')), error && h('p', { role: 'alert' }, t('无法加入，请重新核对清单、端口及目标数量；草稿未改变。', 'Cannot add. Check the inventory, port and target count; the draft was not changed.'))),
      h('footer', null, h('span', { className: 'pk-ssh-target-muted' }, t('仅加入连接草稿', 'Adds to connection draft only')), h('div', null, h('button', { type: 'button', disabled, onClick: onClose }, t('取消', 'Cancel')), h('button', { type: 'button', className: 'pk-ssh-bulk-primary', disabled: disabled || !selectedHosts.length || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535 || hosts.length + selectedHosts.length > 500, onClick: add }, t(`将 ${selectedHosts.length} 台主机加入草稿`, `Add ${selectedHosts.length} hosts to draft`))))));
  }
  function DeviceScopeEditor({ hostId, policy, locale = 'zh-CN', capabilities, inventory, loading = false, inventoryError = '', disabled = false, onChange, onLoad, onSelect }) {
    const t = (zh, en) => locale === 'en-US' ? en : zh, [query, setQuery] = useState('');
    const names = { disk: 'Disks', gpu: 'GPU', usb: 'USB', pcie: 'PCIe' }, items = inventory?.items || [], ids = policy.classes.disk.ids;
    const visible = items.filter(row => [row.label, row.model, row.id].some(value => value.toLowerCase().includes(query.toLowerCase())));
    function mode(category, next) { onChange({ ...policy, classes: { ...policy.classes, [category]: { mode: next, ids: [] } } }); }
    return h('section', { className: 'pk-ssh-device-scope', 'aria-label': t('设备访问范围', 'Device access scope') }, h('style', null, TARGET_CSS), h('h5', null, t('设备访问范围', 'Device access scope')),
      h('p', { className: 'pk-ssh-target-muted' }, t('范围不授予命令权限。自定义为空表示不允许该类设备；库存变更和换盘须重新核对、审核。', 'Scope does not approve commands. An empty custom selection allows no devices; inventory changes and replacements require verification and review.')),
      h('div', { className: 'pk-ssh-scope-grid' }, ...DEVICE_CLASSES.map(category => {
        const custom = capabilities?.classes?.[category]?.custom === true, value = policy.classes[category];
        return h('div', { key: category, className: 'pk-ssh-scope-option' }, h('div', { className: 'pk-ssh-scope-title' }, h('strong', null, category === 'disk' ? t('硬盘', 'Disks') : names[category]), h('span', { className: 'pk-ssh-scope-badge' }, custom ? t('清单已接入', 'Inventory ready') : t('能力未接入', 'Not integrated'))),
          h('label', null, h('input', { type: 'radio', name: `pk-scope-${hostId}-${category}`, checked: value.mode === 'all', disabled, onChange: () => mode(category, 'all') }), t('全部允许', 'Allow all')),
          h('label', null, h('input', { type: 'radio', name: `pk-scope-${hostId}-${category}`, checked: value.mode === 'custom', disabled: disabled || !custom, onChange: () => mode(category, 'custom') }), t('自定义', 'Custom')),
          h('div', { className: 'pk-ssh-target-muted' }, !custom ? t('暂无可用清单或受控操作', 'No inventory or controlled operation') : value.mode === 'all' ? t('审核完整库存，身份不明时拒绝执行', 'Review the full inventory; unverified identity blocks execution') : t(`已选 ${value.ids.length} 项；空列表不允许任何设备`, `${value.ids.length} selected; empty allows no devices`)));
      })),
      policy.classes.disk.mode === 'custom' && h('div', null,
        h('div', { className: 'pk-ssh-scope-actions' }, h('button', { type: 'button', disabled: disabled || loading || capabilities?.classes?.disk?.inventory !== true, onClick: onLoad }, loading ? t('正在读取…', 'Loading…') : t('刷新磁盘清单', 'Refresh disk inventory')),
          h('button', { type: 'button', disabled: disabled || !ids.length, onClick: () => onChange({ ...policy, classes: { ...policy.classes, disk: { mode: 'custom', ids: [] } } }) }, t('清空磁盘选择', 'Clear disk selection'))),
        inventoryError && h('p', { role: 'alert', className: 'pk-ssh-notice' }, t('磁盘清单不可用或已过期，请刷新后重选；连接草稿已保留。', 'Disk inventory is unavailable or expired. Refresh and reselect; the connection draft is retained.')),
        inventory && h('div', null, h('label', { className: 'pk-ssh-scope-search' }, t('搜索磁盘', 'Search disks'), h('input', { value: query, disabled, onChange: event => setQuery(event.target.value.slice(0, 512)) })),
          h('div', { className: 'pk-ssh-scope-actions' }, h('button', { type: 'button', disabled: disabled || loading || !visible.some(row => row.selectable), onClick: () => onSelect([...new Set([...ids, ...visible.filter(row => row.selectable).map(row => row.id)])]) }, t('选择当前可用项', 'Select available results'))),
          h('div', { className: 'pk-ssh-device-list' }, h('table', null, h('thead', null, h('tr', null, ...[t('选择', 'Select'), t('磁盘 / ID', 'Disk / ID'), t('型号', 'Model'), t('状态', 'Status')].map(label => h('th', { key: label, scope: 'col' }, label)))), h('tbody', null, ...visible.map(row => h('tr', { key: row.id }, h('td', null, h('input', { type: 'checkbox', 'aria-label': t(`选择磁盘 ${row.id}`, `Select disk ${row.id}`), checked: ids.includes(row.id), disabled: disabled || loading || !row.selectable, onChange: event => onSelect(event.target.checked ? [...ids.filter(id => id !== row.id), row.id] : ids.filter(id => id !== row.id)) })), h('td', null, row.label, h('div', { className: 'pk-ssh-target-muted' }, row.id)), h('td', null, row.model), h('td', null, row.selectable ? t('可选择', 'Available') : t('设备身份待核实', 'Device identity unverified'))))))),
          !visible.length && h('p', null, t('没有匹配磁盘。', 'No matching disks.'))),
        ids.some(id => !items.some(row => row.id === id)) && h('p', { className: 'pk-ssh-notice' }, t('部分已选设备尚未在当前清单中核实；保存时由服务端重新验证，不会自动移除或放宽范围。', 'Some selected devices are not verified in the current inventory. The server revalidates on save; the selection is never silently removed or widened.'))));
  }
  return { BulkHostPicker, DeviceScopeEditor };
}
