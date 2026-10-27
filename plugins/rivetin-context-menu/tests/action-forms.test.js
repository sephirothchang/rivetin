import test from 'node:test';
import assert from 'node:assert/strict';
import { FORM_ACTIONS, actionFields, initialValues, fieldValues } from '../src/actions/forms.js';
import { VM_ACTION_CATALOG } from '../src/actions/catalog.js';

const state = () => ({
  id: 'vm-a', name: 'VM A', description: 'Existing description', cpu_sockets: 2, cpu_cores: 4,
  cluster: { id: 'cluster-a' }, host: { id: 'host-current' },
  snapshots: [{ id: 'snapshot-own', name: 'Owned checkpoint', vm: { id: 'vm-a' } }],
  availableHosts: [{ id: 'host-destination', name: 'Destination', cluster: { id: 'cluster-a' }, status: 'CONNECTED_HEALTHY' }],
});
const fields = (id, snapshot = state()) => actionFields(id, snapshot);
const optionIds = (id, snapshot, fieldId) => fields(id, snapshot).find(field => field.id === fieldId).options.map(option => option.value);

test('all fourteen supported production actions have distinct catalog bindings and usable field contracts', () => {
  assert.equal(FORM_ACTIONS.length, 14); assert.equal(new Set(FORM_ACTIONS).size, 14);
  const catalogIds = new Set(VM_ACTION_CATALOG.flatMap(group => group.items).map(action => action.id));
  for (const actionId of FORM_ACTIONS) {
    assert.ok(catalogIds.has(actionId), `${actionId} must belong to the action catalog`);
    const schema = fields(actionId), english = actionFields(actionId, state(), 'en-US');
    assert.equal(new Set(schema.map(field => field.id)).size, schema.length);
    assert.deepEqual(english.map(field => ({ id: field.id, type: field.type })), schema.map(field => ({ id: field.id, type: field.type })));
    assert.ok(schema.every(field => field.label && ['text', 'number', 'select', 'checkbox'].includes(field.type)));
    assert.ok(english.every(field => typeof field.label === 'string' && field.label.length > 0));
    if (actionId.startsWith('vm.power.')) { assert.deepEqual(schema, []); assert.deepEqual(fieldValues(schema, {}), {}); continue; }
    assert.ok(schema.length > 0, `${actionId} must expose its required business fields`);
    const values = initialValues(schema);
    for (const field of schema) if (!Object.hasOwn(values, field.id)) {
      if (field.type === 'select') values[field.id] = field.options[0]?.value;
      else if (field.type === 'number') values[field.id] = field.min || 1;
      else if (field.type === 'checkbox') values[field.id] = true;
      else values[field.id] = field.required ? 'New name' : '';
    }
    assert.doesNotThrow(() => fieldValues(schema, values), `${actionId} should admit a valid form submission`);
  }
});

test('CPU values preserve socket/core topology and real API snake_case keys', () => {
  const schema = fields('vm.hardware.cpu');
  assert.deepEqual(initialValues(schema), { cpu_sockets: 2, cpu_cores: 4 });
  const input = { cpu_sockets: '2', cpu_cores: '6', vcpu: 12, vm_id: 'other-vm' };
  assert.deepEqual(fieldValues(schema, input), { cpu_sockets: 2, cpu_cores: 6 });
  assert.deepEqual(input, { cpu_sockets: '2', cpu_cores: '6', vcpu: 12, vm_id: 'other-vm' });
});

test('memory amount and decimal unit are independent API fields, never implicit binary conversion', () => {
  const schema = fields('vm.hardware.memory');
  assert.deepEqual(initialValues(schema), { memory_unit: 'MB' });
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB', 'PB']) assert.deepEqual(fieldValues(schema, { memory: '4', memory_unit: unit }), { memory: 4, memory_unit: unit });
  for (const unit of ['MiB', 'GiB', 'mb', 'bytes', '', null, undefined, 1024]) assert.throws(() => fieldValues(schema, { memory: 4, memory_unit: unit }), /INVALID_FORM_VALUE/);
});

test('empty, fractional, nonfinite, negative and out-of-range numeric input is rejected', () => {
  const schema = fields('vm.hardware.cpu');
  for (const value of ['', ' ', null, undefined, NaN, Infinity, -Infinity, 0, '0', -1, '-1', 1.5, '1.5', 2147483648, '2147483648']) {
    assert.throws(() => fieldValues(schema, { cpu_sockets: value, cpu_cores: 2 }), /INVALID_FORM_VALUE/, `invalid CPU value ${String(value)}`);
  }
  assert.throws(() => fieldValues(fields('vm.hardware.memory'), { memory: Number.MAX_SAFE_INTEGER + 1, memory_unit: 'MB' }), /INVALID_FORM_VALUE/);
  assert.throws(() => fieldValues(fields('vm.hardware.memory'), { memory: '4096.5', memory_unit: 'MB' }), /INVALID_FORM_VALUE/);
});

test('numeric inputs cannot coerce boolean or array values into valid CPU topology', () => {
  for (const value of [true, false, [], [1], ['2'], {}]) assert.throws(() => fieldValues(fields('vm.hardware.cpu'), { cpu_sockets: value, cpu_cores: '2' }), /INVALID_FORM_VALUE/);
});

test('snapshot restoration offers only snapshots belonging to the exact current VM and not changing', () => {
  const snapshot = state(); snapshot.snapshots.push(
    { id: 'snapshot-foreign', vm: { id: 'vm-b' } },
    { id: 'snapshot-busy', vm: { id: 'vm-a' }, entityAsyncStatus: 'UPDATING' },
    { id: 'snapshot-orphan' },
  );
  assert.deepEqual(optionIds('vm.snapshots.restore', snapshot, 'snapshot_id'), ['snapshot-own']);
  assert.deepEqual(fieldValues(fields('vm.snapshots.restore', snapshot), { snapshot_id: 'snapshot-own' }), { snapshot_id: 'snapshot-own' });
  for (const id of ['snapshot-foreign', 'snapshot-busy', 'snapshot-orphan', 'Owned checkpoint', '']) assert.throws(() => fieldValues(fields('vm.snapshots.restore', snapshot), { snapshot_id: id }), /INVALID_FORM_VALUE/);
});

test('missing current VM identity cannot make an orphan snapshot look owned', () => {
  assert.deepEqual(optionIds('vm.snapshots.restore', { snapshots: [{ id: 'orphan', name: 'Unowned checkpoint' }] }, 'snapshot_id'), []);
});

test('within-cluster migration offers only healthy, idle hosts in the current cluster', () => {
  const snapshot = state(); snapshot.availableHosts.push(
    { id: 'host-other-cluster', cluster: { id: 'cluster-b' }, status: 'CONNECTED_HEALTHY' },
    { id: 'host-disconnected', cluster: { id: 'cluster-a' }, status: 'DISCONNECTED' },
    { id: 'host-unhealthy', cluster: { id: 'cluster-a' }, status: 'CONNECTED_UNHEALTHY' },
    { id: 'host-busy', cluster: { id: 'cluster-a' }, status: 'CONNECTED_HEALTHY', entityAsyncStatus: 'UPDATING' },
    { id: 'host-orphan', status: 'CONNECTED_HEALTHY' },
  );
  assert.deepEqual(optionIds('vm.migration.withinCluster', snapshot, 'host_id'), ['host-destination']);
  assert.deepEqual(fieldValues(fields('vm.migration.withinCluster', snapshot), { host_id: 'host-destination' }), { host_id: 'host-destination' });
  for (const id of ['host-other-cluster', 'host-disconnected', 'host-unhealthy', 'host-busy', 'host-orphan', '']) assert.throws(() => fieldValues(fields('vm.migration.withinCluster', snapshot), { host_id: id }), /INVALID_FORM_VALUE/);
});

test('unknown current cluster identity cannot authorize orphan migration targets', () => {
  assert.deepEqual(optionIds('vm.migration.withinCluster', { id: 'vm-a', availableHosts: [{ id: 'host-orphan', status: 'CONNECTED_HEALTHY' }] }, 'host_id'), []);
});

test('snapshot consistency is an explicit server enum and invalid choices cannot pass through', () => {
  const schema = fields('vm.snapshots.create');
  assert.deepEqual(initialValues(schema), { consistent_type: 'CRASH_CONSISTENT' });
  for (const value of ['CRASH_CONSISTENT', 'FILE_SYSTEM_CONSISTENT']) assert.deepEqual(fieldValues(schema, { name: 'Checkpoint', consistent_type: value }), { name: 'Checkpoint', consistent_type: value });
  for (const value of ['', 'crash', 'APPLICATION_CONSISTENT', true, null]) assert.throws(() => fieldValues(schema, { name: 'Checkpoint', consistent_type: value }), /INVALID_FORM_VALUE/);
});

test('user-visible names and descriptions respect boundaries without silently trimming or truncating', () => {
  for (const id of ['vm.general.edit', 'vm.snapshots.create', 'vm.clone']) {
    const limit = id === 'vm.general.edit' ? 256 : 128;
    const schema = fields(id), base = { ...initialValues(schema), name: 'A'.repeat(limit) };
    assert.equal(fieldValues(schema, base).name.length, limit);
    for (const name of ['', '   ', 'A'.repeat(limit + 1), null, 123]) assert.throws(() => fieldValues(schema, { ...base, name }), /INVALID_FORM_VALUE/);
  }
  const schema = fields('vm.general.edit');
  assert.equal(fieldValues(schema, { name: 'VM renamed', description: 'D'.repeat(4096) }).description.length, 4096);
  assert.throws(() => fieldValues(schema, { name: 'VM renamed', description: 'D'.repeat(4097) }), /INVALID_FORM_VALUE/);
});

test('optional description distinguishes omission from explicit clearing and excludes unrelated input', () => {
  const schema = fields('vm.general.edit');
  assert.deepEqual(fieldValues(schema, { name: 'VM renamed', description: undefined, confirmName: 'VM A', owner_id: 'other-user' }), { name: 'VM renamed' });
  assert.deepEqual(fieldValues(schema, { name: 'VM renamed', description: '' }), { name: 'VM renamed', description: '' });
  assert.deepEqual(fieldValues(schema, { name: 'VM renamed', description: '  Keep this spacing  ' }), { name: 'VM renamed', description: '  Keep this spacing  ' });
  assert.throws(() => fieldValues(schema, { name: 'VM renamed', description: null }), /INVALID_FORM_VALUE/);
});

test('clone full-copy choice is a real boolean, including explicit false', () => {
  const schema = fields('vm.clone');
  assert.deepEqual(initialValues(schema), { is_full_copy: true });
  for (const value of [true, false]) assert.deepEqual(fieldValues(schema, { name: 'VM clone', is_full_copy: value }), { name: 'VM clone', is_full_copy: value });
});

test('missing or nonboolean clone choices cannot silently become linked clones', () => {
  for (const value of [undefined, null, '', 'true', 'false', 0, 1, [], {}]) assert.throws(() => fieldValues(fields('vm.clone'), { name: 'VM clone', is_full_copy: value }), /INVALID_FORM_VALUE/);
});
