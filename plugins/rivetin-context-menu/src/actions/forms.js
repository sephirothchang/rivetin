const names = {
  name: ['名称', 'Name'], description: ['描述', 'Description'], cpu_sockets: ['CPU 插槽数', 'CPU sockets'], cpu_cores: ['每插槽核心数', 'Cores per socket'],
  memory: ['内存大小', 'Memory size'], memory_unit: ['内存单位', 'Memory unit'], snapshot_id: ['恢复到快照', 'Restore to snapshot'],
  host_id: ['目标主机', 'Destination host'], consistent_type: ['一致性类型', 'Consistency type'], is_full_copy: ['完整克隆', 'Full clone'],
};
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const FORM_ACTIONS = Object.freeze([
  ...['start', 'shutdown', 'poweroff', 'restart', 'forceRestart', 'suspend', 'resume'].map(id => `vm.power.${id}`),
  'vm.general.edit', 'vm.hardware.cpu', 'vm.hardware.memory', 'vm.snapshots.create', 'vm.snapshots.restore', 'vm.migration.withinCluster', 'vm.clone',
]);
export function actionFields(actionId, snapshot = {}, locale = 'zh-CN') {
  const en = locale === 'en-US', label = id => names[id][en ? 1 : 0];
  const field = (id, type = 'text', extra = {}) => ({ id, type, label: label(id), required: true, ...extra });
  if (actionId === 'vm.general.edit') return [field('name', 'text', { initial: snapshot.name || '', maxLength: 256 }), field('description', 'text', { required: false, initial: snapshot.description || '', maxLength: 4096 })];
  if (actionId === 'vm.hardware.cpu') return [field('cpu_sockets', 'number', { min: 1, max: 2147483647, initial: snapshot.cpu_sockets }), field('cpu_cores', 'number', { min: 1, max: 2147483647, initial: snapshot.cpu_cores })];
  if (actionId === 'vm.hardware.memory') return [field('memory', 'number', { min: 1, max: Number.MAX_SAFE_INTEGER }), field('memory_unit', 'select', { initial: 'MB', options: ['B', 'KB', 'MB', 'GB', 'TB', 'PB'].map(value => ({ value, label: value })) })];
  if (actionId === 'vm.snapshots.create') return [field('name', 'text', { maxLength: 128 }), field('consistent_type', 'select', { initial: 'CRASH_CONSISTENT', options: [
    { value: 'CRASH_CONSISTENT', label: en ? 'Crash consistent' : '崩溃一致性' }, { value: 'FILE_SYSTEM_CONSISTENT', label: en ? 'File system consistent (requires VM Tools)' : '文件系统一致性（需要 VM Tools）' },
  ] })];
  if (actionId === 'vm.snapshots.restore') return [field('snapshot_id', 'select', { options: (snapshot.snapshots || []).filter(value => validId(snapshot.id) && validId(value.id) && value.vm?.id === snapshot.id && !value.entityAsyncStatus).map(value => ({ value: value.id, label: value.name || value.id })) })];
  if (actionId === 'vm.migration.withinCluster') return [field('host_id', 'select', { options: (snapshot.availableHosts || []).filter(value => validId(snapshot.cluster?.id) && validId(value.id) && value.cluster?.id === snapshot.cluster.id && value.status === 'CONNECTED_HEALTHY' && !value.entityAsyncStatus).map(value => ({ value: value.id, label: value.name || value.id })) })];
  if (actionId === 'vm.clone') return [field('name', 'text', { maxLength: 128 }), field('description', 'text', { required: false, maxLength: 4096 }), field('is_full_copy', 'checkbox', { initial: true })];
  return [];
}
export function initialValues(fields) { return Object.fromEntries(fields.filter(field => field.initial !== undefined).map(field => [field.id, field.initial])); }
export function fieldValues(fields, values) {
  const output = {};
  for (const field of fields) {
    const value = values[field.id];
    if (!field.required && value === undefined) continue;
    if (field.type === 'number') {
      if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isSafeInteger(Number(value)) || Number(value) < field.min || Number(value) > field.max) throw new Error('INVALID_FORM_VALUE');
      output[field.id] = Number(value);
    } else if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') throw new Error('INVALID_FORM_VALUE');
      output[field.id] = value;
    }
    else {
      if (typeof value !== 'string' || field.required && !value.trim() || field.maxLength && value.length > field.maxLength || field.type === 'select' && !field.options.some(option => option.value === value)) throw new Error('INVALID_FORM_VALUE');
      output[field.id] = value;
    }
  }
  return output;
}
