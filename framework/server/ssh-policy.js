import { createHash } from 'node:crypto';

export const SSH_CHANNEL_ID = 'rivetin-ssh-channel';
export const SSH_OPERATIONS = Object.freeze([
  { id: 'host.identity', command: '/usr/bin/uname -srm', category: 'host', argumentSource: 'configured-hosts', expansion: 'each-authorized-host', privilege: 'user', impact: { 'zh-CN': '只读查询主机内核与架构。', 'en-US': 'Read the host kernel and architecture.' } },
  { id: 'disk.smart.read', command: 'sudo -n -- /usr/sbin/smartctl --json=c --all <disk>', category: 'disk', argumentSource: 'fresh-host-inventory', expansion: 'each-authorized-disk', privilege: 'sudo-read', impact: { 'zh-CN': '以免交互 sudo 读取指定磁盘 SMART；不启动自检、不修改磁盘设置。', 'en-US': 'Read SMART for the selected disk with non-interactive sudo; no self-test or disk configuration changes.' } },
]);
export const SSH_REJECTED_EXAMPLES = Object.freeze([
  { example: 'rm -rf <path>', risk: { 'zh-CN': '删除文件，可能造成不可恢复的数据丢失。', 'en-US': 'Deletes files and can cause irreversible data loss.' } },
  { example: 'mkfs /dev/<device> / dd of=/dev/<device>', risk: { 'zh-CN': '格式化或覆盖设备，破坏文件系统和数据。', 'en-US': 'Formats or overwrites a device, destroying filesystems and data.' } },
  { example: 'reboot / shutdown / systemctl restart <service>', risk: { 'zh-CN': '重启主机或服务，可能中断集群业务。', 'en-US': 'Restarts a host or service and can interrupt cluster workloads.' } },
  { example: 'ip link set / ip route / nft / iptables', risk: { 'zh-CN': '修改网络或防火墙，可能导致管理失联或集群故障。', 'en-US': 'Changes networking or firewall rules and can disconnect management or cluster traffic.' } },
  { example: 'sh -c / bash / curl <url> | sh / python -c', risk: { 'zh-CN': '可执行任意脚本，无法保证只读范围。', 'en-US': 'Executes arbitrary scripts whose effects cannot be restricted to read-only operations.' } },
  { example: 'smartctl --test / --set / --smart', risk: { 'zh-CN': '启动磁盘测试或修改设备设置，可能影响性能和运行状态。', 'en-US': 'Starts device tests or changes device settings, potentially affecting performance and state.' } },
]);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sshIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const commandId = value => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value);
function ids(value, max) {
  if (!Array.isArray(value) || !value.length || value.length > max || value.some(id => !sshIdentifier(id)) || new Set(value).size !== value.length) throw new Error('SSH_REGISTRATION_INVALID');
  return [...value].sort();
}
export function validateSshRegistration(value) {
  if (!exactKeys(value, ['version', 'commands']) || value.version !== 1 || !Array.isArray(value.commands) || value.commands.length > 20) throw new Error('SSH_REGISTRATION_INVALID');
  const names = new Set();
  const commands = value.commands.map(item => {
    if (!exactKeys(item, ['id', 'operation', 'purpose', 'hostIds', 'hostScope', 'deviceIds', 'deviceScope', 'intervalSeconds']) || !commandId(item.id) || names.has(item.id)) throw new Error('SSH_REGISTRATION_INVALID');
    names.add(item.id);
    if (!SSH_OPERATIONS.some(operation => operation.id === item.operation)) throw new Error('SSH_OPERATION_REJECTED');
    if (!exactKeys(item.purpose, ['zh-CN', 'en-US']) || !text(item.purpose['zh-CN']) || !text(item.purpose['en-US'])) throw new Error('SSH_REGISTRATION_INVALID');
    if (!Number.isSafeInteger(item.intervalSeconds) || item.intervalSeconds !== 0 && (item.intervalSeconds < 300 || item.intervalSeconds > 604800)) throw new Error('SSH_SCHEDULE_INVALID');
    if (Object.hasOwn(item, 'hostScope') === Object.hasOwn(item, 'hostIds')) throw new Error('SSH_REGISTRATION_INVALID');
    const clean = { id: item.id, operation: item.operation, purpose: { 'zh-CN': item.purpose['zh-CN'], 'en-US': item.purpose['en-US'] }, intervalSeconds: item.intervalSeconds };
    if (Object.hasOwn(item, 'hostScope')) {
      if (item.hostScope !== 'configured') throw new Error('SSH_SCOPE_REJECTED');
      clean.hostScope = 'configured';
    } else clean.hostIds = ids(item.hostIds, 50);
    if (item.operation === 'disk.smart.read') {
      if (Object.hasOwn(item, 'deviceScope') === Object.hasOwn(item, 'deviceIds')) throw new Error('SSH_REGISTRATION_INVALID');
      if (Object.hasOwn(item, 'deviceScope')) {
        if (item.deviceScope !== 'configured') throw new Error('SSH_SCOPE_REJECTED');
        clean.deviceScope = 'configured';
      } else clean.deviceIds = ids(item.deviceIds, 100);
      if (clean.hostIds && clean.deviceIds && clean.hostIds.length * clean.deviceIds.length > 100) throw new Error('SSH_TARGET_LIMIT');
    }
    else if (Object.hasOwn(item, 'deviceIds') || Object.hasOwn(item, 'deviceScope')) throw new Error('SSH_REGISTRATION_INVALID');
    return clean;
  });
  return { version: 1, commands: commands.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function compileSshCommand(command, host, deviceId) {
  const clean = validateSshRegistration({ version: 1, commands: [command] }).commands[0];
  if (!sshIdentifier(host?.hostId) || clean.hostScope !== 'configured' && !clean.hostIds.includes(host.hostId)) throw new Error('SSH_TARGET_NOT_APPROVED');
  if (clean.operation === 'host.identity') {
    if (deviceId !== undefined) throw new Error('SSH_TARGET_NOT_APPROVED');
    return '/usr/bin/uname -srm';
  }
  if (!sshIdentifier(deviceId) || clean.deviceScope !== 'configured' && !clean.deviceIds.includes(deviceId)) throw new Error('SSH_DEVICE_NOT_APPROVED');
  const device = host.devices?.find(value => value.deviceId === deviceId);
  if (!device || !validSshDevicePath(device.path)) throw new Error('SSH_DEVICE_UNAVAILABLE');
  if (typeof device.serial !== 'string' || !device.serial.length || device.serial.length > 256 || /[\x00-\x1f\x7f]/.test(device.serial)) throw new Error('SSH_DEVICE_IDENTITY_REQUIRED');
  return `sudo -n -- /usr/sbin/smartctl --json=c --all ${device.path}`;
}
export const validSshDevicePath = value => typeof value === 'string' && /^\/dev\/(?:sd[a-z]{1,3}|nvme\d{1,4}n\d{1,4})$/.test(value);
export function sshRegistrationDigest(plugin, registration, vaultRevision, resolvedCommands = []) {
  if (!/^[a-f0-9]{64}$/.test(plugin?.packageId || '') || typeof vaultRevision !== 'string') throw new Error('SSH_REGISTRATION_INVALID');
  return createHash('sha256').update(JSON.stringify({ pluginId: plugin.id, packageId: plugin.packageId, registration: validateSshRegistration(registration), vaultRevision, resolvedCommands })).digest('hex');
}
