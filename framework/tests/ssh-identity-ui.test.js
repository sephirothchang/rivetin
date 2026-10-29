import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import utils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { createSshIdentitySettings } from '../src/ssh-identity.js';
const { act, Simulate } = utils;

async function fixture(t, loseResponse = false) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://tower.example.invalid' }); globalThis.window = dom.window; globalThis.document = dom.window.document;
  const calls = [], approvalId = randomUUID(), stamp = new Date(Date.now() + 120000).toISOString(); let requestId;
  const client = async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (route === '/ssh-channel/identity' && method === 'GET') return { items: [] };
    if (route.includes('?requestId=')) return { requestId: route.split('=')[1], hostId: 'EXAMPLE_HOST', status: 'success', identity: { system: 'Linux', release: '6.1', architecture: 'x86_64' } };
    if (body.action === 'review') return { kind: 'builtin-host-identity', operation: 'host.identity', command: '/usr/bin/uname -srm', hostId: body.hostId, target: { address: '192.0.2.10', port: 22 }, digest: 'a'.repeat(64), challenge: 'b'.repeat(64), expiresAt: stamp };
    if (body.action === 'approve') return { approvalId, digest: body.digest, hostId: 'EXAMPLE_HOST', expiresAt: stamp };
    if (body.action === 'execute') { requestId = body.requestId; if (loseResponse) throw new Error('SSH_IDENTITY_OUTCOME_UNKNOWN'); return { requestId, hostId: body.hostId, status: 'success', identity: { system: 'Linux', release: '6.1', architecture: 'x86_64' } }; }
    throw new Error('UNEXPECTED_REQUEST');
  };
  const Settings = createSshIdentitySettings(React), root = document.getElementById('root');
  await act(async () => ReactDOM.render(React.createElement(Settings, { client, hosts: [{ hostId: 'EXAMPLE_HOST' }, { hostId: 'SECOND_HOST' }], enabled: true, locale: 'zh-CN' }), root));
  t.after(async () => { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; });
  const button = text => [...root.querySelectorAll('button')].find(row => row.textContent === text);
  const click = async text => { await act(async () => { button(text).click(); await new Promise(setImmediate); }); };
  return { root, calls, button, click, async select(value) { await act(async () => Simulate.change(root.querySelector('select'), { target: { value } })); } };
}
test('diagnostic requires single-host review, a separate acknowledgement and execute click; it never automatically runs', async t => {
  const f = await fixture(t); assert.equal(f.calls.length, 0);
  await f.select('EXAMPLE_HOST'); await f.click('审核身份命令'); assert.equal(f.calls.length, 1);
  assert.equal(f.button('批准一次身份查询').disabled, true); assert.equal(f.button('执行一次身份查询'), undefined);
  await act(async () => Simulate.change(f.root.querySelector('input[type=checkbox]'), { target: { checked: true } }));
  await f.click('批准一次身份查询'); assert.equal(f.calls.length, 2);
  await f.click('执行一次身份查询'); assert.equal(f.calls.length, 3); assert.match(f.root.textContent, /Linux 6.1 x86_64/);
  assert.equal(f.button('执行一次身份查询').disabled, true); assert.ok(f.calls.every(row => row.body?.hostId === undefined || row.body.hostId === 'EXAMPLE_HOST'));
});
test('a lost execute response exposes only original-result reads and cannot repeat execution', async t => {
  const f = await fixture(t, true); await f.select('EXAMPLE_HOST'); await f.click('审核身份命令');
  await act(async () => Simulate.change(f.root.querySelector('input'), { target: { checked: true } })); await f.click('批准一次身份查询'); await f.click('执行一次身份查询');
  assert.equal(f.button('执行一次身份查询').disabled, true); await f.click('查询原执行结果（不重试）');
  assert.equal(f.calls.filter(row => row.body?.action === 'execute').length, 1); assert.equal(f.calls.at(-1).method, 'GET');
});
