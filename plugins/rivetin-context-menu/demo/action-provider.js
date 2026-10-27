import { VM_ACTION_CATALOG, buildActionTree } from '../src/actions/catalog.js';

// All state in this module is synthetic and process-local. There is no transport.
export function createDemoActionProvider(present) {
  let status = 'RUNNING', readOnly = false, sequence = 2;
  const snapshots = [{ id: 'snapshot-demo-baseline', name: '演示基线 / Demo baseline' }, { id: 'snapshot-demo-change', name: '演示变更前 / Before change' }];
  const snapshot = id => ({ id, name: 'Ubuntu demo', status, protected: false, internal: false, in_recycle_bin: false, entityAsyncStatus: null,
    disks: [{ id: 'disk-demo-system', name: 'Ubuntu demo-1 · 40 GiB' }], nics: [{ id: 'nic-demo-0', name: 'NIC0 · Demo network', index: 0 }],
    snapshots: snapshots.map(value => ({ ...value })), hosts: [{ id: 'host-demo-2', name: 'Compute node 02' }], clusters: [{ id: 'cluster-demo-2', name: 'Demo cluster 02' }] });
  const capabilities = () => Object.fromEntries(VM_ACTION_CATALOG.flatMap(group => group.items).map(action => [action.id, {
    allowed: !(readOnly && action.mutation), reason: { 'zh-CN': '演示只读账户没有此操作权限。', 'en-US': 'The demo read-only account is not authorized for this action.' },
  }]));
  function check(resource, signal) {
    if (signal?.aborted) throw new Error('DEMO_CANCELLED');
    if (resource.type !== 'vm' || resource.id !== 'ubuntu-demo') throw new Error('DEMO_RESOURCE_NOT_FOUND');
  }
  return {
    setStatus(value) { if (['RUNNING', 'STOPPED', 'SUSPENDED'].includes(value)) status = value; },
    setReadOnly(value) { readOnly = value; },
    async read(resource, { signal } = {}) {
      check(resource, signal);
      return { snapshot: snapshot(resource.id), capabilities: capabilities() };
    },
    async open(request, { signal } = {}) { check(request.resource, signal); present(request); return { status: 'opened' }; },
    confirm(request, values) {
      if (request.resource.id !== 'ubuntu-demo') throw new Error('DEMO_RESOURCE_NOT_FOUND');
      const current = snapshot(request.resource.id);
      const action = buildActionTree({ resource: request.resource, snapshot: current, capabilities: capabilities() }).flatMap(group => group.items).find(value => value.id === request.actionId);
      if (!action?.enabled) throw new Error('DEMO_ACTION_UNAVAILABLE');
      for (const [key, allowed] of [['diskId', current.disks], ['nicId', current.nics], ['snapshotId', current.snapshots], ['hostId', current.hosts], ['clusterId', current.clusters]])
        if (values[key] && !allowed.some(value => value.id === values[key])) throw new Error('DEMO_SUBRESOURCE_MISMATCH');
      if (request.actionId === 'vm.power.start' || request.actionId === 'vm.power.resume') status = 'RUNNING';
      if (request.actionId === 'vm.power.shutdown' || request.actionId === 'vm.power.poweroff') status = 'STOPPED';
      if (request.actionId === 'vm.power.suspend') status = 'SUSPENDED';
      if (request.actionId === 'vm.snapshots.create') snapshots.push({ id: `snapshot-demo-${++sequence}`, name: values.name });
      return { simulated: true, status };
    },
  };
}

export function demoFields(request, en = false) {
  const form = request.action.form, pick = (zh, english) => en ? english : zh;
  const field = (id, zh, english, type = 'text', extra = {}) => ({ id, label: pick(zh, english), type, required: true, ...extra });
  const choices = (values = []) => values.map(value => ({ value: value.id, label: value.name }));
  if (form === 'vm-cpu') return [field('vcpu', 'vCPU 数量', 'vCPU count', 'number', { min: 1, max: 128, initial: 2 })];
  if (form === 'vm-memory') return [field('memory', '内存（MiB）', 'Memory (MiB)', 'number', { min: 128, initial: 4096 })];
  if (form === 'vm-general') return [field('name', '名称', 'Name', 'text', { initial: request.resource.name }), field('description', '描述', 'Description', 'text', { required: false })];
  if (form === 'vm-snapshot-create') return [field('name', '快照名称', 'Snapshot name'), field('description', '描述', 'Description', 'text', { required: false })];
  if (['vm-snapshot-rollback', 'vm-snapshot-rebuild', 'vm-snapshot-delete'].includes(form)) return [field('snapshotId', '选择快照', 'Choose snapshot', 'select', { options: choices(request.snapshot.snapshots) }), ...(form === 'vm-snapshot-rebuild' ? [field('name', '新虚拟机名称', 'New VM name')] : [])];
  if (form === 'vm-migrate-host') return [field('hostId', '目标主机', 'Destination host', 'select', { options: choices(request.snapshot.hosts) })];
  if (form === 'vm-migrate-cluster') return [field('clusterId', '目标集群', 'Destination cluster', 'select', { options: choices(request.snapshot.clusters) }), field('network', '目标网络映射', 'Destination network mapping', 'select', { options: [{ value: 'network-demo-2', label: 'Demo network 02' }] })];
  if (form === 'vm-clone') return [field('name', '新虚拟机名称', 'New VM name')];
  if (form.startsWith('vm-disk-') && form !== 'vm-disk-add') return [field('diskId', '选择磁盘', 'Choose disk', 'select', { options: choices(request.snapshot.disks) }), ...(form === 'vm-disk-expand' ? [field('sizeGiB', '新容量（GiB）', 'New capacity (GiB)', 'number', { min: 41, initial: 60 })] : [])];
  if (form.startsWith('vm-nic-') && form !== 'vm-nic-add') return [field('nicId', '选择网卡', 'Choose NIC', 'select', { options: choices(request.snapshot.nics) }), ...(form === 'vm-nic-edit' ? [field('network', '虚拟网络', 'Virtual network', 'select', { options: [{ value: 'network-demo-1', label: 'Demo network 01' }, { value: 'network-demo-2', label: 'Demo network 02' }] })] : [])];
  if (form === 'vm-disk-add') return [field('name', '磁盘名称', 'Disk name'), field('sizeGiB', '容量（GiB）', 'Capacity (GiB)', 'number', { min: 1, initial: 20 })];
  if (form === 'vm-nic-add') return [field('network', '虚拟网络', 'Virtual network', 'select', { options: [{ value: 'network-demo-1', label: 'Demo network 01' }] })];
  return [];
}
