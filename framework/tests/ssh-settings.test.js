import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createSshSettings } from '../src/ssh-settings.js';
const { act } = testUtils;
const id = 'rivetin-example', sha = 'a'.repeat(64);
function snapshot(overrides = {}) {
  return { enabled: true, transportReady: true,
    hosts: [{ hostId: 'example-host', clusterId: 'example-cluster', address: '192.0.2.10', username: 'example-reader', hostKeySha256: 'SHA256:EXAMPLE_HOST_KEY', credentialConfigured: true }],
    registrations: [{ pluginId: id, pluginName: { 'zh-CN': '示例采集', 'en-US': 'Example collection' }, packageId: 'b'.repeat(64), digest: sha, approved: false,
      commands: [{ id: 'host-identity', operation: 'host.identity', purpose: { 'zh-CN': '读取主机身份', 'en-US': 'Read host identity' }, hostIds: ['example-host'], intervalSeconds: 86400, preview: ['/usr/bin/uname -srm'], risk: 'read-only' }] }], recentRuns: [], ...overrides };
}
async function mount(t, { state = snapshot(), locale = 'zh-CN', handle } = {}) {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const calls = []; let approved = false;
  const client = async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (handle) { const result = await handle(route, method, body); if (result !== undefined) return result; }
    if (method === 'GET') return { ...structuredClone(state), registrations: state.registrations.map(item => ({ ...structuredClone(item), approved })) };
    if (body.action === 'review') return { challenge: 'example-challenge', digest: sha, expiresAt: Date.now() + 120000, registration: structuredClone(state.registrations[0]) };
    if (body.action === 'approve') { approved = true; return { approved: true }; }
    if (body.action === 'revoke') { approved = false; return { approved: false }; }
    throw new Error('UNEXPECTED_REQUEST');
  };
  const Settings = createSshSettings(React), root = document.getElementById('root');
  const render = async value => act(async () => { ReactDOM.render(React.createElement(Settings, { client, locale: value }), root); await new Promise(setImmediate); });
  await render(locale);
  const click = async text => act(async () => { const button = [...document.querySelectorAll('button')].find(item => item.textContent === text); assert.ok(button, text); button.click(); await new Promise(setImmediate); });
  t.after(async () => { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; });
  return { calls, click, state, render, root };
}

test('disabled audit page lists registered commands but cannot approve or execute', async t => {
  const { calls } = await mount(t, { state: snapshot({ enabled: false }) });
  assert.match(document.body.textContent, /通道未启用/);
  assert.match(document.body.textContent, /\/usr\/bin\/uname -srm/);
  assert.equal([...document.querySelectorAll('button')].find(item => item.textContent === '审核并启用').disabled, true);
  assert.equal(document.querySelectorAll('input[type="password"],textarea').length, 0);
  assert.deepEqual(calls.map(item => item.method), ['GET']);
  document.querySelector('.pk-ssh-risk-examples').open = true;
  assert.match(document.querySelector('.pk-ssh-risk-examples').textContent, /删除系统和业务数据/);
  assert.match(document.querySelector('.pk-ssh-risk-examples').textContent, /未知操作一律拒绝/);
});

test('review discloses target and schedule, requires explicit acknowledgment, then reads approval back; revoke is independent', async t => {
  const { calls, click } = await mount(t);
  await click('审核并启用');
  const dialog = document.querySelector('[role="alertdialog"]');
  assert.match(dialog.textContent, /example-host/); assert.match(dialog.textContent, /每天一次/); assert.match(dialog.textContent, /uname/);
  assert.equal(dialog.querySelector('.pk-ssh-confirm').disabled, true);
  assert.equal(calls.filter(item => item.body?.action === 'approve').length, 0);
  await act(async () => dialog.querySelector('input').click());
  await click('确认启用');
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.match(document.body.textContent, /已授权/);
  assert.deepEqual(calls.find(item => item.body?.action === 'approve').body, { action: 'approve', pluginId: id, challenge: 'example-challenge', digest: sha, acknowledged: true });
  await click('关闭 SSH 权限'); assert.match(document.body.textContent, /SSH 权限关闭/);
  assert.equal(calls.filter(item => item.body?.action === 'revoke').length, 1);
  assert.ok(!calls.some(item => item.body?.action === 'run'));
});

test('failed approval remains unapproved and server diagnostic bodies are not rendered', async t => {
  const { click } = await mount(t, { handle: async (route, method, body) => {
    if (body?.action === 'approve') throw new Error('example-secret-value at /private/runtime/file');
  } });
  await click('审核并启用');
  await act(async () => document.querySelector('[role="alertdialog"] input').click());
  await click('确认启用');
  assert.ok(document.querySelector('[role="alertdialog"]'));
  assert.match(document.querySelector('[role="alert"]').textContent, /SSH_REQUEST_FAILED/);
  assert.doesNotMatch(document.body.textContent, /example-secret-value|\/private\/runtime/);
  assert.equal(document.querySelectorAll('.pk-ssh-approved').length, 0);
});

test('review rejects inconsistent digests and expired challenges without sending approval', async t => {
  let expires = false;
  const { calls, click } = await mount(t, { handle: async (route, method, body) => {
    if (body?.action === 'review') return { challenge: 'example-challenge', digest: expires ? sha : 'c'.repeat(64), expiresAt: expires ? Date.now() - 1 : Date.now() + 120000, registration: snapshot().registrations[0] };
  } });
  await click('审核并启用'); assert.match(document.body.textContent, /SSH_REVIEW_INVALID/); assert.equal(document.querySelector('[role="alertdialog"]'), null);
  expires = true; await click('审核并启用'); assert.match(document.body.textContent, /SSH_REVIEW_INVALID/);
  assert.ok(!calls.some(item => item.body?.action === 'approve'));
});

test('unknown operations block approval', async t => {
  const state = snapshot(); state.registrations[0].commands[0].operation = 'shell.exec';
  await mount(t, { state });
  assert.equal([...document.querySelectorAll('button')].find(item => item.textContent === '审核并启用').disabled, true);
});

test('partial target resolution blocks approval even when some command previews exist', async t => {
  const state = snapshot(); state.registrations[0].commands[0].missingHosts = ['unconfigured-example-host'];
  await mount(t, { state });
  assert.equal([...document.querySelectorAll('button')].find(item => item.textContent === '审核并启用').disabled, true);
  assert.match(document.body.textContent, /部分目标缺少可信连接或设备映射/);
});

test('configured hosts from the broker render correctly while transport readiness is required', async t => {
  const state = snapshot({ transportReady: false });
  state.hosts[0].authType = 'private-key'; delete state.hosts[0].credentialConfigured;
  state.registrations[0].name = state.registrations[0].pluginName; delete state.registrations[0].pluginName;
  await mount(t, { state });
  assert.match(document.body.textContent, /示例采集/); assert.match(document.body.textContent, /已配置/);
  assert.match(document.body.textContent, /传输尚未就绪/);
  assert.equal([...document.querySelectorAll('button')].find(item => item.textContent === '审核并启用').disabled, true);
});

test('a challenge that expires after review cannot send an approval', async t => {
  const { calls, click } = await mount(t);
  await click('审核并启用');
  await act(async () => document.querySelector('[role="alertdialog"] input').click());
  const original = Date.now;
  try {
    const later = original() + 180000; Date.now = () => later;
    await click('确认启用');
  } finally { Date.now = original; }
  assert.match(document.body.textContent, /SSH_REVIEW_EXPIRED/);
  assert.ok(!calls.some(item => item.body?.action === 'approve'));
  assert.ok(document.querySelector('[role="alertdialog"]'));
});

test('language follows the host prop and untrusted registration strings remain plain text', async t => {
  const state = snapshot(); state.registrations[0].pluginName['en-US'] = '<img src=x onerror=alert(1)>';
  const { render } = await mount(t, { state });
  await render('en-US');
  assert.match(document.body.textContent, /SSH channel|Review and enable/);
  assert.match(document.body.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
});

test('dotted and hyphenated command identifiers supported by policy can be reviewed and approved', async t => {
  const state = snapshot();
  state.registrations[0].commands[0].id = 'read.host-identity';
  const { click } = await mount(t, { state });
  await click('审核并启用');
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /read.host-identity/);
  await act(async () => document.querySelector('[role="alertdialog"] input').click());
  await click('确认启用');
  assert.match(document.body.textContent, /已授权/);
});

test('review dialog owns Tab and Escape instead of triggering the parent hub keyboard handler', async t => {
  const { click } = await mount(t);
  await click('审核并启用');
  const dialog = document.querySelector('[role="alertdialog"]'), confirm = dialog.querySelector('.pk-ssh-confirm'), ack = dialog.querySelector('input');
  let escaped = 0, trappedByParent = 0;
  const parent = event => { if (event.key === 'Escape') escaped++; if (event.key === 'Tab') trappedByParent++; };
  document.addEventListener('keydown', parent);
  try {
    await act(async () => ack.click());
    confirm.focus();
    await act(async () => confirm.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    assert.equal(document.activeElement, ack); assert.equal(trappedByParent, 0);
    await act(async () => ack.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    assert.equal(document.activeElement, confirm); assert.equal(trappedByParent, 0);
    await act(async () => confirm.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('[role="alertdialog"]'), null); assert.equal(escaped, 0);
  } finally { document.removeEventListener('keydown', parent); }
});

test('configured host and device scopes disclose complete resolved targets in cards and the review dialog', async t => {
  const state = snapshot(), command = state.registrations[0].commands[0];
  Object.assign(command, { id: 'read.smart', operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured', hostIds: ['example-host-1', 'example-host-2'], deviceIds: ['example-disk-1', 'example-disk-2'], preview: ['example-host-1/example-disk-1: sudo -n -- /usr/sbin/smartctl --json=c --all /dev/sda', 'example-host-2/example-disk-2: sudo -n -- /usr/sbin/smartctl --json=c --all /dev/nvme0n1'] });
  const { click, render } = await mount(t, { state });
  const card = document.querySelector('.pk-ssh-card');
  for (const value of ['所有已配置主机', '所有已配置设备', 'example-host-1', 'example-host-2', 'example-disk-1', 'example-disk-2', '/dev/sda', '/dev/nvme0n1']) assert.ok(card.textContent.includes(value), value);
  await click('审核并启用');
  const dialog = document.querySelector('[role="alertdialog"]');
  for (const value of ['所有已配置主机', '所有已配置设备', 'example-host-1', 'example-host-2', 'example-disk-1', 'example-disk-2', '需重新审核并确认']) assert.ok(dialog.textContent.includes(value), value);
  await render('en-US');
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /All configured hosts/);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /All configured devices/);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /requires a new review and confirmation/);
});

test('target-limit and unavailable registration reasons block approval even with complete-looking previews', async t => {
  const state = snapshot();
  state.registrations[0].reason = 'SSH_TARGET_LIMIT';
  state.registrations.push({ ...structuredClone(state.registrations[0]), pluginId: 'rivetin-unavailable', reason: 'SSH_TARGET_UNAVAILABLE' });
  const { calls } = await mount(t, { state });
  const buttons = [...document.querySelectorAll('button')].filter(button => button.textContent === '审核并启用');
  assert.equal(buttons.length, 2); assert.ok(buttons.every(button => button.disabled));
  assert.match(document.body.textContent, /SSH_TARGET_LIMIT/); assert.match(document.body.textContent, /SSH_TARGET_UNAVAILABLE/);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});

const executionCases = [
  { result: 'failed', code: 'SSH_REMOTE_COMMAND_FAILED', zh: /SSH 认证已完成 · 远程命令失败/, en: /SSH authenticated · Remote command failed/, health: /不能据此判定磁盘损坏/, healthEn: /does not establish disk damage/ },
  { result: 'failed', code: 'SSH_AUTHENTICATION_FAILED', zh: /SSH 认证失败/, en: /SSH authentication failed/ },
  { result: 'failed', code: 'SSH_HOST_KEY_MISMATCH', zh: /主机指纹不匹配/, en: /Host key mismatch/ },
  { result: 'failed', code: 'SSH_CONNECTION_FAILED', zh: /执行结果未完成或待确认/, en: /Execution incomplete or unconfirmed/ },
  { result: 'failed', code: 'SSH_EXECUTION_TIMEOUT', zh: /执行结果未完成或待确认/, en: /Execution incomplete or unconfirmed/ },
  { result: 'success', zh: /远程命令已完成/, en: /Remote command completed/, health: /命令完成不等于磁盘健康/, healthEn: /Command completion does not establish disk health/ },
  { code: 'SSH_REMOTE_COMMAND_FAILED', zh: /执行结果未完成或待确认/, en: /Execution incomplete or unconfirmed/ },
  { result: 'success', code: 'SSH_REMOTE_COMMAND_FAILED', zh: /执行结果未完成或待确认/, en: /Execution incomplete or unconfirmed/ },
];
for (const [index, item] of executionCases.entries()) test(`execution stage ${index + 1} distinguishes authentication, command outcome and health in both languages without requests`, async t => {
  const { calls, render } = await mount(t, { state: snapshot({ recentRuns: [{ id: 'example-run', pluginId: id, commandId: 'read.smart', finishedAt: '2026-01-01T00:00:00.000Z', result: item.result, code: item.code }] }) });
  const result = () => document.querySelector('.pk-ssh-run-result');
  assert.match(result().textContent, item.zh);
  if (item.health) assert.match(result().textContent, item.health);
  else assert.match(result().textContent, /设备健康/);
  if (index !== 0) assert.doesNotMatch(result().textContent, /SSH 认证已完成/);
  assert.equal(result().querySelector('code').textContent, item.code || item.result);
  assert.equal(document.querySelector('.pk-ssh-verified'), null);
  await render('en-US'); assert.match(result().textContent, item.en);
  if (item.healthEn) assert.match(result().textContent, item.healthEn);
  else assert.match(result().textContent, /device health/);
  if (index !== 0) assert.doesNotMatch(result().textContent, /SSH authenticated/);
  assert.deepEqual(calls.map(call => [call.route, call.method]), [['/ssh-channel', 'GET']]);
});
