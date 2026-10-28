import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createFrameworkHub } from '../src/hub.js';
const { act, Simulate } = testUtils;

for (const unknownOutcome of [false, true]) test(`emergency disable bypasses a ${unknownOutcome ? 'save-unknown' : 'dirty'} SSH credential draft without saving or discarding it`, async () => {
  const dom = new JSDOM('<html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'https://tower.example.invalid', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  let enabled = true; const calls = [], id = 'rivetin-ssh-channel';
  const client = async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (route === '/runtime') return { enabled, version: '0.1.0' };
    if (route === '/plugins') return { items: [{ id, installed: true, enabled: false, active: false, version: '0.1.0', manifest: { name: { 'zh-CN': 'SSH 通道', 'en-US': 'SSH channel' }, description: { 'zh-CN': '测试通道', 'en-US': 'Example channel' }, permissions: [] } }], packages: [] };
    if (route === '/ssh-channel') return { enabled: false, transportReady: true, hosts: [], registrations: [], recentRuns: [] };
    if (route === '/ssh-channel/inventory') return { clusters: [], hosts: [] };
    if (route === '/ssh-channel/connections') {
      if (method === 'PUT') throw new Error('EXAMPLE_LOCAL_RESPONSE_LOST');
      return { version: 2, revision: 0, updatedAt: null, operationId: null, global: null, clusters: [], hosts: [], migration: { persistedVersion: 2, required: false, state: 'ready' } };
    }
    if (route === '/ssh-channel/policy-capabilities') return { version: 1, connectionsVersion: 2, maxTargets: 100, classes: Object.fromEntries(['disk', 'gpu', 'usb', 'pcie'].map(category => [category, { inventory: false, custom: false, operations: [] }])), execution: { manual: false, scheduled: false, reason: 'SSH_POLICY_RESOLVER_UNAVAILABLE' } };
    if (route === '/updates/status') return { reachable: false };
    if (route === '/disable') { enabled = false; return { enabled: false }; }
    return { items: [], next: null };
  };
  const root = document.getElementById('root'), Hub = createFrameworkHub({ client, initialTab: id });
  const settle = () => new Promise(setImmediate);
  async function click(selector) { await act(async () => { const element = document.querySelector(selector); assert.ok(element, selector); element.click(); await settle(); }); }
  try {
    await act(async () => { ReactDOM.render(React.createElement(Hub), root); await settle(); });
    await click('.c89-plugin-fab');
    const label = [...document.querySelectorAll('label')].find(node => node.textContent.includes('配置全局凭据'));
    assert.ok(label);
    await act(async () => { Simulate.change(label.querySelector('input'), { target: { checked: true } }); await settle(); });
    const credentialAction = [...document.querySelectorAll('label')].find(node => node.textContent.includes('凭据操作'));
    await act(async () => { Simulate.change(credentialAction.querySelector('select'), { target: { value: 'replace' } }); await settle(); });
    const password = document.querySelector('input[type="password"]'); assert.ok(password);
    await act(async () => { Simulate.change(password, { target: { value: 'EXAMPLE_NOT_A_REAL_DRAFT_SECRET' } }); await settle(); });
    if (unknownOutcome) {
      await click('.c89-done');
      assert.match(document.body.textContent, /SSH_CONNECTION_OUTCOME_UNKNOWN/);
      assert.equal(document.querySelector('fieldset.pk-ssh-draft').disabled, true);
    }
    await click('[data-pk-tab="center"]'); await click('.pk-emergency');
    assert.ok(document.querySelector('[role="alertdialog"]'));
    await click('.c89-confirm-actions .c89-discard-exit');
    assert.equal(enabled, false); assert.equal(calls.filter(call => call.route === '/disable').length, 1);
    assert.equal(calls.filter(call => call.method === 'PUT').length, unknownOutcome ? 1 : 0);
    const sshTab = [...document.querySelectorAll('nav button')].find(node => node.textContent === 'SSH 通道');
    await act(async () => { sshTab.click(); await settle(); });
    assert.equal(document.querySelector('input[type="password"]').value, 'EXAMPLE_NOT_A_REAL_DRAFT_SECRET');
    if (unknownOutcome) assert.equal(document.querySelector('fieldset.pk-ssh-draft').disabled, true);
    await click('.c89-finish'); assert.match(document.querySelector('[role="alertdialog"]').textContent, /未保存/);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); delete globalThis.window; delete globalThis.document; }
});
