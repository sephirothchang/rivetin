const normalize = value => (value || '').trim().replace(/\s+/g, ' ');
const entry = (kind, labels, result, extra = {}) => ({ kind, labels, result, ...extra });
// Labels, icon names and safe editor titles were observed in native Tower 4.9
// controls. This registry describes entry points, never resource API operations.
const entries = {
  basic: entry('section', ['基本信息', 'Basic information'], 'dialog', { modalTitles: ['编辑虚拟机', 'Edit VM'] }),
  disk: entry('section', ['磁盘', 'Disks'], 'dialog', { modalTitles: ['编辑磁盘', 'Edit disks'] }),
  nic: entry('section', ['网络设备', 'Network devices'], 'dialog', { modalTitles: ['编辑虚拟机的网络设备', 'Edit network devices'] }),
  migration: entry('toolbar', ['迁移', 'Migrate'], 'dialog', { icons: ['Migrate16GradientBlueIcon'], modalTitles: ['迁移虚拟机', 'Migrate VM'] }),
  snapshots: entry('tab', ['快照', 'Snapshots'], 'tab', { tabView: 'snapshot' }),
  monitor: entry('tab', ['监控', 'Monitor'], 'handoff'),
  'network-security': entry('tab', ['网络安全', 'Network security'], 'handoff'),
  backup: entry('tab', ['备份与容灾', 'Backup and disaster recovery'], 'handoff'),
  events: entry('tab', ['事件', 'Events'], 'handoff'),
  labels: entry('tab', ['标签', 'Labels'], 'handoff'),
  'snapshot-create': entry('snapshot-action', ['创建快照', 'Create snapshot'], 'handoff', { tabView: 'snapshot' }),
  console: entry('toolbar', ['打开终端', 'Open console', 'Open terminal'], 'handoff', { icons: ['OpenTerminal16WhiteIcon'] }),
  shutdown: entry('toolbar', ['关机', 'Shut down'], 'handoff', { icons: ['PoweroffTurnOnShutDown16GradientRedIcon'] }),
  restart: entry('toolbar', [], 'handoff', { icons: ['RestartNew16GradientGrayIcon'] }),
  suspend: entry('toolbar', [], 'handoff', { icons: ['SuspendedPause16GradientOrangeIcon'] }),
  clone: entry('toolbar', ['克隆', 'Clone'], 'handoff', { icons: ['Clone16GradientBlueIcon'] }),
  'edit-menu': entry('toolbar', ['编辑', 'Edit'], 'handoff', { icons: ['EditPen16BlueIcon'] }),
  'more-menu': entry('toolbar', [], 'handoff', { icons: ['MoreEllipsis316BoldBlueIcon'] }),
  'power-menu': entry('row-menu', ['更多操作', 'More actions'], 'handoff'),
  ha: entry('edit-item', ['编辑高可用', 'Edit HA'], 'dialog', { icons: ['EditPen24GradientBlueIcon'], modalTitles: ['编辑虚拟机高可用', 'Edit VM HA'] }),
  placement: entry('edit-item', ['编辑虚拟机放置组', 'Edit VM placement group'], 'dialog', { icons: ['VmPlacementGroup24GradientBlueIcon'], modalTitles: ['编辑虚拟机放置组', 'Edit VM placement group'] }),
  autostart: entry('edit-item', ['编辑随主机开机', 'Edit start with host'], 'dialog', { icons: ['EditPen24GradientBlueIcon'], modalTitles: ['编辑虚拟机随主机开机', 'Edit VM start with host'] }),
  ownership: entry('edit-item', ['编辑所属用户', 'Edit owner'], 'dialog', { icons: ['UserAccount24GradientBlueIcon'], modalTitles: ['编辑所属用户', 'Edit owner'] }),
  hostname: entry('edit-item', ['编辑主机名', 'Edit hostname'], 'dialog', { icons: ['EditPen24GradientBlueIcon'], modalTitles: ['编辑客户机操作系统的主机名', 'Edit guest OS hostname'] }),
  dns: entry('edit-item', ['编辑 DNS 服务器地址', 'Edit DNS server addresses'], 'dialog', { icons: ['EditPen24GradientBlueIcon'], modalTitles: ['编辑客户机操作系统的 DNS 服务器', 'Edit guest OS DNS servers'] }),
  vmgroup: entry('edit-item', ['编辑虚拟机组', 'Edit VM group'], 'handoff', { icons: ['VmgroupFolder24GradientBlueIcon'] }),
  ntp: entry('edit-item', ['重置 NTP 服务器', 'Reset NTP servers'], 'handoff', { icons: ['EditPen24GradientBlueIcon'] }),
  password: entry('edit-item', ['重置指定账户的密码', 'Reset a specified account password'], 'handoff', { icons: ['EditPen24GradientBlueIcon'] }),
  isolation: entry('more-item', ['隔离', 'Isolate'], 'handoff', { icons: ['Isolation16BlueIcon'] }),
  'network-links': entry('more-item', ['查看网络链路', 'View network links'], 'handoff', { icons: ['NetworkTopo16GradientBlueIcon'] }),
  'network-traffic': entry('more-item', ['查看网络流量', 'View network traffic'], 'handoff', { icons: ['TrafficVisualization16GradientBlueIcon'] }),
  template: entry('more-item', ['创建虚拟机模板', 'Create VM template'], 'handoff', { icons: ['Vmtemplate24GradientBlueIcon'] }),
  'tools-eject': entry('more-item', ['弹出虚拟机工具映像', 'Eject VM tools image'], 'handoff', { icons: ['Vmtools24GradientBlueIcon'] }),
  recycle: entry('more-item', ['移至回收站', 'Move to recycle bin'], 'handoff', { icons: ['VmRecycleBinMoveToBin24RedIcon'] }),
};
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
freeze(entries);
const intentByAction = new Map([
  ...['vm.general.edit', 'vm.hardware.cpu', 'vm.hardware.memory'].map(id => [id, 'basic']),
  ...['add', 'edit', 'expand', 'cache', 'remove'].map(suffix => [`vm.hardware.disk.${suffix}`, 'disk']),
  ...['add', 'edit', 'remove', 'qos'].map(suffix => [`vm.hardware.nic.${suffix}`, 'nic']),
  ...['configure', 'add', 'mount', 'eject', 'toggle', 'remove'].map(suffix => [`vm.hardware.cdrom.${suffix}`, 'disk']),
  ['vm.migration.withinCluster', 'migration'], ['vm.migration.acrossCluster', 'migration'], ['vm.snapshots.list', 'snapshots'], ['vm.snapshots.create', 'snapshot-create'],
  ['vm.console.open', 'console'], ['vm.power.menu', 'power-menu'], ['vm.power.shutdown', 'shutdown'], ['vm.power.restart', 'restart'], ['vm.power.suspend', 'suspend'], ['vm.clone', 'clone'],
  ['vm.hardware.menu', 'edit-menu'], ['vm.management.menu', 'more-menu'],
  ['vm.availability.ha', 'ha'], ['vm.placementGroup', 'placement'], ['vm.hostAutostart', 'autostart'], ['vm.ownership', 'ownership'], ['vm.vmGroup', 'vmgroup'],
  ['vm.guest.hostname', 'hostname'], ['vm.guest.dns', 'dns'], ['vm.guest.resetNtp', 'ntp'], ['vm.guest.resetPassword', 'password'], ['vm.guest.toolsImage.unmount', 'tools-eject'],
  ['vm.isolation.configure', 'isolation'], ['vm.network.links', 'network-links'], ['vm.network.traffic', 'network-traffic'], ['vm.template.create', 'template'], ['vm.recycle.move', 'recycle'],
  ['vm.monitor.view', 'monitor'], ['vm.network.security', 'network-security'], ['vm.backup', 'backup'], ['vm.events.view', 'events'], ['vm.labels.view', 'labels'],
]);
const blocked = '[hidden],[aria-hidden="true"],[disabled],[aria-disabled="true"],[inert],.__hidden,.ant-dropdown-hidden,.is-disabled,.ant-btn-loading,.ant-dropdown-disabled,.ant-btn-disabled,.ant-dropdown-menu-item-disabled,.ant-dropdown-menu-submenu-disabled';

export function nativeIntent(actionId) { return intentByAction.get(actionId) || null; }
export function nativeEntry(intent) { return typeof intent === 'string' && Object.hasOwn(entries, intent) ? entries[intent] : null; }

function available(node, win, includeDisabled = false) {
  if (!node?.isConnected || node.ownerDocument !== win?.document || node.closest(includeDisabled ? '[hidden],[aria-hidden="true"],[inert],.__hidden,.ant-dropdown-hidden' : blocked)) return false;
  for (let current = node; current; current = current.parentElement) {
    const style = win.getComputedStyle(current);
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
  }
  return node.getClientRects().length > 0;
}
function unique(nodes) { const all = [...new Set(nodes)]; return all.length === 1 ? all[0] : null; }
function inPane(node, pane) {
  return pane.contains(node) && !node.closest('.ant-modal,[role="dialog"],.ant-dropdown,[data-rivetin-object-menu],[data-rivetin-context-menu]');
}

// Queries only. The caller owns exact VM/pane identity and revalidates before
// clicking any returned entry. No form input or final submit is selected here.
export function findNativeControl({ win, pane, intent, menu, diagnostic = false } = {}) {
  const spec = nativeEntry(intent);
  if (!spec || !available(pane, win, diagnostic)) return diagnostic ? 'entry-missing' : null;
  const candidates = [];
  const usable = node => available(node, win, diagnostic);
  const named = node => {
    const labels = [normalize(node.getAttribute('title')), normalize(node.textContent)].filter(Boolean);
    return (spec.labels.length ? labels.length > 0 && labels.every(label => spec.labels.includes(label)) : labels.length === 0) &&
      (!spec.icons || spec.icons.some(icon => [...node.querySelectorAll('[data-testid]')].some(child => child.getAttribute('data-testid') === icon)));
  };
  if (spec.kind === 'section') {
    for (const action of pane.querySelectorAll('.extra-action')) {
      const heading = action.parentElement;
      if (!inPane(action, pane) || !usable(action)) continue;
      const copy = heading.cloneNode(true);
      for (const child of [...copy.children]) if (child.matches('.extra-action')) child.remove();
      if (!spec.labels.includes(normalize(copy.textContent))) continue;
      for (const button of action.querySelectorAll('button.edit-icon')) {
        if (button.closest('.extra-action') === action && usable(button)) candidates.push(button);
      }
    }
  } else if (spec.kind === 'toolbar') {
    for (const button of pane.querySelectorAll('.toolbar button')) {
      if (inPane(button, pane) && usable(button) && named(button)) candidates.push(button);
    }
  } else if (spec.kind === 'edit-item' || spec.kind === 'more-item') {
    // The provider supplies the popup it proved belongs to this interaction.
    // A matching global portal is never sufficient proof of ownership.
    if (!available(menu, win, diagnostic) || !menu.matches('.ant-dropdown,[role="menu"]') || menu.closest('.ant-modal,[data-rivetin-object-menu],[data-rivetin-context-menu]')) return diagnostic ? 'entry-missing' : null;
    for (const item of menu.querySelectorAll('[role="menuitem"]')) {
      const target = item.matches('.ant-dropdown-menu-submenu') ? [...item.children].find(child => child.matches('.ant-dropdown-menu-submenu-title')) : item;
      if (target && usable(target) && named(target)) candidates.push(target);
    }
  } else if (spec.kind === 'tab') {
    for (const tab of pane.querySelectorAll('.detail-tabs .tab-item')) {
      if (inPane(tab, pane) && usable(tab) && named(tab)) candidates.push(tab);
    }
  } else if (spec.kind === 'snapshot-action') {
    for (const button of pane.querySelectorAll('button')) if (inPane(button, pane) && usable(button) && named(button)) candidates.push(button);
  }
  if (diagnostic) return candidates.length > 1 ? 'entry-ambiguous' : candidates.length === 1 && !available(candidates[0], win) ? 'entry-disabled' : 'entry-missing';
  return unique(candidates);
}

export function findNativeSurface({ win, intent, before } = {}) {
  const spec = nativeEntry(intent);
  if (!win?.document || !spec?.modalTitles || spec.result !== 'dialog' || !(before instanceof Set)) return null;
  const created = [...win.document.querySelectorAll('.ant-modal')].filter(modal => !before.has(modal) && available(modal, win));
  // Never choose between concurrently created native dialogs by their title.
  if (created.length !== 1) return null;
  const modal = created[0], titles = [...modal.querySelectorAll('.ant-modal-title')].filter(title => title.closest('.ant-modal') === modal && available(title, win));
  return titles.length === 1 && spec.modalTitles.includes(normalize(titles[0].textContent)) ? modal : null;
}
