// DOM adapter for the observed Tower 4.9 tree, table and sidebar structure.
// Unknown structures deliberately retain the browser's context menu.
import { RESOURCE_TYPES } from './configuration.js';
const routes = { datacenters: 'datacenter', clusters: 'cluster', hosts: 'host', vms: 'vm', 'vm-volumes': 'vmVolume', disks: 'disk' };
const views = { vms: 'vm', hosts: 'host', disks: 'disk', vmVolumes: 'vmVolume' };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const sameResource = (a, b) => Boolean(a && b && a.type === b.type && a.id === b.id);
export function resourceUrl(value, origin, primary = false) {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== '/' || url.search || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    const [path, search = ''] = url.hash.slice(1).split('?');
    const match = /^\/(datacenters|clusters|hosts|vms|vm-volumes|disks)\/([A-Za-z0-9_-]{1,128})\/?$/.exec(path);
    const params = new URLSearchParams(search);
    if (!primary && params.has('sidebar') && /^\/(overview|datacenters|clusters|hosts|vms|vm-volumes|disks)(\/[A-Za-z0-9_-]{1,128})?\/?$/.test(path)) {
      const sidebar = JSON.parse(params.get('sidebar'));
      if (!RESOURCE_TYPES.includes(sidebar?.type) || sidebar.type === 'organization' || !validId(sidebar.id)) return null;
      return { type: sidebar.type, id: sidebar.id, href: url.href };
    }
    if (!match) return null;
    if (primary && params.has('sidebar')) { params.delete('sidebar'); url.hash = path + (params.size ? `?${params}` : ''); }
    return { type: routes[match[1]], id: match[2], href: url.href };
  } catch { return null; }
}
export function currentResource(win) { return resourceUrl(win.location.href, win.location.origin); }
const label = node => (node?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
const normalized = value => String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
const nameHeaders = ['名称', 'name'];
// Full, distinctive combinations from the supplied Tower screenshots. A generic
// name/MAC/VLAN column alone cannot distinguish physical and VM-owned objects.
const tableSignatures = [
  ['nic', [nameHeaders, ['mac地址', 'mac address'], ['rdma'], ['网口用途', 'nic usage', 'nic purpose']]],
  ['vmGroup', [nameHeaders, ['组目录', 'group directory'], ['虚拟机数量', 'vm count']]],
  ['vmPlacementGroup', [nameHeaders, ['状态', 'status'], ['虚拟机数', 'vm count'], ['描述', 'description'], ['创建时间', 'created at', 'creation time']]],
  ['vmNetwork', [nameHeaders, ['vlan类型', 'vlan type'], ['vlan id'], ['所属虚拟分布式交换机', '所属分布式虚拟交换机', 'distributed virtual switch', 'virtual distributed switch']]],
  ['systemNetwork', [nameHeaders, ['类型', 'type'], ['子网掩码', 'subnet mask'], ['网关', 'gateway'], ['ip地址', 'ip address']]],
  ['vmSnapshot', [nameHeaders, ['源虚拟机', 'source vm'], ['独占物理容量', 'exclusive physical capacity'], ['快照时间', 'snapshot time'], ['关联快照计划', 'associated snapshot plan']]],
  ['vmSnapshot', [nameHeaders, ['独占物理容量', 'exclusive physical capacity', 'size'], ['local_created_at', '快照时间', 'snapshot time'], ['snapshot_group', '关联快照计划', 'associated snapshot plan']]],
  ['snapshotPlan', [nameHeaders, ['上次快照任务结果', 'last snapshot task result'], ['快照对象数', 'snapshot object count'], ['可用快照组', 'available snapshot groups']]],
  ['vds', [nameHeaders, ['关联主机数', 'associated host count'], ['网口绑定模式', 'nic bonding mode'], ['网口连通性检测', 'nic connectivity check']]],
];
function headerEvidence(row, win) {
  const table = row.closest('table'), boundary = '.ant-table-container,.ant-table-wrapper,.ant-table', wrapper = table?.closest(boundary), pane = row.closest('.drawer-content-inner');
  let headers = [...(table?.querySelectorAll('thead th') || [])].filter(node => node.closest('table') === table);
  if (!headers.length && wrapper) headers = [...wrapper.querySelectorAll('thead th')].filter(node => node.closest(boundary) === wrapper);
  headers = headers.filter(node => isVisible(node, win) && node.closest('.drawer-content-inner') === pane && !node.closest('[hidden],[aria-hidden="true"]'));
  const tokens = new Set(headers.flatMap(node => [label(node), node.getAttribute('unique'), ...[...node.classList].filter(name => name.startsWith('cell_')).map(name => name.slice(5))]).filter(Boolean).map(normalized));
  const has = aliases => aliases.some(value => tokens.has(normalized(value)));
  const matches = new Set(tableSignatures.filter(([, columns]) => columns.every(has)).map(([type]) => type));
  // Observed 4.9 snapshot table: name/local_created_at/snapshot_group. It can
  // live inside the VM drawer while the outer route still says view="vms".
  const snapshotMarker = has(['快照时间', 'snapshot time', 'snapshot_group']);
  return { type: matches.size === 1 ? [...matches][0] : null, conflict: matches.size > 1, snapshotMarker };
}
function rowType(row, win, evidence) {
  if (evidence.conflict) return null;
  if (row.closest('.drawer-content-inner') && currentResource(win)?.type === 'vm' && ['disk', 'nic'].includes(evidence.type)) return null;
  if (evidence.type) return evidence.type;
  if (evidence.snapshotMarker) return null;
  // The surrounding list's view does not identify a child table in a VM pane.
  if (row.closest('.drawer-content-inner') && currentResource(win)?.type === 'vm') return null;
  let type;
  try { type = views[JSON.parse(new URLSearchParams(win.location.hash.split('?')[1]).get('view'))]; } catch {}
  if (!type) type = { '/vms': 'vm', '/hosts': 'host', '/vm-volumes': 'vmVolume', '/disks': 'disk' }[win.location.hash.slice(1).split('?')[0].replace(/\/$/, '')];
  return type || null;
}
function detailFrame(node) {
  const direct = node.closest('.frame'); if (direct) return direct;
  const pane = node.closest('.drawer-content-inner');
  const frames = pane?.querySelectorAll('.detail-sidebar-header .frame');
  return frames?.length === 1 ? frames[0] : null;
}
function treeResource(element, win) {
  for (const [selector, type] of [['.host-info', 'host'], ['.cluster-info', 'cluster'], ['.datacenter-info', 'datacenter']]) {
    const node = element.closest(selector);
    if (!node) continue;
    const id = node.getAttribute('data-test') || node.querySelector('.response-area[data-test]')?.getAttribute('data-test');
    const nameNode = node.querySelector('.name');
    if (!nameNode || !label(nameNode)) return null;
    // Datacenter data-test contains a display name on some Tower builds.
    if (!validId(id) || id === label(nameNode)) {
      if (type !== 'datacenter') return null;
      return { type, id: null, name: label(nameNode), element: node, select: nameNode, href: null };
    }
    return { type, id, name: label(nameNode), element: node, select: nameNode,
      href: new URL(`#/${type === 'cluster' ? 'clusters' : type === 'host' ? 'hosts' : 'datacenters'}/${id}?view=%22detail%22`, win.location.origin).href };
  }
  const organization = element.closest('.organization-info,.resource-topo-content .infra-area');
  if (organization) return { type: 'organization', id: 'current', name: label(organization.querySelector('.name') || organization), element: organization, select: null, href: new URL('#/overview', win.location.origin).href };
  return null;
}
export function identifyResource(element, win) {
  if (!element?.closest || element.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="menu"],[role="dialog"],.ant-modal,.ant-dropdown,.c89-plugin-root,[data-rivetin-context-menu],[data-rivetin-object-menu],[data-rivetin-resource-menu]')) return null;
  const tree = treeResource(element, win); if (tree) return tree;
  const collapse = element.closest('.ant-collapse-item,.nic-item'), disk = element.closest('.disk-item');
  const current = currentResource(win);
  if (current?.type === 'vm' && (disk || collapse?.querySelector('[data-testid="Nic24GradientBlueIcon"]'))) {
    const node = disk || collapse, header = node.querySelector('.ant-collapse-header');
    const frame = detailFrame(node), parentName = label(frame?.querySelector('.title-wrapper .header-title'));
    if (frame && parentName) return { ...current, name: label(node.querySelector('.name') || header || node), parentName, parentVmId: current.id, internal: disk ? 'vmDisk' : 'nic', element: node, select: null };
  }
  const row = element.closest('tr[data-row-key]'), cell = row?.querySelector('td[unique="name"],td.cell_name,td[unique="path"],td.cell_path');
  const evidence = row ? headerEvidence(row, win) : null;
  const anchor = element.closest('a[href]');
  if (anchor) {
    const parsed = resourceUrl(anchor.href, win.location.origin);
    if (cell?.contains(anchor) && evidence?.conflict) return null;
    if (cell?.contains(anchor) && evidence?.snapshotMarker && !evidence.type) return null;
    if (parsed && cell?.contains(anchor) && evidence?.type && (parsed.type !== evidence.type || parsed.id !== row.getAttribute('data-row-key'))) return null;
    if (parsed && label(anchor)) return { ...parsed, name: label(anchor), element: anchor, select: anchor };
    if (!cell?.contains(anchor) || !evidence?.type) return null;
  }
  if (row && cell) {
    const targetCell = element.closest('td'), targetColumn = targetCell?.getAttribute('unique');
    if (element.closest('button') && !['name', 'path', '_action_'].includes(targetColumn)) return null;
    const id = row.getAttribute('data-row-key'); if (!validId(id)) return null;
    const anchors = [...cell.querySelectorAll('a[href]')].map(a => ({ ...resourceUrl(a.href, win.location.origin), a })).filter(a => a.type && a.id === id);
    const inferred = rowType(row, win, evidence);
    let type = evidence.conflict ? null : anchors.length === 1 ? anchors[0].type : inferred;
    if (evidence.type && type !== evidence.type) return null;
    if (!type || !label(cell)) return null;
    return { type, id, name: label(cell), ...(type === 'vmSnapshot' && current?.type === 'vm' && row.closest('.drawer-content-inner') ? { parentVmId: current.id } : {}), element: row, select: anchors.length === 1 ? anchors[0].a : cell, href: anchors.length === 1 ? anchors[0].href : null };
  }
  const title = element.closest('.title-wrapper .header-title,.title-wrapper .title-content,.title-wrapper .title-text');
  const titleResource = title?.closest('.frame') ? current : resourceUrl(win.location.href, win.location.origin, true);
  if (title && titleResource && label(title)) return { ...titleResource, name: label(title), element: title, select: null };
  return null;
}
export function isVisible(element, win) {
  if (!element?.isConnected || element.closest('[hidden],[aria-hidden="true"],.ant-dropdown-hidden,.__hidden')) return false;
  const style = win.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}
export function nativeActions(resource, win) {
  if (!sameResource(resource, currentResource(win))) return [];
  if (resource.internal) return internalActions(resource, win);
  const frames = [...win.document.querySelectorAll('.frame')].filter(frame => {
    const title = frame.querySelector('.title-wrapper .header-title');
    return title && label(title) === resource.name && isVisible(frame, win);
  });
  let scope = frames.length === 1 ? frames[0] : null;
  let bar = scope?.querySelector('.toolbar');
  if (!scope && !new URLSearchParams(win.location.hash.split('?')[1]).has('sidebar')) {
    const titles = [...win.document.querySelectorAll('.title-wrapper .title-content,.title-wrapper .title-text')].filter(title => label(title) === resource.name && isVisible(title, win));
    if (titles.length === 1) { scope = titles[0].closest('.title-wrapper').parentElement; bar = scope.querySelector('.actions-wrapper'); }
  }
  if (!bar) return [];
  const iconLabels = { RestartNew16GradientGrayIcon: ['重启', 'Restart'], SuspendedPause16GradientOrangeIcon: ['暂停', 'Suspend'], MoreEllipsis316BoldBlueIcon: ['更多操作…', 'More actions…'], MoreEllipsis316BoldSecondaryIcon: ['更多操作…', 'More actions…'] };
  const result = [...bar.querySelectorAll('button,.more-icon.ant-dropdown-trigger')].filter(button => isVisible(button, win)).slice(0, 30).flatMap(button => {
    const icon = button.querySelector('[data-testid]')?.getAttribute('data-testid');
    const name = button.getAttribute('aria-label') || button.getAttribute('title') || label(button);
    const inferred = iconLabels[icon];
    if (!name && !inferred) return [];
    return [{ button, label: name || inferred[0], english: !name ? inferred[1] : null,
      disabled: button.disabled || button.getAttribute('aria-disabled') === 'true' || Boolean(button.closest('[aria-disabled="true"]')),
      danger: button.classList.contains('ant-btn-dangerous') || /^(删除|卸载|移至回收站|Delete|Unmount|Move to recycle bin)$/i.test(name) }];
  });
  const tabScope = scope.closest('.drawer-content-inner') || scope;
  for (const tab of tabScope.querySelectorAll('.detail-tabs .tab-item')) {
    if (label(tab) && isVisible(tab, win)) result.push({ button: tab, label: label(tab), disabled: tab.getAttribute('aria-disabled') === 'true', danger: false });
  }
  return result;
}
function internalActions(resource, win) {
  if (resource.type !== 'vm' || !['vmDisk', 'nic'].includes(resource.internal)) return [];
  if (!resource.element.isConnected || !isVisible(resource.element, win)) return [];
  const frame = detailFrame(resource.element);
  if (!frame || label(frame.querySelector('.title-wrapper .header-title')) !== resource.parentName) return [];
  const result = [], header = resource.element.querySelector('.ant-collapse-header');
  if (header && isVisible(header, win) && ['true', 'false'].includes(header.getAttribute('aria-expanded'))) result.push({
    button: header, kind: 'internal-toggle', ownerFrame: frame,
    label: header.getAttribute('aria-expanded') === 'true' ? '收起详情' : '展开详情',
    english: header.getAttribute('aria-expanded') === 'true' ? 'Collapse details' : 'Expand details',
    disabled: Boolean(header.closest('[disabled],[aria-disabled="true"],[inert],.ant-collapse-item-disabled')),
  });
  // Only a matching immediate section heading can supply an edit control.
  // Searching a broad ancestor for a unique button can select another device's editor.
  let section = resource.element;
  const boundary = resource.element.closest('.drawer-content-inner') || frame;
  for (let i = 0; i < 6 && section && section !== boundary; i++, section = section.parentElement) {
    const heading = section.firstElementChild;
    if (!heading || heading.contains(resource.element) || ![...section.children].slice(1).some(child => child.contains(resource.element))) continue;
    const buttons = [...heading.querySelectorAll('button.edit-icon')];
    if (buttons.length === 1) {
      const button = buttons[0];
      const title = label(heading).replace(label(button), '').trim();
      const expected = resource.internal === 'vmDisk' ? ['磁盘', 'Disks'] : ['网络设备', 'Network devices', 'Network adapters'];
      if (!expected.includes(title)) continue;
      if (isVisible(button, win)) result.push({ button, label: resource.internal === 'vmDisk' ? '编辑磁盘配置…' : '编辑网络配置…', english: resource.internal === 'vmDisk' ? 'Edit disk configuration…' : 'Edit network configuration…', disabled: button.disabled || button.getAttribute('aria-disabled') === 'true' });
      break;
    }
  }
  return result;
}
