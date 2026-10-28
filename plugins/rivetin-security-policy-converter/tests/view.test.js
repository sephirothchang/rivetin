import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import factory from '../src/definition.js';
import { configuration } from '../src/configuration.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const { JSDOM } = require('jsdom'), React = require('react');
// Load React's scheduler in Node mode before introducing a jsdom window.
const ReactDOM = require('react-dom'), { act, Simulate } = require('react-dom/test-utils');

async function setup(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const win = dom.window; global.window = win; global.document = win.document;
  win.requestAnimationFrame = callback => win.setTimeout(callback, 0); win.cancelAnimationFrame = id => win.clearTimeout(id);
  let stored = { revision: 0, updatedAt: null, settings: configuration.defaults() }, writes = 0, network = 0, blob, revoked = '';
  win.fetch = () => { network++; throw new Error('NETWORK_FORBIDDEN_IN_TEST'); };
  win.URL.createObjectURL = value => { blob = value; return 'blob:review-test'; };
  win.URL.revokeObjectURL = value => { revoked = value; };
  win.HTMLAnchorElement.prototype.click = function () { assert.equal(this.download, 'security-policy-review.json'); };
  const backend = { load: async () => structuredClone(stored), save: async settings => { writes++; stored = { revision: stored.revision + 1, updatedAt: null, settings }; return structuredClone(stored); } };
  const plugin = factory({ React, win, options: { configurationBackend: () => backend } });
  await plugin.store.load(); let stop = plugin.activate();
  const root = win.document.querySelector('#root'); let locale = 'zh-CN';
  const render = () => act(() => { ReactDOM.render(React.createElement(plugin.Settings, { preferences: plugin.store.getDraft(), locale }), root); });
  const unsubscribe = plugin.store.subscribe(render); render();
  const click = selector => { const el = root.querySelector(selector); assert.ok(el, selector); act(() => el.click()); };
  const change = (selector, value) => { const el = root.querySelector(selector); assert.ok(el, selector); act(() => Simulate.change(el, { target: { value } })); };
  t.after(() => { unsubscribe(); stop(); act(() => { ReactDOM.unmountComponentAtNode(root); }); plugin.store.dispose(); win.close(); });
  return { root, win, plugin, click, change, act, render, ReactDOM,
    async file(index, file) { await act(async () => { Simulate.change(root.querySelectorAll('input[type="file"]')[index], { target: { files: [file], value: 'mock-file' } }); }); },
    language(value) { locale = value; render(); },
    unmount() { act(() => { ReactDOM.unmountComponentAtNode(root); }); },
    restart() { act(() => stop()); stop = plugin.activate(); render(); },
    stats: () => ({ writes, network, blob, revoked }) };
}
test('real plugin Settings generates candidates, requires acknowledgement and downloads only a review JSON', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  assert.match(c.root.querySelector('[data-summary]').textContent, /3 个候选策略，4 条规则/);
  assert.equal(c.root.querySelector('[data-action="export"]').disabled, true);
  c.click('[data-action="review"]'); c.click('[data-action="export"]');
  const stats = c.stats(); assert.ok(stats.blob); assert.equal(stats.revoked, 'blob:review-test');
  const text = await new Promise((resolve, reject) => { const reader = new c.win.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(stats.blob); });
  const result = JSON.parse(text); assert.equal(result.format, 'rivetin-policy-review-v1'); assert.equal(result.pluginId, 'rivetin-security-policy-converter'); assert.equal(result.canDeploy, false); assert.equal(result.policies.length, 3);
  assert.equal(stats.network, 0); assert.equal(stats.writes, 0); assert.equal(c.win.localStorage.length, 0);
});
test('input edit removes previous output and invalid flows disable review and export', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]'); c.click('[data-action="review"]');
  c.change('[data-field="externalText"]', ''); assert.equal(c.root.querySelector('[data-summary]'), null);
  c.click('[data-action="convert"]'); assert.equal(c.root.querySelector('[data-action="review"]').disabled, true); assert.equal(c.root.querySelector('[data-action="export"]').disabled, true);
  assert.match(c.root.textContent, /2 个阻断项/);
});
test('locale switches host-provided copy without losing in-memory review or persisting language', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]'); c.language('en-US');
  assert.match(c.root.textContent, /3 candidate policies, 4 rules/); assert.match(c.root.textContent, /Offline preview/); assert.equal(c.win.localStorage.length, 0);
});
test('draft label configuration does not affect conversion until explicit shared save', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  c.change('input[type="text"]', 'service'); assert.equal(c.plugin.store.status().dirty, true);
  assert.equal(c.plugin.store.get().labelKey, 'application'); assert.ok(c.root.querySelector('[data-summary]'));
  await c.act(async () => { assert.equal(await c.plugin.store.save(), true); });
  assert.equal(c.plugin.store.get().labelKey, 'service'); assert.equal(c.root.querySelector('[data-summary]'), null); assert.equal(c.stats().writes, 1);
});
test('stop, reactivation and Settings unmount cannot retain data or restore old acknowledgement', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]'); c.restart();
  assert.equal(c.root.querySelector('[data-field="inventoryText"]').value, '');
  c.click('[data-action="sample"]'); c.unmount(); c.render();
  assert.equal(c.root.querySelector('[data-field="trafficText"]').value, ''); assert.equal(c.root.querySelector('[data-summary]'), null);
});
test('untrusted labels are rendered as text and never create executable markup', async t => {
  const c = await setup(t); c.click('[data-action="sample"]');
  const values = JSON.parse(c.root.querySelector('[data-field="inventoryText"]').value);
  values[0].labels[0].value = '<img src=x onerror=alert(1)>';
  c.change('[data-field="inventoryText"]', JSON.stringify(values)); c.click('[data-action="convert"]');
  assert.ok(c.root.textContent.includes('<img src=x onerror=alert(1)>')); assert.equal(c.root.querySelector('img'), null); assert.equal(c.stats().network, 0);
});
test('file import uses the same conversion model, clears old review and refuses oversized files', async t => {
  const c = await setup(t); c.click('[data-action="sample"]'); c.click('[data-action="convert"]');
  await c.file(1, { size: 85, text: async () => 'src_ip,dst_ip,dst_port,protocol\n192.0.2.10,192.0.2.20,5432,TCP' });
  assert.equal(c.root.querySelector('[data-summary]'), null); c.click('[data-action="convert"]'); assert.match(c.root.textContent, /2 个候选策略，2 条规则/);
  await c.file(0, { size: 3 * 1024 * 1024, text: async () => { throw new Error('must not read oversized file'); } });
  assert.match(c.root.querySelector('[role="alert"]').textContent, /文件过大/); assert.equal(c.root.querySelector('[data-summary]'), null);
});
test('every candidate beyond the first 100 is accessible through pagination and a new run resets page', async t => {
  const c = await setup(t), values = [], rows = ['src_ip,dst_ip,dst_port,protocol'];
  for (let i = 1; i <= 101; i++) {
    values.push({ id: `vm-${i}`, name: `demo-${i}`, clusterId: 'demo-cluster', ips: [`192.0.2.${i}`], labels: [{ key: 'application', value: `app-${i}` }] });
    rows.push(`198.51.100.5,192.0.2.${i},443,TCP`);
  }
  c.change('[data-field="inventoryText"]', JSON.stringify(values)); c.change('[data-field="trafficText"]', rows.join('\n'));
  c.change('[data-field="clusterId"]', 'demo-cluster'); c.change('[data-field="externalText"]', '198.51.100.5'); c.click('[data-action="convert"]');
  assert.equal(c.root.querySelectorAll('tbody tr').length, 100); c.click('[data-action="next-page"]'); assert.equal(c.root.querySelectorAll('tbody tr').length, 1);
  c.click('[data-action="convert"]'); assert.equal(c.root.querySelectorAll('tbody tr').length, 100);
});
test('Rivetin HTTP configuration uses only the new endpoint and collection ID', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const calls = [], id = 'rivetin-security-policy-converter'; let settings = configuration.defaults();
  dom.window.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (options.method === 'PUT') settings = JSON.parse(options.body).settings;
    return { ok: true, json: async () => ({ version: 1, plugins: { [id]: { revision: calls.length, updatedAt: null, settings } }, errors: {} }) };
  };
  const plugin = factory({ React, win: dom.window });
  t.after(() => { plugin.store.dispose(); dom.window.close(); });
  await plugin.store.load(); plugin.store.update({ labelKey: 'service' }); assert.equal(await plugin.store.save(), true);
  assert.deepEqual(calls.map(call => new URL(call.url, dom.window.location.origin).href), ['http://localhost/api/rivetin/v1/config', 'http://localhost/api/rivetin/v1/config']);
  assert.equal(calls[1].body.pluginId, id); assert.equal(plugin.store.get().labelKey, 'service');
});
