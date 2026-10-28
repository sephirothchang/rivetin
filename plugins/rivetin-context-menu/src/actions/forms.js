// API enums: cloudtower-node-sdk v2.23.0/src/generated/data-contracts.ts (Tower 4.9).
// Device records here are freshly normalized detailed reads, not NestedVm* IDs.
const names = {
  name: ['名称', 'Name'], description: ['描述', 'Description'], vcpu: ['vCPU 数量', 'vCPU count'], cpu_sockets: ['CPU 插槽数', 'CPU sockets'], cpu_cores: ['CPU 核心数', 'CPU cores'],
  memory: ['内存大小', 'Memory size'], memory_unit: ['内存单位', 'Memory unit'], snapshot_id: ['恢复到快照', 'Restore to snapshot'],
  host_id: ['目标主机', 'Destination host'], consistent_type: ['一致性类型', 'Consistency type'], is_full_copy: ['完整克隆', 'Full clone'],
  mode: ['磁盘来源', 'Disk source'], bus: ['总线', 'Bus'], boot: ['启动顺序值', 'Boot order value'], size: ['容量', 'Size'], size_unit: ['容量单位', 'Size unit'],
  vm_volume_id: ['已有虚拟卷', 'Existing virtual volume'], vm_disk_id: ['虚拟磁盘', 'Virtual disk'], vm_nic_id: ['虚拟网卡', 'Virtual NIC'],
  connect_vlan_id: ['连接的 VLAN', 'Connected VLAN'], model: ['网卡型号', 'NIC model'], enabled: ['启用网卡', 'Enable NIC'], mac_address: ['MAC 地址（可选）', 'MAC address (optional)'],
};
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// The first product stage accepts exact bytes, not every API ByteUnit member.
const units = ['B'], buses = ['IDE', 'SCSI', 'USB', 'VIRTIO'], models = ['E1000', 'VIRTIO'];
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
function allowedValues(value, fallback, whitelist) {
  const values = value === undefined ? fallback : value;
  return Array.isArray(values) && values.length <= 5000 ? [...new Set(values.filter(item => whitelist.includes(item)))] : [];
}
function uniqueRecords(values, predicate) {
  if (!Array.isArray(values) || values.length > 5000) return [];
  const counts = new Map();
  for (const item of values) if (validId(item?.id)) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  return values.filter(item => validId(item?.id) && counts.get(item.id) === 1 && !item.entityAsyncStatus && predicate(item));
}
function owned(snapshot, choices, key, type) {
  return uniqueRecords(choices[key], item => validId(snapshot.id) && item.id !== snapshot.id && item.vm?.id === snapshot.id && (!type || item.type === type));
}
function clusterChoices(snapshot, choices, key) {
  return uniqueRecords(choices[key], item => validId(snapshot.cluster?.id) && item.id !== snapshot.id && item.cluster?.id === snapshot.cluster.id);
}
function memoryInitial(value) {
  const bytes = typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  // The SDK enumerates ByteUnit names without documenting conversion factors.
  if (!Number.isSafeInteger(bytes) || bytes < 1) return { memory_unit: 'B' };
  return { memory: bytes, memory_unit: 'B' };
}
export const FORM_ACTIONS = Object.freeze([
  ...['start', 'shutdown', 'poweroff', 'restart', 'forceRestart', 'suspend', 'resume'].map(id => `vm.power.${id}`),
  'vm.general.edit', 'vm.hardware.cpu', 'vm.hardware.memory', 'vm.snapshots.create', 'vm.snapshots.restore', 'vm.migration.withinCluster', 'vm.clone',
  'vm.hardware.disk.add', 'vm.hardware.disk.edit', 'vm.hardware.disk.expand', 'vm.hardware.disk.remove',
  'vm.hardware.nic.add', 'vm.hardware.nic.edit', 'vm.hardware.nic.remove', 'vm.snapshots.delete',
]);
export function actionFields(actionId, snapshot = {}, locale = 'zh-CN', currentValues = {}, choices = snapshot) {
  const en = locale === 'en-US', label = id => names[id][en ? 1 : 0];
  const field = (id, type = 'text', extra = {}) => ({ id, type, label: label(id), required: true, ...extra });
  const select = (id, values, extra = {}) => field(id, 'select', { options: values.map(value => typeof value === 'string' ? { value, label: value } : { value: value.id, label: value.name || value.device || value.mac_address || value.id }), ...extra });
  // A selector change must rebuild its dependants before old draft values submit.
  const dependent = (id, value) => ({ dependsOn: id, boundValue: value });
  if (actionId === 'vm.general.edit') return [field('name', 'text', { initial: snapshot.name || '', maxLength: 256 }), field('description', 'text', { required: false, initial: snapshot.description || '', maxLength: 4096 })];
  if (actionId === 'vm.hardware.cpu') return [field('vcpu', 'number', { min: 1, max: 2147483647, initial: snapshot.vcpu }), field('cpu_sockets', 'number', { min: 1, max: 2147483647, initial: snapshot.cpu?.sockets }), field('cpu_cores', 'number', { min: 1, max: 2147483647, initial: snapshot.cpu?.cores })];
  if (actionId === 'vm.hardware.memory') {
    const values = memoryInitial(snapshot.memory);
    return [field('memory', 'number', { min: 1, max: Number.MAX_SAFE_INTEGER, initial: values.memory }), select('memory_unit', units, { initial: values.memory_unit })];
  }
  if (actionId.startsWith('vm.hardware.disk.')) {
    const disks = owned(snapshot, choices, 'vm_disks', 'DISK');
    if (actionId === 'vm.hardware.disk.add') {
      const modes = allowedValues(choices.diskAddModes, ['existing'], ['new', 'existing']);
      const mode = Object.hasOwn(currentValues, 'mode') ? currentValues.mode : modes[0], binding = dependent('mode', mode);
      const fields = [select('mode', modes.map(id => ({ id, name: id === 'new' ? en ? 'Create a virtual volume' : '新建虚拟卷' : en ? 'Attach an existing virtual volume' : '挂载已有虚拟卷' })), { initial: mode, refresh: true }), select('bus', buses, { initial: 'VIRTIO' }), field('boot', 'number', { min: 0, max: 2147483647, initial: 0 })];
      // Preserve an invalid draft choice so it cannot silently change intent.
      if (!modes.includes(mode)) return fields;
      if (mode === 'existing') {
        const volumes = clusterChoices(snapshot, choices, 'availableVolumes').filter(volume => Array.isArray(volume.vm_disks) && volume.vm_disks.length === 0 && !disks.some(disk => disk.vm_volume?.id === volume.id));
        return [...fields, select('vm_volume_id', volumes, binding)];
      }
      return [...fields, field('name', 'text', { maxLength: 128, ...binding }), field('size', 'number', { min: 1, max: Number.MAX_SAFE_INTEGER, ...binding }), select('size_unit', units, { initial: 'B', ...binding })];
    }
    const eligible = actionId === 'vm.hardware.disk.expand' ? disks.filter(disk => validId(disk.vm_volume?.id) && safeInteger(disk.vm_volume.size) && disk.vm_volume.size < Number.MAX_SAFE_INTEGER) : disks;
    const selected = eligible.find(disk => disk.id === currentValues.vm_disk_id), binding = dependent('vm_disk_id', selected?.id);
    const choice = select('vm_disk_id', eligible, { initial: selected?.id, refresh: true });
    if (actionId === 'vm.hardware.disk.edit') return [choice, select('bus', buses, { initial: buses.includes(selected?.bus) ? selected.bus : undefined, ...binding })];
    if (actionId === 'vm.hardware.disk.expand') return [choice, field('size', 'number', { min: selected ? selected.vm_volume.size + 1 : 1, max: Number.MAX_SAFE_INTEGER, initial: selected?.vm_volume.size, ...binding }), select('size_unit', ['B'], { initial: 'B', ...binding })];
    if (actionId === 'vm.hardware.disk.remove') return [choice];
  }
  if (actionId.startsWith('vm.hardware.nic.')) {
    const nics = owned(snapshot, choices, 'vm_nics', 'VLAN').filter(nic => nic.model !== 'SRIOV' && !nic.vpc_nic);
    const selected = nics.find(nic => nic.id === currentValues.vm_nic_id), binding = actionId === 'vm.hardware.nic.edit' ? dependent('vm_nic_id', selected?.id) : {};
    const choice = select('vm_nic_id', nics, { initial: selected?.id, refresh: true });
    if (actionId === 'vm.hardware.nic.remove') return [choice];
    if (actionId === 'vm.hardware.nic.add' || actionId === 'vm.hardware.nic.edit') {
      const vlans = clusterChoices(snapshot, choices, 'availableVlans'), vlan = selected?.vlan?.id;
      const forbiddenValues = (Array.isArray(choices.vm_nics) ? choices.vm_nics : []).filter(nic => nic?.id !== selected?.id && typeof nic?.mac_address === 'string').map(nic => nic.mac_address.toLowerCase());
      return [...(actionId === 'vm.hardware.nic.edit' ? [choice] : []), select('connect_vlan_id', vlans, { initial: vlans.some(item => item.id === vlan) ? vlan : undefined, ...binding }), ...(actionId === 'vm.hardware.nic.add' ? [select('model', models, { initial: 'VIRTIO' })] : []), field('enabled', 'checkbox', { initial: actionId === 'vm.hardware.nic.add' ? true : selected?.enabled, ...binding }), field('mac_address', 'text', { required: false, omitEmpty: true, maxLength: 17, format: 'mac', forbiddenValues, initial: selected?.mac_address || '', ...binding })];
    }
  }
  if (actionId === 'vm.snapshots.create') {
    const types = allowedValues(choices.consistentTypes, ['CRASH_CONSISTENT'], ['CRASH_CONSISTENT', 'FILE_SYSTEM_CONSISTENT']);
    return [field('name', 'text', { maxLength: 128 }), field('consistent_type', 'select', { initial: Object.hasOwn(currentValues, 'consistent_type') ? currentValues.consistent_type : types[0], options: types.map(value => ({ value, label: value === 'CRASH_CONSISTENT' ? en ? 'Crash consistent' : '崩溃一致性' : en ? 'File system consistent (requires VM Tools)' : '文件系统一致性（需要 VM Tools）' })) })];
  }
  if (actionId === 'vm.snapshots.restore' || actionId === 'vm.snapshots.delete') return [select('snapshot_id', owned(snapshot, choices, 'snapshots'), { label: actionId === 'vm.snapshots.delete' ? en ? 'Snapshot to delete' : '要删除的快照' : label('snapshot_id') })];
  if (actionId === 'vm.migration.withinCluster') return [select('host_id', clusterChoices(snapshot, choices, 'availableHosts').filter(value => value.status === 'CONNECTED_HEALTHY' && value.id !== snapshot.host?.id))];
  if (actionId === 'vm.clone') return [field('name', 'text', { maxLength: 128 }), field('description', 'text', { required: false, maxLength: 4096 }), field('is_full_copy', 'checkbox', { initial: true })];
  return [];
}
export function initialValues(fields) { return Object.fromEntries(fields.filter(field => field.initial !== undefined).map(field => [field.id, field.initial])); }
export function fieldValues(fields, values) {
  const output = {};
  for (const field of fields) {
    const value = values[field.id];
    if (field.dependsOn && values[field.dependsOn] !== field.boundValue) throw new Error('INVALID_FORM_VALUE');
    if (!field.required && (value === undefined || field.omitEmpty && value === '')) continue;
    if (field.type === 'number') {
      if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value).trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < field.min || Number(value) > field.max) throw new Error('INVALID_FORM_VALUE');
      output[field.id] = Number(value);
    } else if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error('INVALID_FORM_VALUE');
      output[field.id] = value;
    }
    else {
      if (typeof value !== 'string' || field.required && !value.trim() || field.maxLength && value.length > field.maxLength || field.type === 'select' && !field.options.some(option => option.value === value)) throw new Error('INVALID_FORM_VALUE');
      if (field.format === 'mac' && (!/^[\da-f][02468ace](?::[\da-f]{2}){5}$/i.test(value) || /^00(?::00){5}$/.test(value) || field.forbiddenValues.includes(value.toLowerCase()))) throw new Error('INVALID_FORM_VALUE');
      output[field.id] = value;
    }
  }
  return output;
}
