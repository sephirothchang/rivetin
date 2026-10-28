// Pure preparation + readback adapter for Tower 4.9, SDK commit
// 44b0cde9980ea9f2c920933758cd97f971188bf5 (Vm/VmNic/VmSnapshot/data-contracts).
// This module NEVER submits a mutation. The parent owns version/plugin gates,
// fresh authentication, confirmation, journaling, task ownership and submission.
// actor is a freshly verified server identity from that boundary, never JSON
// supplied by a browser. No actor credentials enter plans or public results.
const LIMIT = 128;
const MAX_CPU = 1024; // Conservative adapter limit, not an SDK hardware guarantee.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const exact = (value, keys, required = []) => object(value) && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key));
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw new Error(`RESOURCE_ACTION_${code}`); };
const bus = value => ['IDE', 'SCSI', 'USB', 'VIRTIO'].includes(value);
const model = value => ['E1000', 'VIRTIO'].includes(value);
const mac = value => typeof value === 'string' && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) &&
  !(Number.parseInt(value.slice(0, 2), 16) & 1) && !/^00(?::00){5}$/i.test(value);
const definitions = Object.freeze({
  'vm.hardware.cpu': '/update-vm-basic-info',
  'vm.hardware.memory': '/update-vm-basic-info',
  'vm.hardware.disk.add': '/add-vm-disk',
  'vm.hardware.disk.edit': '/update-vm-disk',
  'vm.hardware.disk.expand': '/expand-vm-disk',
  'vm.hardware.disk.remove': '/remove-vm-disk',
  'vm.hardware.nic.add': '/add-vm-nic',
  'vm.hardware.nic.edit': '/update-vm-nic-advance-info',
  'vm.hardware.nic.remove': '/remove-vm-nic-by-where',
  'vm.snapshots.create': '/create-vm-snapshot',
  'vm.snapshots.delete': '/delete-vm-snapshot',
  'vm.migration.withinCluster': '/migrate-vm',
});
const readOnly = 'vm.snapshots.list';
const readRoutes = new Set(['/get-vms', '/get-tasks', '/get-vm-disks', '/get-vm-volumes', '/get-vm-nics', '/get-vm-snapshots', '/get-vlans', '/get-vdses', '/get-hosts']);
function actorValue(actor) {
  if (!id(actor?.id) || actor.source !== 'tower' || !object(actor.auth) ||
    !['Authorization', 'Cookie'].some(key => text(actor.auth[key], key === 'Cookie' ? 16384 : 8192))) fail('PERMISSION_DENIED');
  if (actor.role !== 'ROOT') fail('PERMISSION_UNVERIFIED');
}
function resourceValue(resource) {
  if (!exact(resource, ['type', 'id', 'name'], ['type', 'id']) || resource.type !== 'vm' || !id(resource.id)) fail('RESOURCE_INVALID');
  return { type: 'vm', id: resource.id };
}
function asyncState(value) {
  if (value != null && !['CREATING', 'UPDATING', 'DELETING'].includes(value)) fail('RESPONSE_INVALID');
  return value ?? null;
}
function relation(value, expected) { if (!id(value?.id) || expected && value.id !== expected) fail('RELATIONSHIP_UNVERIFIED'); return value.id; }
function fields(values, allowed, required = allowed) { if (!exact(values, allowed, required)) fail('VALUES_INVALID'); }
function listIds(items) { return items.map(item => item.id).sort(); }
function namesEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function createVmActionAdapter({ request } = {}) {
  if (typeof request !== 'function') fail('PROVIDER_INVALID');
  const supports = actionId => actionId === readOnly || typeof actionId === 'string' && Object.hasOwn(definitions, actionId);
  async function get(route, body, actor) {
    // Even an injected plan cannot turn this adapter into a mutation transport.
    if (!readRoutes.has(route)) fail('UNSUPPORTED');
    try { return await request('/v2/api' + route, body, actor); }
    catch (error) { fail([401, 403].includes(error?.status) ? 'PERMISSION_DENIED' : 'READ_FAILED'); }
  }
  function rows(value) {
    if (!Array.isArray(value) || Object.hasOwn(value, 'errors') || value.length > LIMIT ||
      value.some(item => !object(item) || !id(item.id)) || new Set(value.map(item => item.id)).size !== value.length) fail('RESPONSE_INVALID');
    return value;
  }
  async function list(route, where, actor) { return rows(await get(route, { where, first: LIMIT + 1 }, actor)); }
  async function one(route, where, actor, absent = false) {
    const result = rows(await get(route, { where, first: 2 }, actor));
    if (absent && result.length === 0) return null;
    if (result.length !== 1 || result[0].id !== where.id) fail(result.length === 0 ? 'NOT_FOUND' : 'RESPONSE_INVALID');
    return result[0];
  }
  async function tasks(resourceId, actor) {
    const result = rows(await get('/get-tasks', { where: { resource_id: resourceId, status_in: ['PENDING', 'EXECUTING', 'PAUSED'] }, first: 2 }, actor));
    if (result.length > 2 || result.some(task => task.resource_id !== resourceId || !['PENDING', 'EXECUTING', 'PAUSED'].includes(task.status))) fail('RESPONSE_INVALID');
    return result.length > 0;
  }
  async function vmRead(resource, actor) {
    const raw = await one('/get-vms', { id: resource.id }, actor);
    if (!text(raw.name) || typeof raw.description !== 'string' || raw.description.length > 4096 ||
      !['RUNNING', 'STOPPED', 'SUSPENDED', 'UNKNOWN', 'DELETED'].includes(raw.status) ||
      ['protected', 'internal', 'in_recycle_bin'].some(key => typeof raw[key] !== 'boolean') ||
      !integer(raw.memory, 1) || !integer(raw.vcpu, 1, 2147483647) || !integer(raw.cpu?.cores, 1, 2147483647) || !integer(raw.cpu?.sockets, 1, 2147483647)) fail('RESPONSE_INVALID');
    const clusterId = relation(raw.cluster), hostId = raw.host == null ? null : relation(raw.host);
    return { raw, snapshot: { type: 'vm', id: resource.id, name: raw.name, description: raw.description,
      status: raw.status, protected: raw.protected, internal: raw.internal, in_recycle_bin: raw.in_recycle_bin,
      entityAsyncStatus: asyncState(raw.entityAsyncStatus), hasActiveTask: await tasks(resource.id, actor),
      cpu: { cores: raw.cpu.cores, sockets: raw.cpu.sockets }, vcpu: raw.vcpu, memory: raw.memory,
      vm_tools_status: ['RUNNING', 'NOT_RUNNING', 'NOT_INSTALLED', 'RESTRICTION'].includes(raw.vm_tools_status) ? raw.vm_tools_status : 'UNKNOWN',
      cluster: { id: clusterId }, host: hostId ? { id: hostId } : null } };
  }
  function ready(snapshot, actionId) {
    const states = actionId.startsWith('vm.snapshots.') ? ['RUNNING', 'STOPPED'] : ['STOPPED'];
    if (snapshot.protected || snapshot.internal || snapshot.in_recycle_bin || snapshot.entityAsyncStatus || snapshot.hasActiveTask || !states.includes(snapshot.status)) fail('STATE_REJECTED');
  }
  async function idleChild(child, actor) {
    if (asyncState(child.entityAsyncStatus) || await tasks(child.id, actor)) fail('STATE_REJECTED');
  }
  async function volumeRead(volumeId, vm, actor) {
    const volume = await one('/get-vm-volumes', { id: volumeId, cluster: { id: vm.cluster.id } }, actor);
    relation(volume.cluster, vm.cluster.id);
    if (!integer(volume.size, 1) || typeof volume.mounting !== 'boolean' || typeof volume.sharing !== 'boolean' ||
      !Array.isArray(volume.vm_disks) || volume.vm_disks.some(disk => !id(disk?.id)) || new Set(volume.vm_disks.map(disk => disk.id)).size !== volume.vm_disks.length) fail('RESPONSE_INVALID');
    asyncState(volume.entityAsyncStatus);
    return volume;
  }
  async function diskRead(diskId, vm, actor, absent = false) {
    const disk = await one('/get-vm-disks', { id: diskId, vm: { id: vm.id } }, actor, absent);
    if (!disk) return null;
    relation(disk.vm, vm.id);
    if (disk.type !== 'DISK' || !bus(disk.bus) || !integer(disk.boot, 0, 2147483647)) fail('RELATIONSHIP_UNVERIFIED');
    relation(disk.vm_volume);
    return disk;
  }
  async function diskList(vm, actor) {
    const result = await list('/get-vm-disks', { vm: { id: vm.id } }, actor);
    for (const disk of result) { relation(disk.vm, vm.id); if (!['DISK', 'CD_ROM'].includes(disk.type)) fail('RESPONSE_INVALID'); }
    return result;
  }
  function nicValid(nic, vm) {
    relation(nic.vm, vm.id);
    if (nic.type !== 'VLAN' || !model(nic.model) || nic.vpc_nic || !id(nic.vlan?.id) || typeof nic.enabled !== 'boolean' || nic.mac_address != null && !mac(nic.mac_address)) fail('RELATIONSHIP_UNVERIFIED');
    asyncState(nic.entityAsyncStatus);
    return nic;
  }
  async function nicRead(nicId, vm, actor, absent = false) {
    const nic = await one('/get-vm-nics', { id: nicId, vm: { id: vm.id } }, actor, absent);
    return nic ? nicValid(nic, vm) : null;
  }
  async function nicList(vm, actor) {
    const result = await list('/get-vm-nics', { vm: { id: vm.id } }, actor);
    for (const nic of result) relation(nic.vm, vm.id);
    return result;
  }
  async function vlanRead(vlanId, vm, actor) {
    const vlan = await one('/get-vlans', { id: vlanId }, actor);
    if (!text(vlan.name)) fail('RESPONSE_INVALID');
    const vdsId = relation(vlan.vds), vds = await one('/get-vdses', { id: vdsId }, actor);
    relation(vds.cluster, vm.cluster.id);
    if (asyncState(vlan.entityAsyncStatus) || asyncState(vds.entityAsyncStatus)) fail('STATE_REJECTED');
    return { id: vlan.id, name: vlan.name, cluster: { id: vm.cluster.id } };
  }
  async function snapshotRead(snapshotId, vm, actor, absent = false) {
    const item = await one('/get-vm-snapshots', { id: snapshotId, vm: { id: vm.id } }, actor, absent);
    if (!item) return null;
    relation(item.vm, vm.id);
    if (!text(item.name) || !['CRASH_CONSISTENT', 'FILE_SYSTEM_CONSISTENT'].includes(item.consistent_type)) fail('RESPONSE_INVALID');
    asyncState(item.entityAsyncStatus);
    return item;
  }
  async function snapshots(vm, actor) {
    const result = await list('/get-vm-snapshots', { vm: { id: vm.id } }, actor);
    for (const item of result) { relation(item.vm, vm.id); if (!text(item.name) || !['CRASH_CONSISTENT', 'FILE_SYSTEM_CONSISTENT'].includes(item.consistent_type)) fail('RESPONSE_INVALID'); asyncState(item.entityAsyncStatus); }
    return result;
  }
  async function hostRead(hostId, vm, actor, capacity = true) {
    const host = await one('/get-hosts', { id: hostId, cluster: { id: vm.cluster.id } }, actor);
    relation(host.cluster, vm.cluster.id);
    if (host.status !== 'CONNECTED_HEALTHY' || asyncState(host.entityAsyncStatus)) fail('STATE_REJECTED');
    if (capacity && (!text(vm.cpu_model, 512) || !Array.isArray(host.compatible_cpu_models) || !host.compatible_cpu_models.includes(vm.cpu_model) || !integer(host.allocatable_memory_bytes, 0) || host.allocatable_memory_bytes < vm.memory)) fail('CAPACITY_UNVERIFIED');
    return host;
  }
  function named(item) { return text(item.name) ? { name: item.name } : {}; }
  async function read({ resource: input, actionId, actor } = {}) {
    const resource = resourceValue(input); actorValue(actor); if (!supports(actionId)) fail('UNSUPPORTED');
    const { snapshot, raw } = await vmRead(resource, actor), choices = {};
    if (actionId.startsWith('vm.hardware.disk.')) {
      const disks = await diskList(snapshot, actor); choices.vm_disks = [];
      for (const disk of disks.filter(item => item.type === 'DISK')) {
        const complete = await diskRead(disk.id, snapshot, actor), volume = await volumeRead(complete.vm_volume.id, snapshot, actor);
        choices.vm_disks.push({ id: complete.id, type: 'DISK', bus: complete.bus, boot: complete.boot, vm: { id: snapshot.id },
          entityAsyncStatus: asyncState(complete.entityAsyncStatus) || asyncState(volume.entityAsyncStatus),
          vm_volume: { id: volume.id, ...named(volume), size: volume.size } });
      }
      if (actionId === 'vm.hardware.disk.add') {
        choices.diskAddModes = ['existing'];
        const volumes = await list('/get-vm-volumes', { cluster: { id: snapshot.cluster.id }, mounting: false, sharing: false }, actor);
        choices.availableVolumes = [];
        for (const item of volumes) {
          const volume = await volumeRead(item.id, snapshot, actor);
          if (volume.mounting || volume.sharing || volume.vm_disks.length || asyncState(volume.entityAsyncStatus) || volume.type !== 'KVM_VOLUME') continue;
          choices.availableVolumes.push({ id: volume.id, ...named(volume), cluster: { id: snapshot.cluster.id }, size: volume.size, vm_disks: [] });
        }
      }
    } else if (actionId.startsWith('vm.hardware.nic.')) {
      const nics = await nicList(snapshot, actor); choices.vm_nics = [];
      for (const item of nics) {
        if (item.type !== 'VLAN' || !model(item.model) || item.vpc_nic) continue;
        const nic = await nicRead(item.id, snapshot, actor);
        choices.vm_nics.push({ id: nic.id, type: 'VLAN', model: nic.model, enabled: nic.enabled, vm: { id: snapshot.id }, vlan: { id: nic.vlan.id },
          entityAsyncStatus: asyncState(nic.entityAsyncStatus), ...(nic.mac_address ? { mac_address: nic.mac_address } : {}) });
      }
      const vlans = await list('/get-vlans', { vds: { cluster: { id: snapshot.cluster.id } } }, actor); choices.availableVlans = [];
      for (const vlan of vlans) choices.availableVlans.push(await vlanRead(vlan.id, snapshot, actor));
    } else if (actionId.startsWith('vm.snapshots.')) {
      if (actionId === 'vm.snapshots.create') choices.consistentTypes = ['CRASH_CONSISTENT'];
      choices.snapshots = (await snapshots(snapshot, actor)).map(item => ({ id: item.id, name: item.name, consistent_type: item.consistent_type, vm: { id: snapshot.id }, entityAsyncStatus: asyncState(item.entityAsyncStatus) }));
    } else if (actionId === 'vm.migration.withinCluster') {
      const hosts = await list('/get-hosts', { cluster: { id: snapshot.cluster.id } }, actor); choices.availableHosts = [];
      for (const item of hosts) {
        if (item.id === snapshot.host?.id || item.status !== 'CONNECTED_HEALTHY' || item.entityAsyncStatus) continue;
        try { const host = await hostRead(item.id, { ...snapshot, cpu_model: raw.cpu_model }, actor); choices.availableHosts.push({ id: host.id, ...named(host), cluster: { id: snapshot.cluster.id }, status: host.status }); }
        catch (error) { if (!['RESOURCE_ACTION_CAPACITY_UNVERIFIED', 'RESOURCE_ACTION_STATE_REJECTED'].includes(error.message)) throw error; }
      }
    }
    return { snapshot, choices };
  }
  function plan(actionId, resource, body, expected, responseKind = 'vm') {
    return { version: 1, resource, actionId, request: { path: '/v2/api' + definitions[actionId], body }, responseKind, expected };
  }
  async function prepare({ resource: input, actionId, values = {}, actor } = {}) {
    const resource = resourceValue(input); actorValue(actor); if (!Object.hasOwn(definitions, actionId)) fail('UNSUPPORTED');
    const { snapshot: vm, raw } = await vmRead(resource, actor); ready(vm, actionId);
    const where = { id: vm.id }, base = { vmId: vm.id, clusterId: vm.cluster.id };
    if (actionId === 'vm.hardware.cpu') {
      fields(values, ['vcpu', 'cpu_sockets', 'cpu_cores']);
      if (Object.values(values).some(value => !integer(value, 1, MAX_CPU))) fail('VALUES_INVALID');
      const data = { vcpu: values.vcpu, cpu_sockets: values.cpu_sockets, cpu_cores: values.cpu_cores };
      return plan(actionId, resource, { where, data }, { ...base, kind: 'cpu', ...data });
    }
    if (actionId === 'vm.hardware.memory') {
      fields(values, ['memory', 'memory_unit']); if (!integer(values.memory, 1) || values.memory_unit !== 'B' || !id(vm.host?.id)) fail('VALUES_INVALID');
      const host = await hostRead(vm.host.id, vm, actor, false);
      if (!integer(host.total_memory_bytes, 1) || !integer(host.allocatable_memory_bytes, 1) || values.memory > Math.min(host.total_memory_bytes, host.allocatable_memory_bytes)) fail('CAPACITY_UNVERIFIED');
      return plan(actionId, resource, { where, data: { memory: values.memory, memory_unit: 'B' } }, { ...base, kind: 'memory', memory: values.memory });
    }
    if (actionId === 'vm.hardware.disk.add') {
      fields(values, ['mode', 'vm_volume_id', 'bus', 'boot']);
      if (values.mode !== 'existing' || !id(values.vm_volume_id) || values.vm_volume_id === vm.id || !bus(values.bus) || !integer(values.boot, 0, 2147483647)) fail('VALUES_INVALID');
      const volume = await volumeRead(values.vm_volume_id, vm, actor); await idleChild(volume, actor);
      if (volume.type !== 'KVM_VOLUME' || volume.mounting || volume.sharing || volume.vm_disks.length) fail('STATE_REJECTED');
      const baseline = await diskList(vm, actor);
      if (baseline.some(disk => disk.vm_volume?.id === volume.id)) fail('STATE_REJECTED');
      return plan(actionId, resource, { where, data: { vm_disks: { mount_disks: [{ vm_volume_id: volume.id, bus: values.bus, boot: values.boot }] } } },
        { ...base, kind: 'disk-attach', volumeId: volume.id, size: volume.size, bus: values.bus, boot: values.boot, baseline: listIds(baseline) });
    }
    if (actionId.startsWith('vm.hardware.disk.')) {
      const allowed = actionId.endsWith('.edit') ? ['vm_disk_id', 'bus'] : actionId.endsWith('.expand') ? ['vm_disk_id', 'size', 'size_unit'] : ['vm_disk_id'];
      fields(values, allowed); if (!id(values.vm_disk_id) || values.vm_disk_id === vm.id) fail('VALUES_INVALID');
      const disk = await diskRead(values.vm_disk_id, vm, actor), volume = await volumeRead(disk.vm_volume.id, vm, actor);
      await idleChild(disk, actor); await idleChild(volume, actor);
      if (!volume.vm_disks.some(item => item.id === disk.id) || volume.sharing) fail('RELATIONSHIP_UNVERIFIED');
      if (actionId.endsWith('.edit')) {
        if (!bus(values.bus)) fail('VALUES_INVALID');
        return plan(actionId, resource, { where, data: { vm_disk_id: disk.id, bus: values.bus } }, { ...base, kind: 'disk-bus', diskId: disk.id, volumeId: volume.id, bus: values.bus });
      }
      if (actionId.endsWith('.expand')) {
        if (!integer(values.size, 1) || values.size <= volume.size || values.size_unit !== 'B') fail('VALUES_INVALID');
        return plan(actionId, resource, { where: { id: disk.id, vm: { id: vm.id } }, size: values.size, size_unit: 'B' }, { ...base, kind: 'disk-size', diskId: disk.id, volumeId: volume.id, size: values.size });
      }
      return plan(actionId, resource, { where, data: { disk_ids: [disk.id] } }, { ...base, kind: 'disk-detach', diskId: disk.id, volumeId: volume.id, size: volume.size });
    }
    if (actionId === 'vm.hardware.nic.add') {
      fields(values, ['connect_vlan_id', 'model', 'enabled', 'mac_address'], ['connect_vlan_id', 'model', 'enabled']);
      if (!id(values.connect_vlan_id) || !model(values.model) || typeof values.enabled !== 'boolean' || Object.hasOwn(values, 'mac_address') && !mac(values.mac_address)) fail('VALUES_INVALID');
      await vlanRead(values.connect_vlan_id, vm, actor);
      const baseline = await nicList(vm, actor);
      if (values.mac_address && baseline.some(nic => nic.mac_address?.toLowerCase() === values.mac_address.toLowerCase())) fail('STATE_REJECTED');
      const data = { type: 'VLAN', connect_vlan_id: values.connect_vlan_id, model: values.model, enabled: values.enabled, ...(values.mac_address ? { mac_address: values.mac_address } : {}) };
      return plan(actionId, resource, { where, data: { vm_nics: [data] } }, { ...base, kind: 'nic-add', baseline: listIds(baseline), ...data });
    }
    if (actionId.startsWith('vm.hardware.nic.')) {
      fields(values, actionId.endsWith('.edit') ? ['vm_nic_id', 'connect_vlan_id', 'enabled', 'mac_address'] : ['vm_nic_id'], ['vm_nic_id']);
      if (!id(values.vm_nic_id) || values.vm_nic_id === vm.id) fail('VALUES_INVALID');
      const nic = await nicRead(values.vm_nic_id, vm, actor); await idleChild(nic, actor);
      const childWhere = { id: nic.id, vm: { id: vm.id } };
      if (actionId.endsWith('.remove')) return plan(actionId, resource, { where: childWhere, effect: { vm_ids: [vm.id] } }, { ...base, kind: 'nic-detach', nicId: nic.id });
      const data = {};
      if (Object.hasOwn(values, 'connect_vlan_id')) { if (!id(values.connect_vlan_id)) fail('VALUES_INVALID'); await vlanRead(values.connect_vlan_id, vm, actor); data.connect_vlan_id = values.connect_vlan_id; }
      if (Object.hasOwn(values, 'enabled')) { if (typeof values.enabled !== 'boolean') fail('VALUES_INVALID'); data.enabled = values.enabled; }
      if (Object.hasOwn(values, 'mac_address')) {
        if (!mac(values.mac_address)) fail('VALUES_INVALID');
        if ((await nicList(vm, actor)).some(item => item.id !== nic.id && item.mac_address?.toLowerCase() === values.mac_address.toLowerCase())) fail('STATE_REJECTED');
        data.mac_address = values.mac_address;
      }
      if (!Object.keys(data).length) fail('VALUES_INVALID');
      return plan(actionId, resource, { where: childWhere, data }, { ...base, kind: 'nic-edit', nicId: nic.id, changes: data });
    }
    if (actionId === 'vm.snapshots.create') {
      fields(values, ['name', 'consistent_type'], ['name']);
      if (!text(values.name, 128) || values.name.trim() !== values.name || values.consistent_type !== undefined && values.consistent_type !== 'CRASH_CONSISTENT') fail('VALUES_INVALID');
      const baseline = await snapshots(vm, actor);
      return plan(actionId, resource, { data: [{ vm_id: vm.id, name: values.name, consistent_type: 'CRASH_CONSISTENT' }] }, { ...base, kind: 'snapshot-create', baseline: listIds(baseline), name: values.name, consistent_type: 'CRASH_CONSISTENT' }, 'snapshot');
    }
    if (actionId === 'vm.snapshots.delete') {
      fields(values, ['snapshot_id']); if (!id(values.snapshot_id) || values.snapshot_id === vm.id) fail('VALUES_INVALID');
      const item = await snapshotRead(values.snapshot_id, vm, actor); await idleChild(item, actor);
      return plan(actionId, resource, { where: { id: item.id, vm: { id: vm.id } } }, { ...base, kind: 'snapshot-delete', snapshotId: item.id }, 'snapshot');
    }
    if (actionId === 'vm.migration.withinCluster') {
      fields(values, ['host_id']); if (!id(values.host_id) || values.host_id === vm.id || values.host_id === vm.host?.id || !id(vm.host?.id)) fail('VALUES_INVALID');
      await hostRead(vm.host.id, { ...vm, cpu_model: raw.cpu_model }, actor, false);
      await hostRead(values.host_id, { ...vm, cpu_model: raw.cpu_model }, actor);
      return plan(actionId, resource, { where, data: { host_id: values.host_id } }, { ...base, kind: 'migration', hostId: values.host_id });
    }
    fail('UNSUPPORTED');
  }
  function validPlan(plan) {
    if (!exact(plan, ['version', 'resource', 'actionId', 'request', 'responseKind', 'expected'], ['version', 'resource', 'actionId', 'request', 'responseKind', 'expected']) || plan.version !== 1 || !Object.hasOwn(definitions, plan.actionId) ||
      !exact(plan.request, ['path', 'body'], ['path', 'body']) || plan.request.path !== '/v2/api' + definitions[plan.actionId] || !['vm', 'snapshot'].includes(plan.responseKind) || !object(plan.expected)) return false;
    resourceValue(plan.resource);
    if (plan.expected.vmId !== plan.resource.id || !id(plan.expected.clusterId) || typeof plan.expected.kind !== 'string' || JSON.stringify(plan).length > 32768) return false;
    const e = plan.expected, where = { id: plan.resource.id }, base = ['vmId', 'clusterId', 'kind'];
    const expectedKeys = {
      'vm.hardware.cpu': ['cpu', 'vcpu', 'cpu_sockets', 'cpu_cores'],
      'vm.hardware.memory': ['memory', 'memory'],
      'vm.hardware.disk.add': ['disk-attach', 'volumeId', 'size', 'bus', 'boot', 'baseline'],
      'vm.hardware.disk.edit': ['disk-bus', 'diskId', 'volumeId', 'bus'],
      'vm.hardware.disk.expand': ['disk-size', 'diskId', 'volumeId', 'size'],
      'vm.hardware.disk.remove': ['disk-detach', 'diskId', 'volumeId', 'size'],
      'vm.hardware.nic.add': ['nic-add', 'baseline', 'type', 'connect_vlan_id', 'model', 'enabled', 'mac_address'],
      'vm.hardware.nic.edit': ['nic-edit', 'nicId', 'changes'],
      'vm.hardware.nic.remove': ['nic-detach', 'nicId'],
      'vm.snapshots.create': ['snapshot-create', 'baseline', 'name', 'consistent_type'],
      'vm.snapshots.delete': ['snapshot-delete', 'snapshotId'],
      'vm.migration.withinCluster': ['migration', 'hostId'],
    }[plan.actionId];
    if (!expectedKeys || e.kind !== expectedKeys[0] || !exact(e, [...base, ...expectedKeys.slice(1)], [...base, ...expectedKeys.slice(1).filter(key => key !== 'mac_address')])) return false;
    if (plan.responseKind !== (plan.actionId.startsWith('vm.snapshots.') ? 'snapshot' : 'vm')) return false;
    for (const key of ['diskId', 'volumeId', 'nicId', 'snapshotId', 'hostId', 'connect_vlan_id']) if (Object.hasOwn(e, key) && (!id(e[key]) || e[key] === e.vmId)) return false;
    if (e.baseline && (!Array.isArray(e.baseline) || e.baseline.length > LIMIT || e.baseline.some(value => !id(value) || value === e.vmId) || new Set(e.baseline).size !== e.baseline.length)) return false;
    if (Object.hasOwn(e, 'size') && !integer(e.size, 1) || Object.hasOwn(e, 'bus') && !bus(e.bus) || Object.hasOwn(e, 'boot') && !integer(e.boot, 0, 2147483647)) return false;
    let body;
    if (e.kind === 'cpu') { if (![e.vcpu, e.cpu_sockets, e.cpu_cores].every(value => integer(value, 1, MAX_CPU))) return false; body = { where, data: { vcpu: e.vcpu, cpu_sockets: e.cpu_sockets, cpu_cores: e.cpu_cores } }; }
    if (e.kind === 'memory') { if (!integer(e.memory, 1)) return false; body = { where, data: { memory: e.memory, memory_unit: 'B' } }; }
    if (e.kind === 'disk-attach') body = { where, data: { vm_disks: { mount_disks: [{ vm_volume_id: e.volumeId, bus: e.bus, boot: e.boot }] } } };
    if (e.kind === 'disk-bus') body = { where, data: { vm_disk_id: e.diskId, bus: e.bus } };
    if (e.kind === 'disk-size') body = { where: { id: e.diskId, vm: { id: e.vmId } }, size: e.size, size_unit: 'B' };
    if (e.kind === 'disk-detach') body = { where, data: { disk_ids: [e.diskId] } };
    if (e.kind === 'nic-add') {
      if (e.type !== 'VLAN' || !model(e.model) || typeof e.enabled !== 'boolean' || Object.hasOwn(e, 'mac_address') && !mac(e.mac_address)) return false;
      body = { where, data: { vm_nics: [{ type: 'VLAN', connect_vlan_id: e.connect_vlan_id, model: e.model, enabled: e.enabled, ...(e.mac_address ? { mac_address: e.mac_address } : {}) }] } };
    }
    if (e.kind === 'nic-edit') {
      if (!exact(e.changes, ['connect_vlan_id', 'enabled', 'mac_address']) || !Object.keys(e.changes).length ||
        Object.hasOwn(e.changes, 'connect_vlan_id') && !id(e.changes.connect_vlan_id) || Object.hasOwn(e.changes, 'enabled') && typeof e.changes.enabled !== 'boolean' || Object.hasOwn(e.changes, 'mac_address') && !mac(e.changes.mac_address)) return false;
      body = { where: { id: e.nicId, vm: { id: e.vmId } }, data: e.changes };
    }
    if (e.kind === 'nic-detach') body = { where: { id: e.nicId, vm: { id: e.vmId } }, effect: { vm_ids: [e.vmId] } };
    if (e.kind === 'snapshot-create') { if (!text(e.name, 128) || e.consistent_type !== 'CRASH_CONSISTENT') return false; body = { data: [{ vm_id: e.vmId, name: e.name, consistent_type: e.consistent_type }] }; }
    if (e.kind === 'snapshot-delete') body = { where: { id: e.snapshotId, vm: { id: e.vmId } } };
    if (e.kind === 'migration') body = { where, data: { host_id: e.hostId } };
    return body !== undefined && namesEqual(plan.request.body, body);
  }
  function nicMatches(nic, changes) {
    return Object.entries(changes).every(([key, value]) => key === 'connect_vlan_id' ? nic.vlan?.id === value : key === 'mac_address' ? nic.mac_address?.toLowerCase() === value.toLowerCase() : nic[key] === value);
  }
  async function verify({ plan: input, actor, responseData } = {}) {
    try {
      actorValue(actor); if (!validPlan(input)) return false;
      const plan = clone(input), expected = plan.expected;
      const { snapshot: vm } = await vmRead(plan.resource, actor); ready(vm, plan.actionId);
      if (vm.cluster.id !== expected.clusterId) return false;
      if (plan.responseKind === 'vm' && responseData !== undefined && responseData?.id !== vm.id) return false;
      if (expected.kind === 'snapshot-delete' && responseData !== undefined && responseData?.id !== expected.snapshotId) return false;
      if (expected.kind === 'cpu') return vm.vcpu === expected.vcpu && vm.cpu.sockets === expected.cpu_sockets && vm.cpu.cores === expected.cpu_cores;
      if (expected.kind === 'memory') return vm.memory === expected.memory;
      if (expected.kind === 'disk-attach') {
        if (!Array.isArray(expected.baseline)) return false;
        const current = await diskList(vm, actor), delta = current.filter(disk => !expected.baseline.includes(disk.id));
        if (delta.length !== 1 || current.length !== expected.baseline.length + 1 || expected.baseline.some(id => !current.some(disk => disk.id === id))) return false;
        const disk = await diskRead(delta[0].id, vm, actor), volume = await volumeRead(expected.volumeId, vm, actor);
        await idleChild(disk, actor); await idleChild(volume, actor);
        return disk.vm_volume.id === expected.volumeId && disk.bus === expected.bus && disk.boot === expected.boot && volume.size === expected.size && !volume.sharing && volume.vm_disks.some(item => item.id === disk.id);
      }
      if (expected.kind === 'disk-bus' || expected.kind === 'disk-size') {
        const disk = await diskRead(expected.diskId, vm, actor); if (disk.vm_volume.id !== expected.volumeId) return false;
        await idleChild(disk, actor);
        const volume = await volumeRead(expected.volumeId, vm, actor); await idleChild(volume, actor);
        if (volume.sharing || !volume.vm_disks.some(item => item.id === disk.id)) return false;
        return expected.kind === 'disk-bus' ? disk.bus === expected.bus : volume.size === expected.size;
      }
      if (expected.kind === 'disk-detach') {
        if (await diskRead(expected.diskId, vm, actor, true) || await tasks(expected.diskId, actor)) return false;
        const volume = await volumeRead(expected.volumeId, vm, actor);
        await idleChild(volume, actor);
        return !volume.sharing && volume.size === expected.size && !volume.vm_disks.some(disk => disk.id === expected.diskId);
      }
      if (expected.kind === 'nic-add') {
        if (!Array.isArray(expected.baseline)) return false;
        const current = await nicList(vm, actor), delta = current.filter(nic => !expected.baseline.includes(nic.id));
        if (delta.length !== 1 || current.length !== expected.baseline.length + 1 || expected.baseline.some(id => !current.some(nic => nic.id === id))) return false;
        const nic = await nicRead(delta[0].id, vm, actor);
        await idleChild(nic, actor); await vlanRead(nic.vlan.id, vm, actor);
        return nicMatches(nic, { connect_vlan_id: expected.connect_vlan_id, model: expected.model, enabled: expected.enabled, ...(expected.mac_address ? { mac_address: expected.mac_address } : {}) });
      }
      if (expected.kind === 'nic-edit') {
        const nic = await nicRead(expected.nicId, vm, actor);
        await idleChild(nic, actor); await vlanRead(nic.vlan.id, vm, actor);
        return nicMatches(nic, expected.changes);
      }
      if (expected.kind === 'nic-detach') return !(await nicRead(expected.nicId, vm, actor, true)) && !(await tasks(expected.nicId, actor));
      if (expected.kind === 'snapshot-create') {
        if (!id(responseData?.id) || responseData.id === vm.id || !Array.isArray(expected.baseline) || expected.baseline.includes(responseData.id)) return false;
        if (responseData.vm !== undefined && responseData.vm?.id !== vm.id) return false;
        const item = await snapshotRead(responseData.id, vm, actor);
        await idleChild(item, actor);
        return item.name === expected.name && item.consistent_type === expected.consistent_type;
      }
      if (expected.kind === 'snapshot-delete') return !(await snapshotRead(expected.snapshotId, vm, actor, true)) && !(await tasks(expected.snapshotId, actor));
      if (expected.kind === 'migration') { await hostRead(expected.hostId, vm, actor, false); return vm.status === 'STOPPED' && vm.host?.id === expected.hostId; }
      return false;
    } catch { return false; }
  }
  return { supports, read, prepare, verify };
}
