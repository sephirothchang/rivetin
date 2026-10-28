import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createSshVault } from '../server/ssh-vault.js';
import { createSshConnectionsStore, createSshConnectionSettings } from '../src/ssh-connection-settings.js';
import { defaultDevicePolicy } from '../src/ssh-target-settings.js';
const { act } = testUtils;
async function fixture(t) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'ssh-connection-store-'));
  const vault = createSshVault(root);
  await vault.saveConnections({ version: 1, operationId: randomUUID(), global: { username: 'example-reader', authType: 'password', password: { action: 'replace', value: 'EXAMPLE_SAVED_PASSWORD' }, privateKey: { action: 'keep' } }, clusters: [],
    hosts: [{ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, hostKeySha256: 'a'.repeat(64), devices: [{ deviceId: 'example-disk', path: '/dev/sda', serial: 'EXAMPLE_SERIAL' }], connection: null }] });
  // A v2 contract mock around the existing real credential vault; this is not a v2 backend implementation.
  const policies = new Map([['example-host', { ...defaultDevicePolicy(), classes: { ...defaultDevicePolicy().classes, disk: { mode: 'custom', ids: ['example-disk'] } } }]]);
  const failures = { load: false, put: '', inventory: false, malformed: false, saveCode: '', migration: false }, calls = [];
  const summary = async () => { const value = await vault.connections(); return { ...value, version: 2, migration: { persistedVersion: failures.migration ? 1 : 2, required: failures.migration, state: failures.migration ? 'required' : 'ready' }, hosts: value.hosts.map(({ devices, ...row }) => ({ ...row, devicePolicy: structuredClone(policies.get(row.hostId) || defaultDevicePolicy()), policyState: { disk: 'ready', unresolvedLegacyCount: 0, changedSelectionCount: 0 } })) }; };
  const commit = async body => {
    if (body.expectedRevision !== (await vault.connections()).revision) throw Object.assign(new Error('SSH_CONNECTION_REVISION_CONFLICT'), { status: 409 });
    const previous = await vault.connections();
    const value = await vault.saveConnections({ version: 1, operationId: body.operationId, global: body.global, clusters: body.clusters, hosts: body.hosts.map(({ devicePolicy, ...row }) => ({ ...row, devices: previous.hosts.find(host => host.hostId === row.hostId)?.devices || [] })) });
    for (const host of body.hosts) policies.set(host.hostId, structuredClone(host.devicePolicy));
    return { version: 2, operationId: body.operationId, committedRevision: value.revision, replayed: false, connections: await summary() };
  };
  const client = async (route, method = 'GET', body, options = {}) => {
    calls.push({ route, method, body: body === undefined ? undefined : structuredClone(body), signal: options.signal });
    if (route === '/ssh-channel/preflight') {
      assert.equal(method, 'POST'); if (failures.preflight) return failures.preflight(body, options);
      throw new Error('SSH_PREFLIGHT_UNAVAILABLE');
    }
    if (route === '/ssh-channel/policy-capabilities') return failures.capabilities || { version: 1, connectionsVersion: 2, maxTargets: 100, classes: Object.fromEntries(['disk', 'gpu', 'usb', 'pcie'].map(category => [category, { inventory: category === 'disk', custom: category === 'disk', operations: category === 'disk' ? ['disk.smart.read'] : [] }])), execution: { manual: false, scheduled: false, reason: 'SSH_POLICY_RESOLVER_UNAVAILABLE' } };
    if (route.startsWith('/ssh-channel/device-inventory?')) {
      if (failures.disks) return failures.disks(route, options);
      const hostId = new URL('https://tower.example.invalid' + route).searchParams.get('hostId');
      return diskInventory(hostId);
    }
    if (route === '/ssh-channel/inventory') {
      if (failures.inventory) throw new Error('EXAMPLE_PRIVATE_INVENTORY_ERROR');
      return { clusters: [{ id: 'tower-cluster-1', name: 'Example cluster' }], hosts: [{ id: 'tower-host-1', name: 'Example host', clusterId: 'tower-cluster-1', address: '192.0.2.20' }] };
    }
    assert.equal(route, '/ssh-channel/connections');
    if (method === 'GET') {
      if (failures.load) throw new Error('EXAMPLE_PRIVATE_LOAD_ERROR');
      const value = await summary(); if (failures.malformed) value.global.password = 'EXAMPLE_FORBIDDEN_RESPONSE_SECRET'; return value;
    }
    if (failures.put === 'before') throw new Error('EXAMPLE_PRIVATE_PUT_ERROR');
    if (failures.saveCode) throw Object.assign(new Error(failures.saveCode), { status: 409 });
    const value = await commit(body);
    if (failures.put === 'after') throw new Error('EXAMPLE_PRIVATE_RESPONSE_LOST');
    return value;
  };
  const store = createSshConnectionsStore({ client, crypto: { randomUUID } }); await store.load();
  t.after(async () => { store.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { store, vault, client, calls, failures, summary, commit };
}
function diskInventory(hostId, expiresAt = new Date(Date.now() + 60000).toISOString()) { return { version: 1, hostId, category: 'disk', complete: true, inventoryRevision: 'EXAMPLE_INVENTORY_REVISION', expiresAt, items: [{ id: 'example-disk', label: 'Example disk', model: 'Example SSD', selectable: true, selectionToken: 'EXAMPLE_SIGNED_SELECTION_TOKEN' }, { id: 'example-disk-2', label: 'Second disk', model: 'Example NVMe', selectable: true, selectionToken: 'EXAMPLE_SECOND_TOKEN' }] }; }
function replace(store, value = 'EXAMPLE_NEW_PASSWORD') { store.update({ global: { ...store.getDraft().global, password: { action: 'replace', value } } }); }

test('SSH connection drafts use an isolated store, never return saved secrets and never write until shared save', async t => {
  const f = await fixture(t); assert.equal(f.store.status().dirty, false); assert.doesNotMatch(JSON.stringify(f.store.get()), /EXAMPLE_SAVED_PASSWORD/);
  assert.deepEqual(f.store.getDraft().global.password, { action: 'keep' }); replace(f.store);
  assert.equal(f.store.status().dirty, true); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal((await f.vault.get('example-host')).password, 'EXAMPLE_SAVED_PASSWORD');
  assert.equal(await f.store.save(), true); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal((await f.vault.get('example-host')).password, 'EXAMPLE_NEW_PASSWORD');
  assert.equal(f.store.status().dirty, false); assert.deepEqual(f.store.getDraft().global.password, { action: 'keep' });
  assert.doesNotMatch(JSON.stringify({ saved: f.store.get(), draft: f.store.getDraft() }), /EXAMPLE_(SAVED|NEW)_PASSWORD/);
  assert.ok(f.calls.every(call => call.route === '/ssh-channel/connections'));
});

test('SSH connection keep and discard do not replace secrets or issue a write', async t => {
  const f = await fixture(t); replace(f.store); f.store.discard();
  assert.equal(f.store.status().dirty, false); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  f.store.update({ global: { ...f.store.getDraft().global, username: 'renamed-reader' } });
  assert.equal(await f.store.save(), true); assert.equal((await f.vault.get('example-host')).password, 'EXAMPLE_SAVED_PASSWORD');
  const body = f.calls.find(call => call.method === 'PUT').body;
  assert.deepEqual(body.global.password, { action: 'keep' }); assert.deepEqual(body.global.privateKey, { action: 'keep' });
});

test('SSH uncertain successful PUT is reconciled by operation ID with one GET and no repeated write', async t => {
  const f = await fixture(t); replace(f.store); f.failures.put = 'after';
  assert.equal(await f.store.save(), true); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'GET').length, 2); assert.equal(f.store.status().dirty, false);
  assert.equal(f.store.get().operationId, f.calls.find(call => call.method === 'PUT').body.operationId);
});

test('SSH unconfirmed writes and failed reloads preserve draft secrets and cannot report success', async t => {
  const f = await fixture(t); replace(f.store); f.failures.put = 'before';
  assert.equal(await f.store.save(), false); assert.equal(f.store.status().dirty, true); assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1); assert.equal(f.store.status().error, 'SSH_CONNECTION_OUTCOME_UNKNOWN');
  f.failures.load = true; await f.store.load(); assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
  assert.doesNotMatch(f.store.status().error, /EXAMPLE_PRIVATE/);
  f.failures.load = false; f.failures.put = ''; assert.equal(await f.store.save(), false);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1, 'unknown outcomes never replay a PUT');
});

test('SSH a secret-bearing server summary is rejected and disposal clears pending secret memory', async t => {
  const f = await fixture(t); f.failures.malformed = true; await f.store.load();
  assert.equal(f.store.status().error, 'SSH_CONNECTION_RESPONSE_INVALID'); assert.doesNotMatch(JSON.stringify(f.store.get()), /EXAMPLE_FORBIDDEN_RESPONSE_SECRET/);
  replace(f.store); f.store.dispose(); assert.doesNotMatch(JSON.stringify({ saved: f.store.get(), draft: f.store.getDraft() }), /EXAMPLE_(SAVED|NEW)_PASSWORD/);
});

test('SSH a slow GET cannot roll back the baseline after a newer PUT succeeds', async t => {
  const f = await fixture(t), old = await f.summary(); let reads = 0, release;
  const slow = new Promise(resolve => { release = resolve; });
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async (route, method, body) => {
    if (method === 'PUT') return f.commit(body);
    return ++reads === 1 ? old : slow;
  } });
  t.after(() => store.dispose()); await store.load(); replace(store);
  const loading = store.load(); assert.equal(store.status().loading, true);
  assert.equal(await store.save(), true); const saved = store.get(); assert.ok(saved.revision > old.revision);
  release(old); await loading;
  assert.deepEqual(store.get(), saved); assert.equal(store.status().revision, saved.revision); assert.equal(store.status().dirty, false); assert.equal(store.status().loading, false);
  assert.deepEqual(store.getDraft().global.password, { action: 'keep' }); assert.doesNotMatch(JSON.stringify(store.getDraft()), /EXAMPLE_NEW_PASSWORD/);
});

test('SSH an edit made during a slow reload is retained without replacing its saved baseline', async t => {
  const f = await fixture(t), original = await f.summary(); let reads = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async () => ++reads === 1 ? original : waiting });
  t.after(() => store.dispose()); await store.load(); const loading = store.load(); replace(store);
  release({ ...original, revision: original.revision + 1, global: { ...original.global, username: 'different-reader' } }); await loading;
  assert.equal(store.get().global.username, original.global.username); assert.equal(store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD'); assert.equal(store.status().dirty, true);
});

async function mount(t, f, locale = 'zh-CN', options = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://tower.example.invalid' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = document.getElementById('root'), Settings = createSshConnectionSettings(React);
  let enabled = options.preflightEnabled === true;
  const render = async (value, nextEnabled = enabled) => act(async () => { enabled = nextEnabled; ReactDOM.render(React.createElement(Settings, { store: f.store, client: f.client, locale: value, preflightEnabled: enabled }), root); await new Promise(setImmediate); });
  await render(locale);
  await act(async () => { for (let n = 0; n < 50 && f.store.status().loading; n++) await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.equal(f.store.status().loading, false, 'connection fixture reload completed');
  t.after(async () => { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; });
  const label = text => [...document.querySelectorAll('label')].find(row => row.querySelector('span')?.textContent === text);
  const change = async (element, value) => act(async () => { testUtils.Simulate.change(element, { target: { value } }); await new Promise(setImmediate); });
  return { render, label, change, root };
}

test('SSH inventory names and existing aliases coexist; choosing a different host clears its pin and devices only in the draft', async t => {
  const f = await fixture(t), ui = await mount(t, f);
  assert.match(document.body.textContent, /Example host \(tower-host-1\)/); assert.match(document.body.textContent, /已配置映射：example-host/);
  await ui.change(ui.label('选择主机').querySelector('select'), 'tower-host-1');
  const row = f.store.getDraft().hosts[0]; assert.equal(row.hostId, 'tower-host-1'); assert.equal(row.clusterId, 'tower-cluster-1'); assert.equal(row.address, '192.0.2.20');
  assert.equal(row.hostKeySha256, ''); assert.deepEqual(row.devicePolicy, defaultDevicePolicy()); assert.equal(row.connection, null);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0); assert.equal((await f.vault.list())[0].hostId, 'example-host');
});

test('SSH form follows host locale, masks new password input, and edits only the draft', async t => {
  const f = await fixture(t), ui = await mount(t, f);
  await ui.change(ui.label('凭据操作').querySelector('select'), 'replace'); await ui.change(ui.label('新密码').querySelector('input'), 'EXAMPLE_NEW_PASSWORD');
  assert.equal(ui.label('新密码').querySelector('input').type, 'password'); assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await ui.render('en-US'); assert.match(document.body.textContent, /host > cluster > global/); assert.match(document.body.textContent, /Unsaved connection draft/);
  assert.equal(ui.label('New password').querySelector('input').value, 'EXAMPLE_NEW_PASSWORD');
});

test('SSH inventory failure or refresh never discards a secret draft or echoes server diagnostics', async t => {
  const f = await fixture(t); replace(f.store); f.failures.inventory = true; const ui = await mount(t, f);
  assert.match(document.body.textContent, /连接草稿已保留/); assert.doesNotMatch(document.body.textContent, /EXAMPLE_PRIVATE_INVENTORY_ERROR/);
  assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
  f.failures.inventory = false;
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === '刷新目标清单').click(); await new Promise(setImmediate); });
  assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD'); assert.match(document.body.textContent, /Example host/);
});

async function savedOverrides(f, { cluster = true, host = true } = {}) {
  const credential = (username, value) => ({ username, authType: 'password', password: { action: 'replace', value }, privateKey: { action: 'keep' } });
  const draft = f.store.getDraft();
  if (cluster) draft.clusters = [{ clusterId: 'tower-cluster-1', connection: credential('cluster-reader', 'EXAMPLE_CLUSTER_PASSWORD') }];
  if (host) draft.hosts[0].connection = credential('host-reader', 'EXAMPLE_HOST_PASSWORD');
  await f.commit({ ...draft, expectedRevision: f.store.status().revision, selectionProofs: [], operationId: randomUUID() }); await f.store.load();
}
const scopeControl = index => document.querySelector(`select[aria-label="例外 ${index} 范围"]`);
const targetControl = index => document.querySelector(`select[aria-label="例外 ${index} 对象"]`);
async function clickButton(text) { await act(async () => { const button = [...document.querySelectorAll('button')].find(row => row.textContent === text); assert.ok(button, text); button.click(); await new Promise(setImmediate); }); }

test('SSH unified exception cards project saved cluster and host overrides without changing the document or fetching secrets', async t => {
  const f = await fixture(t); await savedOverrides(f); const before = f.store.getDraft(); const puts = f.calls.filter(call => call.method === 'PUT').length;
  const ui = await mount(t, f);
  assert.deepEqual(f.store.getDraft(), before); assert.equal(f.store.status().dirty, false);
  assert.deepEqual([...document.querySelectorAll('.pk-ssh-exception')].map(row => row.dataset.sshScope), ['cluster', 'host']);
  assert.equal(document.querySelectorAll('.pk-ssh-credential-editor').length, 3);
  assert.equal(document.querySelectorAll('.pk-ssh-target .pk-ssh-credential-editor').length, 0);
  assert.equal(document.querySelectorAll('input[type="password"],textarea').length, 0);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, puts);
  assert.doesNotMatch(document.body.textContent, /EXAMPLE_(SAVED|CLUSTER|HOST)_PASSWORD/);
  await ui.render('en-US'); assert.match(document.body.textContent, /Exception rules|Host target settings/); assert.deepEqual(f.store.getDraft(), before);
});

test('SSH add-exception defaults to one unselected cluster rule without creating targets or saving', async t => {
  const f = await fixture(t); await mount(t, f); const targets = f.store.getDraft().hosts;
  await clickButton('+ 添加例外'); const draft = f.store.getDraft();
  assert.equal(scopeControl(1).value, 'cluster'); assert.equal(targetControl(1).value, '');
  assert.equal(draft.clusters.length, 1); assert.deepEqual(draft.hosts, targets); assert.equal(draft.clusters[0].connection.password.action, 'keep');
  assert.equal(f.store.status().dirty, true); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal([...targetControl(1).options].find(row => row.value === 'tower-cluster-1').textContent, 'Example cluster (tower-cluster-1)');
});

test('SSH deleting a host exception restores inheritance without deleting its target, pin or devices', async t => {
  const f = await fixture(t); await savedOverrides(f); await mount(t, f);
  const { connection, ...target } = f.store.getDraft().hosts[0];
  const button = document.querySelector('button[aria-label="删除例外 2"]'); assert.ok(button.querySelector('svg'));
  await act(async () => button.click());
  assert.deepEqual(f.store.getDraft().hosts[0], { ...target, connection: null }); assert.equal(f.store.getDraft().clusters.length, 1);
  assert.match(document.querySelector('[role="status"]').textContent, /指纹和设备映射保留/);
  assert.equal((await f.vault.get('example-host')).password, 'EXAMPLE_HOST_PASSWORD');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('SSH switching a host exception to cluster explicitly restores host inheritance and keeps its target intact', async t => {
  const f = await fixture(t); await savedOverrides(f); const ui = await mount(t, f);
  const { connection, ...target } = f.store.getDraft().hosts[0];
  await ui.change(scopeControl(2), 'cluster'); const draft = f.store.getDraft();
  assert.deepEqual(draft.hosts[0], { ...target, connection: null }); assert.equal(draft.clusters.length, 2);
  assert.equal(draft.clusters[1].clusterId, ''); assert.deepEqual(draft.clusters[1].connection, connection);
  assert.match(document.querySelector('[role="status"]').textContent, /已保存秘密不会迁移/);
  assert.equal(targetControl(2).value, ''); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal((await f.vault.get('example-host')).password, 'EXAMPLE_HOST_PASSWORD');
});

test('SSH switching cluster to an existing host merges only the exception and does not transfer saved cluster secrets', async t => {
  const f = await fixture(t); await savedOverrides(f, { host: false }); const ui = await mount(t, f);
  const before = f.store.getDraft().hosts[0]; await ui.change(scopeControl(1), 'host');
  assert.equal(f.store.getDraft().hosts.length, 2); assert.equal(targetControl(1).value, '');
  await ui.change(targetControl(1), 'example-host'); const draft = f.store.getDraft();
  assert.equal(draft.clusters.length, 0); assert.equal(draft.hosts.length, 1);
  const { connection, ...target } = draft.hosts[0], { connection: inherited, ...original } = before;
  assert.deepEqual(target, original); assert.equal(connection.username, 'cluster-reader'); assert.deepEqual(connection.password, { action: 'keep' });
  assert.equal(await f.store.save(), true);
  assert.equal((await f.vault.connections()).hosts[0].effective.ready, false);
  await assert.rejects(f.vault.get('example-host'), /^Error: SSH_CREDENTIAL_REQUIRED$/);
});

test('SSH a new host exception creates only a draft target and requires an independently verified pin', async t => {
  const f = await fixture(t), ui = await mount(t, f); await clickButton('+ 添加例外'); await ui.change(scopeControl(1), 'host');
  await ui.change(targetControl(1), 'tower-host-1'); const draft = f.store.getDraft(), target = draft.hosts.find(row => row.hostId === 'tower-host-1');
  assert.equal(target.clusterId, 'tower-cluster-1'); assert.equal(target.address, '192.0.2.20'); assert.equal(target.hostKeySha256, ''); assert.deepEqual(target.devicePolicy, defaultDevicePolicy());
  assert.match(document.querySelector('.pk-ssh-exception').textContent, /尚缺可信指纹/);
  assert.equal(await f.store.save(), false); assert.equal(f.store.status().dirty, true); assert.equal((await f.vault.list()).length, 1);
});

test('SSH duplicate exception targets are unavailable while configured aliases stay visible', async t => {
  const f = await fixture(t); await savedOverrides(f); const ui = await mount(t, f);
  assert.match(targetControl(2).textContent, /已配置映射|Configured mapping/);
  await clickButton('+ 添加例外'); assert.equal(scopeControl(2).value, 'cluster');
  assert.equal([...targetControl(2).options].find(row => row.value === 'tower-cluster-1').disabled, true);
  await ui.change(scopeControl(2), 'host');
  const emptyRule = [...document.querySelectorAll('.pk-ssh-exception')].find(row => row.querySelector('select[aria-label$="对象"]').value === '');
  assert.equal([...emptyRule.querySelector('select[aria-label$="对象"]').options].find(row => row.value === 'example-host').disabled, true);
});

test('SSH removing an incomplete host exception leaves no empty target or accidental profile removal', async t => {
  const f = await fixture(t), ui = await mount(t, f); const targets = f.store.getDraft().hosts;
  await clickButton('+ 添加例外'); await ui.change(scopeControl(1), 'host');
  await act(async () => document.querySelector('button[aria-label="删除例外 1"]').click());
  assert.deepEqual(f.store.getDraft().hosts, targets); assert.equal(f.store.getDraft().clusters.length, 0);
  assert.equal(document.querySelectorAll('.pk-ssh-exception').length, 0);
});

test('SSH typed replacement survives scope selection while existing secret summaries are never invented', async t => {
  const f = await fixture(t), ui = await mount(t, f); await clickButton('+ 添加例外');
  const card = document.querySelector('.pk-ssh-exception');
  await ui.change(card.querySelector('select[aria-label="凭据操作"]'), 'replace');
  await ui.change(card.querySelector('input[type="password"]'), 'EXAMPLE_NEW_SCOPE_PASSWORD');
  await ui.change(scopeControl(1), 'host'); await ui.change(targetControl(1), 'example-host');
  const current = document.querySelector('.pk-ssh-exception');
  assert.equal(current.querySelector('input[type="password"]').value, 'EXAMPLE_NEW_SCOPE_PASSWORD');
  assert.match(current.textContent, /此对象已保存凭据：未配置/);
  assert.equal(f.store.getDraft().hosts[0].connection.password.value, 'EXAMPLE_NEW_SCOPE_PASSWORD');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0); assert.doesNotMatch(JSON.stringify(f.store.get()), /EXAMPLE_NEW_SCOPE_PASSWORD/);
});

test('SSH exception priority tooltip and editor labels follow the host language without persisting UI-only fields', async t => {
  const f = await fixture(t), ui = await mount(t, f); const before = f.store.getDraft();
  await act(async () => document.querySelector('button[aria-label="规则优先级"]').click());
  assert.equal(document.querySelector('button[aria-label="规则优先级"]').getAttribute('aria-expanded'), 'true');
  assert.match(document.querySelector('[role="tooltip"]').textContent, /主机例外 > 集群例外 > 全局默认/);
  await ui.render('en-US'); assert.match(document.querySelector('[role="tooltip"]').textContent, /host > cluster > global/);
  assert.deepEqual(f.store.getDraft(), before); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.deepEqual(Object.keys(f.store.getDraft()).sort(), ['clusters', 'global', 'hosts', 'version']);
});

const discoverText = '获取候选指纹（不认证）', verifyText = '验证 SSH（不执行命令）', confirmText = '二次确认并写入指纹草稿';
const preflightCalls = f => f.calls.filter(call => call.route === '/ssh-channel/preflight');
const preflightButton = text => [...document.querySelectorAll('button')].find(button => button.textContent === text);
function observed(body, patch = {}) {
  const sha256Hex = 'c'.repeat(64);
  return { hostId: body.hostId, address: body.address, port: body.port, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:' + Buffer.from(sha256Hex, 'hex').toString('base64').replace(/=+$/, ''), sha256Hex, challenge: 'example-preflight-challenge', expiresAt: new Date(Date.now() + 60000).toISOString(), ...patch };
}
async function acknowledge() { await act(async () => document.querySelector('.pk-ssh-pin-ack input').click()); }

test('SSH preflight is gated by framework/plugin state and never runs automatically', async t => {
  const f = await fixture(t), ui = await mount(t, f);
  assert.equal(preflightButton(discoverText).disabled, true); assert.equal(preflightButton(verifyText).disabled, true); assert.equal(preflightCalls(f).length, 0);
  assert.match(document.querySelector('.pk-ssh-preflight').textContent, /先启用框架与 SSH 通道插件/);
  await ui.render('zh-CN', true);
  assert.equal(preflightButton(discoverText).disabled, false); assert.equal(preflightButton(verifyText).disabled, false); assert.equal(preflightCalls(f).length, 0);
});

test('SSH fingerprint discovery reveals a consistent candidate without trusting it or writing a draft', async t => {
  const f = await fixture(t); f.failures.preflight = body => observed(body); await mount(t, f, 'zh-CN', { preflightEnabled: true });
  const original = f.store.getDraft(); await clickButton(discoverText);
  assert.equal(preflightCalls(f).length, 1); assert.deepEqual(preflightCalls(f)[0].body, { action: 'discover', hostId: 'example-host', address: '192.0.2.10', port: 22 });
  assert.match(document.querySelector('.pk-ssh-candidate').textContent, /尚未受信任|ssh-ed25519|SHA256:/);
  assert.equal(document.querySelector('.pk-ssh-pin-ack input').checked, false); assert.equal(preflightButton(confirmText).disabled, true);
  assert.deepEqual(f.store.getDraft(), original); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await act(async () => preflightButton(confirmText).click()); assert.equal(preflightCalls(f).length, 1);
});

test('SSH fingerprint confirmation requires independent acknowledgment and updates only the pin draft before shared save', async t => {
  const f = await fixture(t); let candidate;
  f.failures.preflight = body => {
    if (body.action === 'discover') { candidate = observed(body); return candidate; }
    assert.deepEqual(body, { action: 'confirm', hostId: 'example-host', address: '192.0.2.10', port: 22, challenge: candidate.challenge, acknowledged: true });
    return { hostId: body.hostId, address: body.address, port: body.port, sha256Hex: candidate.sha256Hex, confirmed: true };
  };
  await mount(t, f, 'zh-CN', { preflightEnabled: true }); const original = f.store.getDraft();
  await clickButton(discoverText); await acknowledge(); assert.equal(preflightButton(confirmText).disabled, false); await clickButton(confirmText);
  assert.deepEqual(f.store.getDraft(), { ...original, hosts: original.hosts.map(row => ({ ...row, hostKeySha256: 'c'.repeat(64) })) });
  assert.equal((await f.vault.get('example-host')).hostKeySha256, 'a'.repeat(64)); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.match(document.querySelector('.pk-ssh-preflight').textContent, /指纹已写入连接草稿，尚未保存/); assert.equal(preflightButton(verifyText).disabled, true);
  assert.equal(document.querySelector('.pk-ssh-candidate'), null);
  await act(async () => { assert.equal(await f.store.save(), true); });
  assert.equal((await f.vault.get('example-host')).hostKeySha256, 'c'.repeat(64)); assert.equal(preflightButton(verifyText).disabled, false);
});

test('SSH authentication verification sends only the saved host ID and never creates approvals, schedules or commands', async t => {
  const f = await fixture(t); f.failures.preflight = body => ({ hostId: body.hostId, verified: true, checkedAt: new Date().toISOString() });
  const ui = await mount(t, f, 'zh-CN', { preflightEnabled: true }), before = f.store.getDraft(); await clickButton(verifyText);
  assert.deepEqual(preflightCalls(f)[0].body, { action: 'verify', hostId: 'example-host' }); assert.deepEqual(f.store.getDraft(), before);
  assert.match(document.querySelector('.pk-ssh-verified').textContent, /认证验证成功，未执行命令/);
  assert.match(document.querySelector('.pk-ssh-verified').textContent, /仅确认本次 SSH 认证成功；命令执行权限、设备 SMART 支持和磁盘健康均未验证/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.ok(f.calls.every(call => !['approve', 'run', 'schedule'].includes(call.body?.action)));
  await ui.render('en-US'); assert.match(document.querySelector('.pk-ssh-verified').textContent, /no commands executed/);
  assert.match(document.querySelector('.pk-ssh-verified').textContent, /Only this SSH authentication was verified/);
  assert.match(document.querySelector('.pk-ssh-verified').textContent, /Command permissions, device SMART support and disk health were not verified/);
});

test('SSH preflight never sends unsaved secrets and verification stays disabled for a dirty draft', async t => {
  const f = await fixture(t); f.failures.preflight = body => observed(body); replace(f.store, 'EXAMPLE_UNSAVED_PREFLIGHT_SECRET');
  await mount(t, f, 'zh-CN', { preflightEnabled: true }); assert.equal(preflightButton(verifyText).disabled, true);
  await act(async () => preflightButton(verifyText).click()); assert.equal(preflightCalls(f).length, 0);
  await clickButton(discoverText); assert.equal(preflightCalls(f).length, 1); assert.doesNotMatch(JSON.stringify(preflightCalls(f).map(call => call.body)), /EXAMPLE_UNSAVED_PREFLIGHT_SECRET|password|privateKey|command/);
  assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_UNSAVED_PREFLIGHT_SECRET');
});

for (const field of ['hostId', 'address', 'port', 'revision']) test(`SSH ${field} changes invalidate in-flight candidate discovery and ignore late responses`, async t => {
  const f = await fixture(t); let release, request;
  const waiting = new Promise(resolve => { release = resolve; }); f.failures.preflight = body => { request = body; return waiting; };
  await mount(t, f, 'zh-CN', { preflightEnabled: true }); await clickButton(discoverText); const call = preflightCalls(f)[0];
  await act(async () => {
    if (field === 'revision') { await f.vault.put({ ...(await f.vault.get('example-host')), username: 'new-reader' }); await f.store.load(); }
    else f.store.update({ hosts: f.store.getDraft().hosts.map(row => ({ ...row, [field]: field === 'port' ? 2222 : field === 'address' ? '192.0.2.20' : 'different-host' })) });
    await new Promise(setImmediate);
  });
  assert.equal(call.signal.aborted, true);
  await act(async () => { release(observed(request)); await new Promise(setImmediate); });
  assert.equal(document.querySelector('.pk-ssh-candidate'), null); assert.equal(f.store.getDraft().hosts[0].hostKeySha256, 'a'.repeat(64));
  assert.equal(preflightCalls(f).filter(item => item.body.action === 'confirm').length, 0);
});

test('SSH disabling preflight during authentication discards the late success result', async t => {
  const f = await fixture(t); let release; const waiting = new Promise(resolve => { release = resolve; }); f.failures.preflight = () => waiting;
  const ui = await mount(t, f, 'zh-CN', { preflightEnabled: true }); await clickButton(verifyText); const call = preflightCalls(f)[0];
  await ui.render('zh-CN', false); assert.equal(call.signal.aborted, true);
  await act(async () => { release({ hostId: 'example-host', verified: true, checkedAt: new Date().toISOString() }); await new Promise(setImmediate); });
  assert.equal(document.querySelector('.pk-ssh-verified'), null); assert.equal(preflightButton(verifyText).disabled, true);
});

test('SSH an expired fingerprint cannot be confirmed even after acknowledgment', async t => {
  const f = await fixture(t); f.failures.preflight = body => observed(body); await mount(t, f, 'zh-CN', { preflightEnabled: true });
  await clickButton(discoverText); await acknowledge(); const original = Date.now;
  try { Date.now = () => original() + 120000; await clickButton(confirmText); } finally { Date.now = original; }
  assert.equal(preflightCalls(f).length, 1); assert.equal(document.querySelector('.pk-ssh-candidate'), null);
  assert.match(document.querySelector('.pk-ssh-preflight [role="alert"]').textContent, /SSH_PREFLIGHT_CANDIDATE_EXPIRED/);
});

for (const kind of ['wrong-host', 'inconsistent-fingerprint', 'private-error']) test(`SSH discovery rejects ${kind} without trusting a candidate or exposing diagnostics`, async t => {
  const f = await fixture(t); f.failures.preflight = body => { if (kind === 'private-error') throw new Error('EXAMPLE_PRIVATE_PASSWORD at /private/location'); return observed(body, kind === 'wrong-host' ? { hostId: 'other-host' } : { fingerprint: 'SHA256:' + 'A'.repeat(43) }); };
  await mount(t, f, 'zh-CN', { preflightEnabled: true }); await clickButton(discoverText);
  assert.equal(document.querySelector('.pk-ssh-candidate'), null); assert.equal(f.store.status().dirty, false);
  assert.match(document.querySelector('.pk-ssh-preflight [role="alert"]').textContent, /SSH_PREFLIGHT_(RESPONSE_INVALID|REQUEST_FAILED)/);
  assert.doesNotMatch(document.body.textContent, /EXAMPLE_PRIVATE_PASSWORD|\/private\/location/);
});

test('SSH a mismatched confirm response cannot replace a host pin', async t => {
  const f = await fixture(t); f.failures.preflight = body => body.action === 'discover' ? observed(body) : { hostId: body.hostId, address: body.address, port: body.port, sha256Hex: 'd'.repeat(64), confirmed: true };
  await mount(t, f, 'zh-CN', { preflightEnabled: true }); await clickButton(discoverText); await acknowledge(); await clickButton(confirmText);
  assert.equal(f.store.getDraft().hosts[0].hostKeySha256, 'a'.repeat(64)); assert.equal(f.store.status().dirty, false); assert.equal(document.querySelector('.pk-ssh-candidate'), null);
  assert.match(document.querySelector('.pk-ssh-preflight [role="alert"]').textContent, /SSH_PREFLIGHT_RESPONSE_INVALID/);
});

test('SSH unmount aborts candidate discovery and prevents late writes into a disposed view', async t => {
  const f = await fixture(t); let release, request; const waiting = new Promise(resolve => { release = resolve; }); f.failures.preflight = body => { request = body; return waiting; };
  const ui = await mount(t, f, 'zh-CN', { preflightEnabled: true }); await clickButton(discoverText); const call = preflightCalls(f)[0];
  await act(async () => ReactDOM.unmountComponentAtNode(ui.root)); assert.equal(call.signal.aborted, true);
  await act(async () => { release(observed(request)); await new Promise(setImmediate); });
  assert.equal(f.store.status().dirty, false); assert.equal(f.calls.filter(item => item.method === 'PUT').length, 0);
});

test('v2 legacy projection is read-only and cannot silently migrate or widen an empty custom scope', async t => {
  const f = await fixture(t); f.failures.migration = true; await f.store.load(); const before = f.store.getDraft();
  replace(f.store); assert.deepEqual(f.store.getDraft(), before); assert.equal(f.store.status().readOnly, true);
  assert.equal(await f.store.save(), false); assert.equal(f.store.status().error, 'SSH_CONNECTION_MIGRATION_REQUIRED');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await mount(t, f); assert.match(document.body.textContent, /旧连接配置尚未显式迁移/);
  assert.equal(document.querySelector('fieldset').disabled, true);
});

test('v2 dirty reload preserves original CAS revision and a 409 retains draft secrets without replay', async t => {
  const f = await fixture(t), base = f.store.status().revision; replace(f.store);
  const old = f.store.getDraft(); await f.commit({ ...old, operationId: randomUUID(), expectedRevision: base, selectionProofs: [] });
  await f.store.load(); assert.equal(f.store.status().revision, base); assert.equal(f.store.status().remoteRevision, base + 1); assert.deepEqual(f.store.getDraft(), old);
  assert.equal(await f.store.save(), false); assert.equal(f.store.status().error, 'SSH_CONNECTION_REVISION_CONFLICT');
  const puts = f.calls.filter(call => call.method === 'PUT'); assert.equal(puts.length, 1); assert.equal(puts[0].body.expectedRevision, base);
  assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
  f.store.discard(); assert.equal(f.store.status().revision, base + 1); assert.equal(f.store.status().dirty, false);
});

test('v2 custom selection sends only opaque proofs and canonical IDs, then clears proof and secret memory on success', async t => {
  const f = await fixture(t), before = f.store.getDraft();
  f.store.selectDevices({ hostId: 'example-host', ids: ['example-disk', 'example-disk-2'], inventory: diskInventory('example-host') });
  assert.equal(f.store.status().dirty, true); assert.doesNotMatch(JSON.stringify(f.store.getDraft()), /EXAMPLE_SECOND_TOKEN|selectionToken|serial|\/dev\//);
  assert.equal(await f.store.save(), true);
  const put = f.calls.find(call => call.method === 'PUT').body; assert.equal(put.version, 2); assert.equal(put.expectedRevision, f.store.status().revision - 1);
  assert.equal(put.selectionProofs.length, 2); assert.deepEqual(put.selectionProofs[1], { hostId: 'example-host', category: 'disk', id: 'example-disk-2', selectionToken: 'EXAMPLE_SECOND_TOKEN' });
  assert.doesNotMatch(JSON.stringify(put), /serial|\/dev\//); assert.equal(f.store.status().dirty, false);
  assert.deepEqual(f.store.getDraft().global, before.global);
});

test('v2 explicit same-ID reselection is dirty and preserves fresh identity proof without changing policy IDs', async t => {
  const f = await fixture(t), before = f.store.getDraft();
  f.store.selectDevices({ hostId: 'example-host', ids: ['example-disk'], inventory: diskInventory('example-host') });
  assert.deepEqual(f.store.getDraft(), before); assert.equal(f.store.status().dirty, true);
  assert.equal(await f.store.save(), true); assert.equal(f.calls.find(call => call.method === 'PUT').body.selectionProofs.length, 1);
});

test('v2 endpoint changes invalidate selection proof and prevent saving new custom IDs without reselecting', async t => {
  const f = await fixture(t); f.store.selectDevices({ hostId: 'example-host', ids: ['example-disk-2'], inventory: diskInventory('example-host') });
  f.store.update({ hosts: f.store.getDraft().hosts.map(row => ({ ...row, address: '192.0.2.30' })) });
  assert.equal(await f.store.save(), false); assert.equal(f.store.status().error, 'SSH_DEVICE_SELECTION_EXPIRED'); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  f.store.discard(); assert.deepEqual(f.store.getDraft().hosts[0].devicePolicy.classes.disk.ids, ['example-disk']); assert.equal(f.store.status().dirty, false);
});

test('v2 expired proofs and server identity changes retain draft and require explicit fresh selection', async t => {
  const f = await fixture(t); f.store.selectDevices({ hostId: 'example-host', ids: ['example-disk-2'], inventory: diskInventory('example-host', new Date(Date.now() + 25).toISOString()) });
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(await f.store.save(), false); assert.equal(f.store.status().error, 'SSH_DEVICE_SELECTION_EXPIRED');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  f.store.selectDevices({ hostId: 'example-host', ids: ['example-disk-2'], inventory: diskInventory('example-host') }); f.failures.saveCode = 'SSH_DEVICE_IDENTITY_CHANGED';
  assert.equal(await f.store.save(), false); assert.equal(f.store.status().error, 'SSH_DEVICE_IDENTITY_CHANGED'); assert.equal(f.store.status().dirty, true);
  assert.deepEqual(f.store.getDraft().hosts[0].devicePolicy.classes.disk.ids, ['example-disk-2']);
});

test('v2 malformed receipts fail unknown without clearing draft secrets or issuing a second PUT', async t => {
  const f = await fixture(t), initial = await f.summary(); let puts = 0;
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async (route, method) => method === 'PUT' ? (puts++, { version: 2, operationId: 'wrong-operation' }) : initial });
  t.after(() => store.dispose()); await store.load(); replace(store);
  assert.equal(await store.save(), false); assert.equal(store.status().error, 'SSH_CONNECTION_OUTCOME_UNKNOWN');
  assert.equal(await store.save(), false); assert.equal(puts, 1); assert.equal(store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
});

test('v2 unknown outcomes freeze edits until readback confirms the submitted draft without replay', async t => {
  const f = await fixture(t), initial = await f.summary(); let latest = initial, readable = true, puts = 0;
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async (route, method, body) => {
    if (method === 'PUT') { puts++; latest = (await f.commit(body)).connections; readable = false; throw new Error('EXAMPLE_RESPONSE_LOST'); }
    if (!readable) throw new Error('EXAMPLE_READBACK_UNAVAILABLE');
    return latest;
  } });
  t.after(() => store.dispose()); await store.load(); replace(store);
  assert.equal(await store.save(), false); assert.equal(store.status().outcomeUnknown, true);
  const pendingDraft = store.getDraft(); replace(store, 'EXAMPLE_UNSUBMITTED_PASSWORD');
  assert.deepEqual(store.getDraft(), pendingDraft, 'unresolved writes cannot be mixed with another draft');
  await store.load(); assert.equal(store.status().error, 'SSH_CONNECTION_OUTCOME_UNKNOWN');
  readable = true; await store.load();
  assert.equal(store.status().outcomeUnknown, false); assert.equal(store.status().dirty, false); assert.equal(puts, 1);
  assert.deepEqual(store.getDraft().global.password, { action: 'keep' });
  assert.equal((await f.vault.get('example-host')).password, 'EXAMPLE_NEW_PASSWORD');
});

test('v2 unknown outcome UI keeps the draft read-only and offers explicit readback without a second PUT', async t => {
  const f = await fixture(t); replace(f.store); f.failures.put = 'before';
  await f.store.save(); await mount(t, f);
  assert.equal(document.querySelector('fieldset.pk-ssh-draft').disabled, true);
  await clickButton('核对保存结果');
  assert.equal(f.store.status().outcomeUnknown, true); assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('v2 a historical receipt cannot replace a newer server snapshot already observed by the client', async t => {
  const f = await fixture(t), initial = await f.summary(); let latest = initial;
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async (route, method, body) => method === 'PUT'
    ? { version: 2, operationId: body.operationId, committedRevision: initial.revision + 1, replayed: true, connections: { ...initial, revision: initial.revision + 1, operationId: body.operationId } }
    : latest });
  t.after(() => store.dispose()); await store.load(); replace(store);
  latest = { ...initial, revision: initial.revision + 2, operationId: randomUUID(), global: { ...initial.global, username: 'newer-reader' } };
  await store.load(); assert.equal(store.get().revision, latest.revision);
  assert.equal(await store.save(), false); assert.equal(store.status().error, 'SSH_CONNECTION_OUTCOME_UNKNOWN');
  assert.equal(store.get().revision, latest.revision); assert.equal(store.get().global.username, 'newer-reader');
  assert.equal(store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
});

test('v2 source UI batches inventory hosts and edits device policy without posting until shared save', async t => {
  const f = await fixture(t); await mount(t, f); await clickButton('从清单批量添加');
  await act(async () => document.querySelector('[aria-label="选择主机 tower-host-1"]').click()); await clickButton('将 1 台主机加入草稿');
  const added = f.store.getDraft().hosts.find(row => row.hostId === 'tower-host-1'); assert.ok(added); assert.equal(added.hostKeySha256, ''); assert.equal(added.connection, null); assert.deepEqual(added.devicePolicy, defaultDevicePolicy());
  assert.equal(document.querySelector('[role=dialog]'), null); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  await clickButton('刷新磁盘清单');
  await act(async () => document.querySelector('[aria-label="选择磁盘 example-disk-2"]').click());
  assert.deepEqual(f.store.getDraft().hosts[0].devicePolicy.classes.disk.ids, ['example-disk', 'example-disk-2']);
  assert.match(document.body.textContent, /分类设备策略的执行能力尚未就绪/);
});

test('v2 rejects a v1 backend response instead of silently posting incompatible fields', async t => {
  const calls = [], store = createSshConnectionsStore({ crypto: { randomUUID }, client: async (route, method = 'GET') => { calls.push(method); return { version: 1 }; } });
  t.after(() => store.dispose()); await store.load(); assert.equal(store.status().loaded, false); assert.equal(store.status().error, 'SSH_CONNECTION_VERSION_UNSUPPORTED');
  assert.equal(await store.save(), false); assert.deepEqual(calls, ['GET']);
});

test('v2 verified historical receipt accepts the newer snapshot with an explicit newer-revision notice', async t => {
  const f = await fixture(t), initial = await f.summary();
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async (route, method, body) => method === 'PUT' ? { version: 2, operationId: body.operationId, committedRevision: initial.revision + 1, replayed: true, connections: { ...initial, revision: initial.revision + 2, operationId: randomUUID() } } : initial });
  t.after(() => store.dispose()); await store.load(); replace(store); assert.equal(await store.save(), true);
  assert.equal(store.status().revision, initial.revision + 2); assert.equal(store.status().notice, 'SSH_CONNECTION_NEWER_REVISION'); assert.equal(store.status().dirty, false);
});

test('v2 host changes abort disk inventory and late responses cannot select devices on another host', async t => {
  const f = await fixture(t); let release; const waiting = new Promise(resolve => { release = resolve; }); f.failures.disks = () => waiting;
  const ui = await mount(t, f); await clickButton('刷新磁盘清单');
  const call = f.calls.find(row => row.route.startsWith('/ssh-channel/device-inventory?'));
  await ui.change(document.querySelector('select[aria-label="选择主机"]'), 'tower-host-1'); assert.equal(call.signal.aborted, true);
  await act(async () => { release(diskInventory('example-host')); await new Promise(setImmediate); });
  assert.deepEqual(f.store.getDraft().hosts[0].devicePolicy, defaultDevicePolicy()); assert.equal(document.querySelector('[aria-label="选择磁盘 example-disk-2"]'), null);
  assert.equal(f.calls.filter(row => row.method === 'PUT').length, 0);
});

test('v2 incomplete or wrong-host inventories render generic failure without importing partial entries', async t => {
  const f = await fixture(t); f.failures.disks = () => ({ ...diskInventory('example-host'), complete: false });
  const ui = await mount(t, f); const before = f.store.getDraft(); await clickButton('刷新磁盘清单');
  assert.match(document.body.textContent, /磁盘清单不可用或已过期/); assert.deepEqual(f.store.getDraft(), before); assert.equal(document.querySelector('[aria-label="选择磁盘 example-disk-2"]'), null);
  f.failures.disks = () => { throw new Error('EXAMPLE_PRIVATE_STACK_OR_TOKEN'); }; await clickButton('刷新磁盘清单');
  await ui.render('en-US'); assert.match(document.body.textContent, /Disk inventory is unavailable or expired/); assert.doesNotMatch(document.body.textContent, /EXAMPLE_PRIVATE_STACK_OR_TOKEN/);
});

test('v2 inconsistent capability claims cannot enable custom selection or suggest execution readiness', async t => {
  const f = await fixture(t), value = await f.client('/ssh-channel/policy-capabilities');
  f.failures.capabilities = { ...value, execution: { manual: true, scheduled: true, reason: 'SSH_POLICY_RESOLVER_UNAVAILABLE' } };
  await mount(t, f); assert.match(document.body.textContent, /分类设备策略的执行能力尚未就绪/);
  for (const row of document.querySelectorAll('.pk-ssh-scope-option')) assert.equal(row.querySelectorAll('input')[1].disabled, true);
  assert.equal([...document.querySelectorAll('button')].find(row => row.textContent === '刷新磁盘清单').disabled, true);
});
