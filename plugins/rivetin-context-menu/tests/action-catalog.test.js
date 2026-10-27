import test from 'node:test';
import assert from 'node:assert/strict';
import { VM_ACTION_CATALOG, buildActionTree } from '../src/actions/catalog.js';

const resource = { type: 'vm', id: 'demo-vm' };
const snapshot = { id: resource.id, status: 'STOPPED', protected: false, internal: false, in_recycle_bin: false };
const all = Object.fromEntries(VM_ACTION_CATALOG.flatMap(group => group.items).map(action => [action.id, { allowed: true }]));
const tree = values => buildActionTree({ resource, snapshot, capabilities: all, ...values });
const items = result => result.flatMap(group => group.items);
const find = (id, values) => items(tree(values)).find(action => action.id === id);

test('VM catalog is complete without a sidebar or any DOM input', () => {
  const result = tree();
  assert.deepEqual(result.map(group => group.id), ['vm.power', 'vm.console', 'vm.hardware', 'vm.snapshots', 'vm.migration', 'vm.management', 'vm.recycle']);
  assert.ok(items(result).length >= 55);
  for (const id of ['vm.hardware.cpu', 'vm.hardware.memory', 'vm.hardware.disk.add', 'vm.hardware.nic.edit', 'vm.hardware.cdrom.mount', 'vm.hardware.gpu.add', 'vm.hardware.pciNic.add', 'vm.hardware.usb.mount', 'vm.hardware.bootOrder', 'vm.hardware.advanced', 'vm.snapshots.create', 'vm.snapshots.restore', 'vm.snapshots.rebuild', 'vm.migration.acrossCluster', 'vm.availability.ha', 'vm.ownership', 'vm.labels', 'vm.delete']) assert.ok(find(id), id);
  assert.equal(new Set(items(result).map(action => action.id)).size, items(result).length);
});

test('missing snapshots never enable an action even with all capabilities', () => {
  const result = items(tree({ snapshot: undefined }));
  assert.ok(result.length > 0);
  assert.ok(result.every(action => !action.enabled));
  assert.equal(find('vm.power.start', { snapshot: undefined }).reasonCode, 'preflight');
});

test('snapshot IDs must match the exact resource ID', () => {
  const result = items(tree({ snapshot: { ...snapshot, id: 'different-vm' } }));
  assert.ok(result.every(action => !action.enabled));
  assert.equal(result.find(action => action.id === 'vm.power.start').reasonCode, 'mismatch');
  assert.ok(result.every(action => action.target.id === null && action.target.parentVmId === null));
});

test('empty or invalid VM IDs are rejected and other resource types receive no VM actions', () => {
  assert.equal(find('vm.power.start', { resource: { type: 'vm', id: '' } }).reasonCode, 'preflight');
  assert.deepEqual(buildActionTree(), []);
  assert.deepEqual(tree({ resource: { type: 'vmDisk', id: resource.id } }), []);
});

test('unknown authorization cannot be treated as permission', () => {
  for (const capabilities of [{}, { 'vm.power.start': { allowed: null } }, { 'vm.power.start': { allowed: 'true' } }, Object.create({ 'vm.power.start': { allowed: true } })]) {
    const action = find('vm.power.start', { capabilities });
    assert.equal(action.enabled, false);
    assert.equal(action.reasonCode, 'permissionUnknown');
  }
  assert.equal(find('vm.power.start').enabled, true);
});

test('explicit denials retain localized authoritative explanations', () => {
  const capabilities = { 'vm.power.start': { allowed: false, reason: { 'zh-CN': '策略拒绝', 'en-US': 'Denied by policy' } } };
  assert.equal(find('vm.power.start', { capabilities }).reason, '策略拒绝');
  assert.equal(find('vm.power.start', { capabilities, locale: 'en-US' }).reason, 'Denied by policy');
  assert.equal(find('vm.power.start', { capabilities }).reasonCode, 'denied');
});

test('normal shutdown and forced power off have distinct APIs, forms and risk', () => {
  const running = { snapshot: { ...snapshot, status: 'RUNNING' } };
  const normal = find('vm.power.shutdown', running), forced = find('vm.power.poweroff', running);
  assert.equal(normal.operation.path, '/v2/api/shutdown-vm');
  assert.equal(forced.operation.path, '/v2/api/poweroff-vm');
  assert.notEqual(normal.form, forced.form);
  assert.equal(normal.danger, 'warning'); assert.equal(forced.danger, 'danger');
  assert.equal(normal.enabled, true); assert.equal(forced.enabled, true);
});

test('power state conservatively gates stopped, running and suspended actions', () => {
  assert.equal(find('vm.power.start').enabled, true);
  for (const id of ['vm.power.shutdown', 'vm.power.restart', 'vm.power.forceRestart', 'vm.power.suspend', 'vm.power.resume']) assert.equal(find(id).enabled, false, id);
  const running = { snapshot: { ...snapshot, status: 'RUNNING' } };
  assert.equal(find('vm.power.start', running).enabled, false);
  assert.equal(find('vm.power.suspend', running).enabled, true);
  const suspended = { snapshot: { ...snapshot, status: 'SUSPENDED' } };
  assert.equal(find('vm.power.resume', suspended).enabled, true);
  assert.equal(find('vm.power.shutdown', suspended).enabled, false);
  assert.equal(find('vm.power.restart', suspended).enabled, false);
});

test('busy or unknown snapshots keep all actions disabled', () => {
  for (const changed of [{ entityAsyncStatus: 'UPDATING' }, { status: 'UNKNOWN' }, { status: 'DELETED' }, { status: undefined }]) assert.ok(items(tree({ snapshot: { ...snapshot, ...changed } })).every(action => !action.enabled));
});

test('protected and internal VMs cannot be mutated while safe reads remain possible', () => {
  for (const flag of ['protected', 'internal']) {
    const values = { snapshot: { ...snapshot, [flag]: true } };
    assert.equal(find('vm.general.edit', values).enabled, false);
    assert.equal(find('vm.general.edit', values).reasonCode, flag);
    assert.equal(find('vm.snapshots.list', values).enabled, true);
  }
});

test('recycle recovery and permanent deletion are distinct from moving to recycle', () => {
  assert.equal(find('vm.recycle.move').enabled, true);
  assert.equal(find('vm.recycle.recover').enabled, false);
  assert.equal(find('vm.delete').enabled, false);
  const recycled = { snapshot: { ...snapshot, in_recycle_bin: true } };
  assert.equal(find('vm.recycle.move', recycled).enabled, false);
  assert.equal(find('vm.recycle.recover', recycled).enabled, true);
  assert.equal(find('vm.delete', recycled).enabled, true);
  assert.notEqual(find('vm.delete', recycled).operation.path, find('vm.recycle.move').operation.path);
});

test('subresource actions never use the parent VM ID as a disk, snapshot, NIC or USB ID', () => {
  const result = items(tree());
  for (const action of result.filter(value => value.target.type !== 'vm')) {
    assert.equal(action.target.id, null, action.id);
    assert.equal(action.target.parentVmId, resource.id, action.id);
  }
  for (const action of result.filter(value => value.selection)) {
    assert.deepEqual(action.selection.ids, [], action.id);
    assert.equal(action.selection.parentVmId, resource.id, action.id);
  }
  assert.equal(find('vm.hardware.disk.expand').target.type, 'vmDisk');
  assert.equal(find('vm.snapshots.delete').target.type, 'vmSnapshot');
  assert.equal(find('vm.hardware.nic.edit').selection.type, 'vmNic');
  assert.equal(find('vm.hardware.usb.mount').target.type, 'usbDevice');
});

test('snapshot browsing, creating, rollback, rebuilding and deleting are independent operations', () => {
  const actions = ['list', 'create', 'restore', 'rebuild', 'delete'].map(id => find(`vm.snapshots.${id}`));
  assert.equal(new Set(actions.map(action => action.operation.operationId)).size, actions.length);
  assert.equal(find('vm.snapshots.restore').danger, 'danger');
  assert.equal(find('vm.snapshots.rebuild').form, 'vm-snapshot-rebuild');
});

test('unverified bindings remain visible but unsupported even when explicitly allowed', () => {
  for (const id of ['vm.hardware.bootOrder', 'vm.hardware.firmware', 'vm.hardware.tpm', 'vm.backup', 'vm.labels', 'vm.protection']) {
    const action = find(id);
    assert.equal(action.operation, null); assert.equal(action.enabled, false); assert.equal(action.reasonCode, 'unsupported'); assert.ok(action.reason.length > 0);
  }
});

test('console uses documented VNC info, never a guessed console URL', () => {
  const action = find('vm.console.open', { snapshot: { ...snapshot, status: 'RUNNING' } });
  assert.equal(action.operation.path, '/v2/api/get-vm-vnc-info');
  assert.equal(action.operation.schema, 'GetVmVncInfoParams');
  assert.equal(action.form, 'native-console');
  assert.equal(action.mutation, false);
});

test('outputs are localized independent data with no executable handler or payload', () => {
  const result = tree({ locale: 'en-US' }), flattened = items(result);
  assert.equal(result[0].label, 'Power');
  assert.equal(flattened.find(action => action.id === 'vm.power.start').label, 'Power on');
  for (const action of flattened) { assert.equal(action.handler, undefined); assert.equal(action.payload, undefined); assert.ok(action.form); if (action.operation) { assert.equal(action.operation.method, 'POST'); assert.match(action.operation.path, /^\/v2\/api\/[a-z-]+$/); } }
  flattened[0].operation.path = 'changed';
  assert.equal(find('vm.power.start').operation.path, '/v2/api/start-vm');
  assert.ok(Object.isFrozen(VM_ACTION_CATALOG)); assert.ok(Object.isFrozen(VM_ACTION_CATALOG[0].items[0]));
});

test('catalog covers the observed VM sidebar without treating UI labels as commands', () => {
  const observed = ['vm.general.edit', 'vm.placementGroup', 'vm.hardware.disk.edit', 'vm.hardware.nic.edit', 'vm.availability.ha', 'vm.hostAutostart', 'vm.vmGroup', 'vm.ownership', 'vm.network.links', 'vm.template.create', 'vm.guest.toolsImage.mount', 'vm.guest.toolsImage.unmount', 'vm.recycle.move', 'vm.snapshots.create'];
  for (const id of observed) assert.ok(find(id), id);
  assert.equal(find('vm.general.edit').label, '编辑基本信息');
  for (const id of ['vm.placementGroup', 'vm.hostAutostart', 'vm.vmGroup', 'vm.network.links', 'vm.template.create', 'vm.guest.toolsImage.mount', 'vm.guest.toolsImage.unmount']) {
    const action = find(id);
    assert.equal(action.operation, null, id);
    assert.equal(action.enabled, false, id);
    assert.equal(action.reasonCode, 'unsupported', id);
    assert.equal(action.bindingSource, 'tower-4.9-readonly-sidebar-observation', id);
    assert.match(action.reason, /表单契约尚未核实/, id);
    assert.match(find(id, { locale: 'en-US' }).reason, /not verified/, id);
  }
  assert.equal(find('vm.guest.installTools').operation.operationId, 'InstallVmtools');
  const runningTemplate = find('vm.template.create', { snapshot: { ...snapshot, status: 'RUNNING' } });
  const stoppedTemplate = find('vm.template.create');
  assert.equal(runningTemplate.reasonCode, stoppedTemplate.reasonCode);
  assert.equal(runningTemplate.reason, stoppedTemplate.reason);
});

const migration = { verified: true, vmId: resource.id, taskId: 'demo-migration-task', taskStatus: 'EXECUTING', kind: 'CROSS_CLUSTER', phase: 'TRANSFERRING', controls: { abort: true, cutover: false } };
const migrating = (overrides = {}, vmOverrides = {}) => ({ snapshot: { ...snapshot, status: 'RUNNING', migration: { ...migration, ...overrides }, ...vmOverrides } });

test('ordinary stopped or running VMs cannot abort or cut over a nonexistent migration', () => {
  for (const status of ['STOPPED', 'RUNNING']) for (const id of ['vm.migration.abort', 'vm.migration.cutover']) {
    const action = find(id, { snapshot: { ...snapshot, status } });
    assert.equal(action.enabled, false, `${status} ${id}`);
    assert.equal(action.reasonCode, 'migrationUnknown');
  }
});

test('migration controls require verified VM-bound task identity, not only allowed capabilities', () => {
  for (const overrides of [{ verified: false }, { verified: undefined }, { vmId: 'another-vm' }, { taskId: undefined }, { taskId: '' }, { taskId: resource.id }, { kind: 'WITHIN_CLUSTER' }]) {
    assert.equal(find('vm.migration.abort', migrating(overrides)).enabled, false, JSON.stringify(overrides));
    assert.equal(find('vm.migration.abort', migrating(overrides)).reasonCode, 'migrationUnknown');
  }
  assert.equal(find('vm.migration.abort', migrating()).enabled, true);
});

test('pending, paused, terminal and unknown migration task states cannot activate controls', () => {
  for (const taskStatus of ['PENDING', 'PAUSED', 'FAILED', 'SUCCESSED', 'UNKNOWN', undefined]) {
    for (const id of ['vm.migration.abort', 'vm.migration.cutover']) {
      const action = find(id, migrating({ taskStatus, phase: 'AWAITING_CUTOVER', controls: { abort: true, cutover: true } }));
      assert.equal(action.enabled, false, `${taskStatus} ${id}`);
      assert.equal(action.reasonCode, 'migrationUnknown');
    }
  }
});

test('cutover requires both the waiting phase and an explicit applicable task control', () => {
  assert.equal(find('vm.migration.cutover', migrating({ controls: { cutover: true } })).reasonCode, 'migrationPhase');
  assert.equal(find('vm.migration.cutover', migrating({ phase: 'AWAITING_CUTOVER' })).reasonCode, 'migrationPhase');
  const ready = migrating({ phase: 'AWAITING_CUTOVER', controls: { cutover: true } });
  assert.equal(find('vm.migration.cutover', ready).enabled, true);
  assert.equal(find('vm.migration.cutover', { ...ready, capabilities: {} }).reasonCode, 'permissionUnknown');
});

test('abort requires an eligible phase and explicit task applicability', () => {
  for (const overrides of [{ phase: 'COMPLETED' }, { phase: undefined }, { phase: 'CUTTING_OVER' }, { controls: { abort: false } }, { controls: { abort: 'true' } }, { controls: undefined }]) {
    assert.equal(find('vm.migration.abort', migrating(overrides)).reasonCode, 'migrationPhase');
  }
  assert.equal(find('vm.migration.abort', migrating({ phase: 'AWAITING_CUTOVER' })).enabled, true);
});

test('only the verified migration owning an UPDATING state may bypass its own busy gate', () => {
  assert.equal(find('vm.migration.abort', migrating({}, { entityAsyncStatus: 'UPDATING' })).reasonCode, 'busy');
  assert.equal(find('vm.migration.abort', migrating({ ownsVmUpdate: true }, { entityAsyncStatus: 'UPDATING' })).enabled, true);
  for (const entityAsyncStatus of ['CREATING', 'DELETING', 'UNKNOWN']) assert.equal(find('vm.migration.abort', migrating({ ownsVmUpdate: true }, { entityAsyncStatus })).reasonCode, 'busy');
  assert.equal(find('vm.migration.abort', migrating({ ownsVmUpdate: true }, { protected: true, entityAsyncStatus: 'UPDATING' })).reasonCode, 'protected');
});

test('known unfinished migrations block unrelated mutations even without entityAsyncStatus', () => {
  for (const taskStatus of ['PENDING', 'EXECUTING', 'PAUSED']) {
    const values = migrating({ taskStatus }, { status: 'STOPPED' });
    for (const id of ['vm.power.start', 'vm.migration.withinCluster', 'vm.migration.acrossCluster', 'vm.general.edit']) assert.equal(find(id, values).reasonCode, 'migrationActive', `${taskStatus} ${id}`);
    assert.equal(find('vm.snapshots.list', values).enabled, true);
  }
});

test('guest execution and folder removal require their own object preconditions', () => {
  for (const id of ['vm.guest.hostOptions', 'vm.guest.resetPassword']) {
    assert.equal(find(id).enabled, false);
    assert.equal(find(id, { snapshot: { ...snapshot, status: 'RUNNING' } }).reasonCode, 'guestAgent');
    assert.equal(find(id, { snapshot: { ...snapshot, status: 'RUNNING', vm_tools_status: 'RUNNING' } }).enabled, true);
    assert.equal(find(id, { snapshot: { ...snapshot, status: 'STOPPED', vm_tools_status: 'RUNNING' } }).enabled, false);
  }
  assert.equal(find('vm.folder.remove').reasonCode, 'folder');
  assert.equal(find('vm.folder.remove', { snapshot: { ...snapshot, folder: null } }).enabled, false);
  assert.equal(find('vm.folder.remove', { snapshot: { ...snapshot, folder: { id: 'demo-folder' } } }).enabled, true);
});

test('migration failure explanations remain localized and do not expose invented API fields', () => {
  assert.match(find('vm.migration.abort').reason, /迁移任务证据/);
  assert.match(find('vm.migration.abort', { locale: 'en-US' }).reason, /verified executing cross-cluster migration task/i);
  assert.match(find('vm.migration.cutover', { ...migrating(), locale: 'en-US' }).reason, /migration phase/i);
});
