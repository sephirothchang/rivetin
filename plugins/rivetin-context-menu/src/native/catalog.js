import { nativeIntent, nativeEntry } from './controls.js';
import { nativeErrorMessage } from './errors.js';
const words = (zh, en) => ({ 'zh-CN': zh, 'en-US': en });
const action = (id, zh, en) => ({ id: `vm.${id}`, labels: words(zh, en) });
const section = (id, zh, en, items) => ({ id: `vm.${id}`, labels: words(zh, en), items });

// These are navigation intents, not API operation schemas or authorization.
// An available entry means the exact object can be handed to official UI.
const groups = [
  section('power', '电源', 'Power', [
    ...[['menu', '官方电源菜单', 'Native power menu'], ['shutdown', '关机', 'Shut down'], ['restart', '重启', 'Restart'], ['suspend', '暂停', 'Suspend']].map(([id, zh, en]) => action(`power.${id}`, zh, en)),
  ]),
  section('console', '控制台与客户机', 'Console and guest', [
    action('console.open', '打开终端', 'Open console'),
    action('guest.hostname', '编辑主机名', 'Edit hostname'), action('guest.dns', '编辑 DNS 服务器地址', 'Edit DNS server addresses'),
    action('guest.resetNtp', '重置 NTP 服务器', 'Reset NTP servers'), action('guest.resetPassword', '重置指定账户的密码', 'Reset a specified account password'),
    action('guest.toolsImage.unmount', '弹出虚拟机工具映像', 'Eject VM tools image'),
  ]),
  section('hardware', '基本信息与硬件', 'General and hardware', [
    action('general.edit', '编辑基本信息', 'Edit basic information'), action('hardware.cpu', '配置 CPU', 'Configure CPU'), action('hardware.memory', '配置内存', 'Configure memory'),
    ...[['disk.add', '添加磁盘', 'Add disk'], ['disk.edit', '编辑磁盘', 'Edit disk'], ['disk.expand', '扩容磁盘', 'Expand disk'], ['disk.cache', '配置磁盘常驻缓存', 'Configure disk cache residency'], ['disk.remove', '卸载磁盘', 'Detach disk'], ['cdrom.configure', '配置 CD-ROM 与 ISO', 'Configure CD-ROM and ISO'],
      ['nic.add', '添加网卡', 'Add NIC'], ['nic.edit', '编辑网卡', 'Edit NIC'], ['nic.remove', '移除网卡', 'Remove NIC'], ['nic.qos', '配置网卡 QoS', 'Configure NIC QoS']].map(([id, zh, en]) => action(`hardware.${id}`, zh, en)),
    action('hardware.menu', '完整官方编辑菜单', 'Full native Edit menu'),
  ]),
  section('snapshots', '快照与克隆', 'Snapshots and cloning', [
    action('snapshots.list', '查看快照', 'Browse snapshots'), action('snapshots.create', '创建快照', 'Create snapshot'), action('clone', '克隆虚拟机', 'Clone VM'),
  ]),
  section('migration', '迁移', 'Migration', [
    action('migration.withinCluster', '迁移虚拟机', 'Migrate VM'), action('migration.acrossCluster', '跨集群迁移向导', 'Cross-cluster migration wizard'),
  ]),
  section('navigation', '监控、安全与记录', 'Monitoring, security and records', [
    action('monitor.view', '查看监控', 'View monitoring'), action('network.security', '查看网络安全', 'View network security'),
    action('backup', '查看备份与容灾', 'View backup and disaster recovery'), action('events.view', '查看事件', 'View events'), action('labels.view', '查看标签', 'View labels'),
  ]),
  section('management', '高可用、归属与管理', 'Availability, ownership and management', [
    action('availability.ha', '编辑高可用', 'Edit HA'), action('placementGroup', '编辑虚拟机放置组', 'Edit VM placement group'), action('hostAutostart', '编辑随主机开机', 'Edit start with host'),
    action('ownership', '编辑所属用户', 'Edit owner'), action('vmGroup', '编辑虚拟机组', 'Edit VM group'),
    action('isolation.configure', '隔离', 'Isolate'), action('network.links', '查看网络链路', 'View network links'), action('network.traffic', '查看网络流量', 'View network traffic'),
    action('template.create', '创建虚拟机模板', 'Create VM template'), action('management.menu', '完整官方更多菜单', 'Full native More menu'),
  ]),
  section('recycle', '回收与删除', 'Recycle and delete', [
    action('recycle.move', '移至回收站', 'Move to recycle bin'),
  ]),
];
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const NATIVE_ACTION_CATALOG = freeze(groups);
export function getNativeAction(actionId, resource) {
  if (resource?.type !== 'vm' || !/^[A-Za-z0-9_-]{1,128}$/.test(resource.id || '')) return null;
  return NATIVE_ACTION_CATALOG.flatMap(group => group.items).find(item => item.id === actionId) || null;
}
export function buildNativeActionTree({ resource, data, locale = 'zh-CN' } = {}) {
  if (resource?.type !== 'vm') return [];
  const language = locale === 'en-US' ? locale : 'zh-CN';
  const enabled = /^[A-Za-z0-9_-]{1,128}$/.test(resource.id || '') && data?.snapshot?.type === 'vm' && data.snapshot.id === resource.id && data?.native?.canNavigate === true;
  return NATIVE_ACTION_CATALOG.map(group => ({ id: group.id, label: group.labels[language], items: group.items.filter(item => nativeEntry(nativeIntent(item.id))).map(item => ({
    id: item.id, label: item.labels[language], guide: '', enabled: Boolean(enabled), mutation: false, operation: null, danger: 'none',
    reason: enabled ? '' : nativeErrorMessage(data?.native?.reason || 'navigation-unavailable', language),
    target: { type: 'vm', id: enabled ? resource.id : null },
  })) })).filter(group => group.items.length);
}
