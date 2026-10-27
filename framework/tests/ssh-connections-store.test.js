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
const { act } = testUtils;
async function fixture(t) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'ssh-connection-store-'));
  const vault = createSshVault(root);
  await vault.saveConnections({ version: 1, operationId: randomUUID(), global: { username: 'example-reader', authType: 'password', password: { action: 'replace', value: 'EXAMPLE_SAVED_PASSWORD' }, privateKey: { action: 'keep' } }, clusters: [],
    hosts: [{ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', port: 22, hostKeySha256: 'a'.repeat(64), devices: [{ deviceId: 'example-disk', path: '/dev/sda', serial: 'EXAMPLE_SERIAL' }], connection: null }] });
  const failures = { load: false, put: '', inventory: false, malformed: false }, calls = [];
  const client = async (route, method = 'GET', body) => {
    calls.push({ route, method, body: body === undefined ? undefined : structuredClone(body) });
    if (route === '/ssh-channel/inventory') {
      if (failures.inventory) throw new Error('EXAMPLE_PRIVATE_INVENTORY_ERROR');
      return { clusters: [{ id: 'tower-cluster-1', name: 'Example cluster' }], hosts: [{ id: 'tower-host-1', name: 'Example host', clusterId: 'tower-cluster-1', address: '192.0.2.20' }] };
    }
    assert.equal(route, '/ssh-channel/connections');
    if (method === 'GET') {
      if (failures.load) throw new Error('EXAMPLE_PRIVATE_LOAD_ERROR');
      const value = await vault.connections(); if (failures.malformed) value.global.password = 'EXAMPLE_FORBIDDEN_RESPONSE_SECRET'; return value;
    }
    if (failures.put === 'before') throw new Error('EXAMPLE_PRIVATE_PUT_ERROR');
    const value = await vault.saveConnections(body);
    if (failures.put === 'after') throw new Error('EXAMPLE_PRIVATE_RESPONSE_LOST');
    return value;
  };
  const store = createSshConnectionsStore({ client, crypto: { randomUUID } }); await store.load();
  t.after(async () => { store.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { store, vault, client, calls, failures };
}
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
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1); assert.equal(f.store.status().error, 'SSH_CONNECTION_SAVE_NOT_CONFIRMED');
  f.failures.load = true; await f.store.load(); assert.equal(f.store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD');
  assert.doesNotMatch(f.store.status().error, /EXAMPLE_PRIVATE/);
  f.failures.load = false; f.failures.put = ''; assert.equal(await f.store.save(), true);
  const writes = f.calls.filter(call => call.method === 'PUT'); assert.equal(writes[0].body.operationId, writes[1].body.operationId);
});

test('SSH a secret-bearing server summary is rejected and disposal clears pending secret memory', async t => {
  const f = await fixture(t); f.failures.malformed = true; await f.store.load();
  assert.equal(f.store.status().error, 'SSH_CONNECTION_RESPONSE_INVALID'); assert.doesNotMatch(JSON.stringify(f.store.get()), /EXAMPLE_FORBIDDEN_RESPONSE_SECRET/);
  replace(f.store); f.store.dispose(); assert.doesNotMatch(JSON.stringify({ saved: f.store.get(), draft: f.store.getDraft() }), /EXAMPLE_(SAVED|NEW)_PASSWORD/);
});

test('SSH a slow GET cannot roll back the baseline after a newer PUT succeeds', async t => {
  const f = await fixture(t), old = await f.vault.connections(); let reads = 0, release;
  const slow = new Promise(resolve => { release = resolve; });
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async (route, method, body) => {
    if (method === 'PUT') return f.vault.saveConnections(body);
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
  const f = await fixture(t), original = await f.vault.connections(); let reads = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const store = createSshConnectionsStore({ crypto: { randomUUID }, client: async () => ++reads === 1 ? original : waiting });
  t.after(() => store.dispose()); await store.load(); const loading = store.load(); replace(store);
  release({ ...original, revision: original.revision + 1, global: { ...original.global, username: 'different-reader' } }); await loading;
  assert.equal(store.get().global.username, original.global.username); assert.equal(store.getDraft().global.password.value, 'EXAMPLE_NEW_PASSWORD'); assert.equal(store.status().dirty, true);
});

async function mount(t, f, locale = 'zh-CN') {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://tower.example.invalid' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = document.getElementById('root'), Settings = createSshConnectionSettings(React);
  const render = async value => act(async () => { ReactDOM.render(React.createElement(Settings, { store: f.store, client: f.client, locale: value }), root); await new Promise(setImmediate); });
  await render(locale);
  t.after(async () => { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; });
  const label = text => [...document.querySelectorAll('label')].find(row => row.querySelector('span')?.textContent === text);
  const change = async (element, value) => act(async () => { testUtils.Simulate.change(element, { target: { value } }); await new Promise(setImmediate); });
  return { render, label, change };
}

test('SSH inventory names and existing aliases coexist; choosing a different host clears its pin and devices only in the draft', async t => {
  const f = await fixture(t), ui = await mount(t, f);
  assert.match(document.body.textContent, /Example host \(tower-host-1\)/); assert.match(document.body.textContent, /已配置映射：example-host/);
  await ui.change(ui.label('选择主机').querySelector('select'), 'tower-host-1');
  const row = f.store.getDraft().hosts[0]; assert.equal(row.hostId, 'tower-host-1'); assert.equal(row.clusterId, 'tower-cluster-1'); assert.equal(row.address, '192.0.2.20');
  assert.equal(row.hostKeySha256, ''); assert.deepEqual(row.devices, []); assert.equal(row.connection, null);
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
