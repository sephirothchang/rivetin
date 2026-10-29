import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import React from 'react';
import ReactDOM from 'react-dom';
import testUtils from 'react-dom/test-utils.js';
import { JSDOM } from 'jsdom';
import { createFrameworkHub } from '../src/hub.js';
import { createApi } from '../server/http.js';

const { act } = testUtils, settle = () => new Promise(setImmediate);
const actor = { id: 'example-root', source: 'tower', role: 'ROOT', admin: true };
const topology = clusterId => ({ schemaVersion: 1, source: 'cloudtower', cluster: { id: clusterId, name: 'Example cluster' }, revision: 'a'.repeat(64), observedAt: new Date().toISOString(), complete: true, hosts: [], switches: [], nics: [], vmGroups: [], peers: [] });

test('topology HTTP routes allow exact authenticated GET parameters and never dispatch a mutation', async t => {
  const calls = [], service = { networkTopology: { listClusters: async input => { calls.push(['clusters', input]); return { ok: true }; }, read: async input => { calls.push(['read', input]); return topology(input.clusterId); } } };
  const handler = createApi(service, { authenticate: async () => actor, origins: ['https://tower.example.invalid'] });
  const server = createServer(async (req, res) => { if (await handler(req, res) === false) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/rivetin/v1/data/network-topology/`;
  const response = await fetch(base + 'snapshot?pluginId=rivetin-network-topology&clusterId=second-cluster'); assert.equal(response.status, 200); assert.equal((await response.json()).cluster.id, 'second-cluster');
  assert.equal(calls.length, 1); assert.equal(calls[0][1].actor, actor); assert.ok(calls[0][1].signal);
  for (const suffix of ['snapshot?pluginId=rivetin-network-topology', 'snapshot?pluginId=rivetin-network-topology&clusterId=x&clusterId=y', 'clusters?pluginId=rivetin-network-topology&query=EXAMPLE', 'snapshot?pluginId=rivetin-network-topology&clusterId=x&write=true']) assert.equal((await fetch(base + suffix)).status, 400);
  assert.equal((await fetch(base + 'snapshot', { method: 'POST', headers: { Origin: 'https://tower.example.invalid' } })).status, 404); assert.equal(calls.length, 1);
});

test('real Hub workpage injection first reads selected second cluster; route change aborts stale generation and never saves config', async t => {
  const dom = new JSDOM('<main><aside>Cluster tree</aside><div><div class="tab-bar">Tabs</div><div id="networkTopology" class="react-flow"><div class="right item"><div class="show-line"><input type="checkbox"></div><span class="refresh-wrapper"></span></div></div></div></main><div id="island"></div>', { url: 'https://tower.example.invalid/#/clusters/second-cluster?view=%22networkTopology%22', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const historyListeners = new Set(), blockers = new Set();
  const history = { location: { pathname: '/clusters/second-cluster', search: '?view=%22networkTopology%22' }, listen(fn) { historyListeners.add(fn); return () => historyListeners.delete(fn); }, block(fn) { blockers.add(fn); return () => blockers.delete(fn); }, push(next) { move(next); }, replace(next) { move(next); } };
  function move(next) { if ([...blockers].some(fn => fn(next, 'PUSH') === false)) return; history.location = next; dom.window.history.replaceState({}, '', '#' + next.pathname + next.search); for (const fn of historyListeners) fn(next, 'PUSH'); }
  const calls = [], seen = [], signals = [], promises = [];
  const id = 'rivetin-network-topology', manifest = { id, name: { 'zh-CN': '网络拓扑', 'en-US': 'Network topology' }, permissions: ['inventory.read'], compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.6' } };
  const client = async (route, method = 'GET', body, options) => {
    calls.push({ route, method, body });
    if (route === '/runtime') return { version: '0.2.5', enabled: true };
    if (route === '/plugins') return { items: [{ id, installed: true, enabled: true, active: true, packageId: 'example-package', manifest }], packages: [] };
    if (route.startsWith('/data/network-topology/clusters')) return { schemaVersion: 1, source: 'cloudtower', complete: true, observedAt: new Date().toISOString(), clusters: [{ id: 'first-cluster', name: 'First' }, { id: 'second-cluster', name: 'Second' }] };
    if (route.startsWith('/data/network-topology/snapshot')) { signals.push(options.signal); return new Promise(resolve => promises.push({ resolve, clusterId: new URL(route, 'https://example.invalid').searchParams.get('clusterId') })); }
    return { items: [], next: null };
  };
  function factory({ options }) {
    const store = { status: () => ({ loaded: true, dirty: false }), get: () => ({}), getDraft: () => ({}), load: async () => {}, subscribe: () => () => {}, dispose() {} };
    function Page({ active, locale, context, signal, onDirtyChange }) {
      assert.equal(active, true); assert.equal(locale, 'zh-CN'); assert.equal(typeof onDirtyChange, 'function');
      React.useEffect(() => { let live = true; options.networkTopology.provider.read({ clusterId: context.clusterId, signal }).then(value => { if (live) seen.push(value.cluster.id); }).catch(() => {}); return () => { live = false; }; }, [context.clusterId, signal]);
      return React.createElement('p', null, context.clusterId);
    }
    return { id, store, Settings() { return null; }, activate: () => () => {}, ui: { schemaVersion: 1, pages: [{ id: 'main', Component: Page }], actions: [], contributions: [{ id: 'open', slot: 'cluster-network-topology.toolbar.actions', label: { 'zh-CN': '可视化编辑', 'en-US': 'Visual editor' }, target: { type: 'page', id: 'main' } }] } };
  }
  const Hub = createFrameworkHub({ client, definitions: { [id]: factory } }), root = document.getElementById('island');
  t.after(async () => { await act(async () => { ReactDOM.unmountComponentAtNode(root); await settle(); }); dom.window.close(); });
  await act(async () => { ReactDOM.render(React.createElement(Hub, { history }), root); await settle(); });
  await act(async () => { document.querySelector('[data-rivetin-ui-contribution]').click(); await settle(); });
  assert.equal(promises.length, 1); assert.equal(promises[0].clusterId, 'second-cluster');
  await act(async () => { history.push({ pathname: '/clusters/third-cluster', search: history.location.search }); await settle(); });
  assert.equal(signals[0].aborted, true); assert.equal(promises[1].clusterId, 'third-cluster');
  await act(async () => { promises[0].resolve(topology('second-cluster')); promises[1].resolve(topology('third-cluster')); await settle(); });
  assert.deepEqual(seen, ['third-cluster']); assert.ok(calls.every(call => call.method === 'GET')); assert.ok(!calls.some(call => call.route === '/config'));
});

for (const kind of ['legacy', 'dual', 'invalid', 'throwing-getter']) test(`Hub ${kind} UI keeps existing Settings and activation available`, async t => {
  const dom = new JSDOM('<div id="island"></div>', { url: 'https://tower.example.invalid/#/everoute/overview', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const id = 'rivetin-example', manifest = { id, name: { 'zh-CN': '示例', 'en-US': 'Example' }, description: { 'zh-CN': '示例', 'en-US': 'Example' }, permissions: [], compatibility: { schemaVersion: 2, frameworkMinVersion: '0.2.6' } };
  let activations = 0;
  const client = async route => route === '/runtime' ? { version: '0.2.6', enabled: true } : route === '/plugins' ? { items: [{ id, installed: true, enabled: true, active: true, packageId: 'example-package', manifest }], packages: [] } : { items: [], next: null };
  const store = { status: () => ({ loaded: true, dirty: false }), get: () => ({}), getDraft: () => ({}), load: async () => {}, subscribe: () => () => {}, dispose() {} };
  function factory() {
    const value = { id, store, Settings() { return React.createElement('p', { 'data-example-settings': '' }, 'Existing settings'); }, activate() { activations++; return () => {}; } };
    if (kind === 'legacy' || kind === 'dual') value.workPage = {};
    if (kind === 'invalid' || kind === 'dual') value.ui = {};
    if (kind === 'throwing-getter') Object.defineProperty(value, 'ui', { get() { throw new Error('EXAMPLE_PRIVATE'); } });
    return value;
  }
  const Hub = createFrameworkHub({ initialTab: id, client, definitions: { [id]: factory } }), root = document.getElementById('island');
  t.after(async () => { await act(async () => { ReactDOM.unmountComponentAtNode(root); await settle(); }); dom.window.close(); });
  await act(async () => { ReactDOM.render(React.createElement(Hub), root); await settle(); });
  await act(async () => { document.querySelector('.c89-plugin-fab').click(); await settle(); });
  assert.equal(activations, 1); assert.equal(document.querySelector('[data-example-settings]').textContent, 'Existing settings');
  assert.doesNotMatch(document.body.textContent, /PLUGIN_LOAD_FAILED|EXAMPLE_PRIVATE/); assert.equal(document.querySelector('[data-rivetin-ui-contribution]'), null);
});
