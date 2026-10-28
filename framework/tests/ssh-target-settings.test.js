import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import utils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { defaultDevicePolicy, validateDevicePolicy, validateDeviceInventory, validManagementAddress, addHostTargets, createSshTargetSettings } from '../src/ssh-target-settings.js';
const { act } = utils;
const inventory = { clusters: [{ id: 'example-cluster', name: 'Example cluster' }, { id: 'other-cluster', name: 'Other cluster' }], hosts: [
  { id: 'example-host-1', name: 'Same name', clusterId: 'example-cluster', address: '192.0.2.10' },
  { id: 'example-host-2', name: 'Same name', clusterId: 'example-cluster', address: '192.0.2.20' },
  { id: 'example-host-3', name: 'Other host', clusterId: 'other-cluster', address: '198.51.100.20' },
  { id: 'example-host-4', name: 'Unconfigured host', clusterId: 'other-cluster', address: '' },
] };
function disks() { return { version: 1, hostId: 'example-host', category: 'disk', complete: true, inventoryRevision: 'EXAMPLE_SET_TOKEN', expiresAt: new Date(Date.now() + 60000).toISOString(), items: [{ id: 'example-disk', label: 'Example disk', model: 'Example SSD', selectable: true, selectionToken: 'EXAMPLE_SIGNED_TOKEN' }, { id: 'unverified-disk', label: 'Unverified disk', model: 'Example virtual disk', selectable: false, reason: 'SSH_DEVICE_IDENTITY_UNVERIFIED' }] }; }
test('new targets get four independent all policies without copying host pins or credentials', () => {
  const existing = [{ hostId: 'example-host-1', connection: { username: 'example-existing-reader' } }], before = structuredClone(existing);
  const result = addHostTargets(existing, inventory.hosts, ['example-host-2', 'example-host-3'], 2222);
  assert.deepEqual(existing, before); assert.deepEqual(result[0], existing[0]);
  for (const target of result.slice(1)) { assert.equal(target.hostKeySha256, ''); assert.equal(target.connection, null); assert.equal(target.port, 2222); assert.deepEqual(target.devicePolicy, defaultDevicePolicy()); assert.equal(Object.hasOwn(target, 'devices'), false); }
  result[1].devicePolicy.classes.disk.mode = 'custom'; assert.equal(result[2].devicePolicy.classes.disk.mode, 'all');
});
test('bulk add rejects duplicates, missing objects, invalid ports, existing hosts and capacity overflow atomically', () => {
  const existing = [{ hostId: 'example-host-1' }];
  for (const ids of [[], ['example-host-1'], ['missing-host'], ['example-host-4'], ['example-host-2', 'example-host-2']]) assert.throws(() => addHostTargets(existing, inventory.hosts, ids));
  for (const port of [0, 65536, 22.5, '22']) assert.throws(() => addHostTargets(existing, inventory.hosts, ['example-host-2'], port));
  assert.throws(() => addHostTargets(existing, [...inventory.hosts, inventory.hosts[1]], ['example-host-2']));
  assert.throws(() => addHostTargets(Array.from({ length: 500 }, (_, n) => ({ hostId: 'host-' + n })), inventory.hosts, ['example-host-2']));
  assert.deepEqual(existing, [{ hostId: 'example-host-1' }]);
});
test('management address checks reject loopback/link local/mapped/scoped targets and accept inventory examples', () => {
  for (const address of ['192.0.2.10', '2001:db8::10']) assert.equal(validManagementAddress(address), true);
  for (const address of ['127.0.0.1', '169.254.1.2', '224.0.0.1', '::1', '::', 'fe80::1', '::ffff:192.0.2.1', 'fe80::1%1', '192.0.2.999', '192.00.2.1', 'example.invalid']) assert.equal(validManagementAddress(address), false, address);
});
test('custom empty stays empty, IDs normalize order and arbitrary identity or operation fields are rejected', () => {
  const policy = defaultDevicePolicy(); policy.classes.disk = { mode: 'custom', ids: [] }; assert.deepEqual(validateDevicePolicy(policy), policy);
  policy.classes.disk.ids = ['disk-z', 'disk-a']; assert.deepEqual(validateDevicePolicy(policy).classes.disk.ids, ['disk-a', 'disk-z']);
  for (const patch of [value => value.classes.disk.ids.push('disk-a'), value => value.classes.disk.path = '/dev/sdb', value => value.classes.disk.serial = 'EXAMPLE_SERIAL', value => value.classes.disk.mode = 'unknown', value => value.classes.extra = { mode: 'all', ids: [] }]) { const value = structuredClone(policy); patch(value); assert.throws(() => validateDevicePolicy(value)); }
  assert.throws(() => validateDevicePolicy({ ...defaultDevicePolicy(), classes: { ...defaultDevicePolicy().classes, disk: { mode: 'all', ids: ['example-disk'] } } }));
});
test('inventory requires complete fresh host-bound opaque proofs and rejects path/SN or partial/duplicate rows', () => {
  assert.deepEqual(validateDeviceInventory(disks(), 'example-host').items.map(row => row.id), ['example-disk', 'unverified-disk']);
  for (const patch of [value => value.complete = false, value => value.hostId = 'other-host', value => value.category = 'gpu', value => value.expiresAt = '2020-01-01T00:00:00Z', value => value.items.push(value.items[0]), value => delete value.items[0].selectionToken, value => value.items[0].path = '/dev/sdb', value => value.items[0].serial = 'EXAMPLE_SERIAL', value => value.items[0].model = 'PRIVATE\nSTACK']) { const value = disks(); patch(value); assert.throws(() => validateDeviceInventory(value, 'example-host')); }
});
async function mount(t, mode = 'bulk', extra = {}) {
  const win = new JSDOM('<html><body><button id="before">Before</button><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true }).window;
  globalThis.window = win; globalThis.document = win.document;
  const root = document.getElementById('root'), { BulkHostPicker, DeviceScopeEditor } = createSshTargetSettings(React), calls = { add: [], closed: 0, change: [], select: [], load: 0 };
  let props = mode === 'bulk' ? { inventory, hosts: [{ hostId: 'example-host-1' }], onAdd: rows => calls.add.push(rows), onClose: () => calls.closed++ } : { hostId: 'example-host', policy: { ...defaultDevicePolicy(), classes: { ...defaultDevicePolicy().classes, disk: { mode: 'custom', ids: [] } } }, capabilities: { classes: { disk: { inventory: true, custom: true } } }, inventory: disks(), onLoad: () => calls.load++, onChange: value => calls.change.push(value), onSelect: value => calls.select.push(value) };
  props = { ...props, ...extra };
  const render = async patch => { props = { ...props, ...patch }; await act(async () => { ReactDOM.render(React.createElement(mode === 'bulk' ? BulkHostPicker : DeviceScopeEditor, props), root); }); };
  document.getElementById('before').focus(); await render({});
  t.after(async () => { await act(async () => ReactDOM.unmountComponentAtNode(root)); win.close(); delete globalThis.window; delete globalThis.document; });
  const click = async node => { assert.ok(node); await act(async () => node.click()); };
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
  return { win, root, calls, render, click, button, change: async (node, value) => act(async () => utils.Simulate.change(node, { target: { value } })) };
}
test('bulk selector filters by cluster, preserves hidden selections and only appends canonical available hosts', async t => {
  const ui = await mount(t);
  assert.equal(document.querySelector('[aria-label="选择主机 example-host-1"]').disabled, true); assert.equal(document.querySelector('[aria-label="选择主机 example-host-4"]').disabled, true);
  await ui.click(document.querySelector('[aria-label="选择主机 example-host-2"]'));
  await ui.change(document.querySelector('select'), 'other-cluster'); await ui.click(ui.button('全选当前可添加项'));
  await ui.click(ui.button('将 2 台主机加入草稿'));
  assert.equal(ui.calls.closed, 1); assert.deepEqual(ui.calls.add[0].map(row => row.hostId), ['example-host-1', 'example-host-2', 'example-host-3']);
  assert.equal(ui.calls.add[0][1].hostKeySha256, '');
});
test('bulk cancellation, focus loop and Escape do not mutate targets or leak keyboard events to the hub', async t => {
  const ui = await mount(t); let escaped = 0; document.addEventListener('keydown', event => { if (event.key === 'Escape') escaped++; });
  const dialog = document.querySelector('[role=dialog]'), close = document.querySelector('[aria-label="关闭批量选择"]'); close.focus();
  const buttons = [...dialog.querySelectorAll('button,input,select')].filter(node => !node.disabled), last = buttons[buttons.length - 1];
  await act(async () => close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, last);
  await act(async () => last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(ui.calls.closed, 1); assert.equal(escaped, 0); assert.deepEqual(ui.calls.add, []);
});
test('scope editor does not load automatically, preserves custom empty and disables unsupported categories', async t => {
  const ui = await mount(t, 'scope'); assert.equal(ui.calls.load, 0);
  assert.match(document.body.textContent, /已选 0 项；空列表不允许任何设备/);
  const options = [...document.querySelectorAll('.pk-ssh-scope-option')]; for (const option of options.slice(1)) assert.equal(option.querySelectorAll('input')[1].disabled, true);
  assert.equal(document.querySelector('[aria-label="选择磁盘 unverified-disk"]').disabled, true);
  await ui.click(document.querySelector('[aria-label="选择磁盘 example-disk"]')); assert.deepEqual(ui.calls.select, [['example-disk']]);
  assert.doesNotMatch(JSON.stringify(ui.calls.select), /EXAMPLE_SIGNED_TOKEN|path|serial/);
  await ui.click(ui.button('刷新磁盘清单')); assert.equal(ui.calls.load, 1);
});
test('scope changes use policy IDs only and English errors remain generic', async t => {
  const ui = await mount(t, 'scope', { inventoryError: 'PRIVATE_STACK_AND_TOKEN', loading: false });
  assert.doesNotMatch(document.body.textContent, /PRIVATE_STACK_AND_TOKEN/);
  await ui.click(document.querySelector('.pk-ssh-scope-option input'));
  assert.deepEqual(ui.calls.change[0].classes.disk, { mode: 'all', ids: [] });
  await ui.render({ locale: 'en-US' }); assert.match(document.body.textContent, /Device access scope/); assert.match(document.body.textContent, /Disk inventory is unavailable or expired/);
});
