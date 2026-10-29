import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTopologyWorkspaceComponent } from '../src/workspace-component.js';
import { workspaceSnapshot } from './fixtures/workspace.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const React = require('react'), ReactDOM = require('react-dom'), { act } = require('react-dom/test-utils.js'), { JSDOM } = require('jsdom');

test('React page starts only when active, updates locale without rereading, and cancellation cleans content', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>'), previousWindow = globalThis.window, previousDocument = globalThis.document, previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let calls = 0;
  const source = { async listClusters() { calls++; return [{ id: 'cluster-fixture', name: 'Fixture' }]; }, async read({ clusterId }) { calls++; return workspaceSnapshot(clusterId); } };
  const Component = createTopologyWorkspaceComponent(React, dom.window, source), container = dom.window.document.querySelector('#app'), lifecycle = new AbortController();
  const render = props => ReactDOM.render(React.createElement(Component, { context: { section: 'cluster-network-topology', clusterId: 'cluster-fixture' }, ...props }), container);
  try {
    await act(async () => { render({ active: false, signal: lifecycle.signal }); }); assert.equal(calls, 0);
    await act(async () => { render({ active: true, locale: 'en-US', signal: lifecycle.signal }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(calls, 2); assert.match(container.textContent, /Network topology/); assert.equal(container.querySelectorAll('.rvt-topology').length, 1);
    await act(async () => { render({ active: true, locale: 'zh-CN', signal: lifecycle.signal }); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(calls, 2); assert.equal(container.querySelectorAll('.rvt-topology').length, 1); assert.match(container.textContent, /网络拓扑/);
    await act(async () => { lifecycle.abort(); }); assert.equal(container.querySelector('.rvt-topology'), null);
    await act(async () => { render({ active: false }); }); assert.equal(calls, 2);
  } finally {
    await act(async () => ReactDOM.unmountComponentAtNode(container)); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

test('context changes cancel the old cluster generation and late old data cannot replace the new cluster', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>'), previousWindow = globalThis.window, previousDocument = globalThis.document;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  let resolveOld, oldSignal; const reads = [];
  const source = { async listClusters() { return [{ id: 'first-cluster', name: 'First' }, { id: 'second-cluster', name: 'Second' }]; }, read({ clusterId, signal }) {
    reads.push(clusterId); if (clusterId === 'second-cluster') { oldSignal = signal; return new Promise(resolve => { resolveOld = resolve; }); }
    const value = workspaceSnapshot(clusterId); value.cluster.name = 'Current First'; return value;
  } };
  const Component = createTopologyWorkspaceComponent(React, dom.window, source), container = dom.window.document.querySelector('#app');
  const render = (clusterId, active = true) => ReactDOM.render(React.createElement(Component, { active, context: { section: 'cluster-network-topology', clusterId } }), container);
  try {
    await act(async () => { render('second-cluster', 1); await new Promise(resolve => setTimeout(resolve, 0)); }); assert.deepEqual(reads, []);
    await act(async () => { render('second-cluster'); await new Promise(resolve => setTimeout(resolve, 0)); }); assert.deepEqual(reads, ['second-cluster']);
    await act(async () => { render('first-cluster'); await new Promise(resolve => setTimeout(resolve, 0)); }); assert.equal(oldSignal.aborted, true); assert.deepEqual(reads, ['second-cluster', 'first-cluster']);
    await act(async () => { const old = workspaceSnapshot('second-cluster'); old.cluster.name = 'Late Second'; resolveOld(old); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(container.textContent, /Current First/); assert.doesNotMatch(container.textContent, /Late Second/); assert.equal(container.querySelectorAll('.rvt-topology').length, 1);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(container)); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; }
});

test('dirty locale update preserves session, draft, layout, cluster, read identity and dirty lifecycle', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>'), previousWindow = globalThis.window, previousDocument = globalThis.document;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const dirty = [], reads = [], lifecycle = new AbortController();
  const source = { async listClusters() { return [{ id: 'cluster-fixture', name: 'Fixture' }]; }, async read(args) { reads.push(args); return workspaceSnapshot(args.clusterId); } };
  const Component = createTopologyWorkspaceComponent(React, dom.window, source), root = dom.window.document.querySelector('#app');
  const render = (locale, active = true) => ReactDOM.render(React.createElement(Component, { active, locale, signal: lifecycle.signal, onDirtyChange: value => dirty.push(value), context: { section: 'cluster-network-topology', clusterId: 'cluster-fixture' } }), root);
  const click = text => [...root.querySelectorAll('button')].find(button => button.textContent === text).click();
  try {
    await act(async () => { render('zh-CN'); await new Promise(resolve => setTimeout(resolve, 0)); });
    await act(async () => {
      click('编辑布局'); root.querySelector('[data-key="vds:vds-workload"]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      click('编辑关联草稿'); root.querySelector('[data-key="network:net-workload"]').click(); root.querySelector('.topo-details select').value = 'vds-target'; click('加入关联草稿');
    });
    const shell = root.querySelector('.rvt-topology'), parentX = root.querySelector('[data-key="vds:vds-workload"]').style.left, childX = root.querySelector('[data-key="network:net-workload"]').style.left;
    assert.deepEqual(dirty, [true]);
    await act(async () => { render('en-US'); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(root.querySelector('.rvt-topology') === shell, true, 'locale must retain the existing page session');
    assert.deepEqual(dirty, [true]); assert.equal(reads.length, 1); assert.equal(reads[0].signal.aborted, false);
    assert.equal(root.querySelector('select').value, 'cluster-fixture'); assert.equal(root.querySelector('[data-key="vds:vds-workload"]').style.left, parentX); assert.equal(root.querySelector('[data-key="network:net-workload"]').style.left, childX);
    assert.equal(root.querySelectorAll('path[data-kind=draft]').length, 1); assert.match(root.textContent, /Local relationship draft \/ review/); assert.match(root.textContent, /network net-workload: Workload A → Workload B/);
    await act(async () => { render('zh-CN'); }); assert.deepEqual(dirty, [true]); assert.match(root.textContent, /本地关联草稿 \/ 差异审查/);
    await act(async () => { render('zh-CN', false); }); assert.deepEqual(dirty, [true, false]); assert.equal(reads[0].signal.aborted, true); assert.equal(root.querySelector('.rvt-topology'), null);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; }
});

test('locale update during an in-flight read neither aborts nor restarts it, and the eventual page uses the new language', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>'), previousWindow = globalThis.window, previousDocument = globalThis.document;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  let resolveRead; const reads = [];
  const source = { async listClusters() { return [{ id: 'cluster-fixture', name: 'Fixture' }]; }, read(args) { reads.push(args); return new Promise(resolve => { resolveRead = resolve; }); } };
  const Component = createTopologyWorkspaceComponent(React, dom.window, source), root = dom.window.document.querySelector('#app');
  const render = locale => ReactDOM.render(React.createElement(Component, { active: true, locale, context: { section: 'cluster-network-topology', clusterId: 'cluster-fixture' } }), root);
  try {
    await act(async () => { render('zh-CN'); await new Promise(resolve => setTimeout(resolve, 0)); }); const signal = reads[0].signal;
    await act(async () => { render('en-US'); await new Promise(resolve => setTimeout(resolve, 0)); }); assert.equal(signal.aborted, false); assert.equal(reads.length, 1);
    await act(async () => { resolveRead(workspaceSnapshot()); await new Promise(resolve => setTimeout(resolve, 0)); }); assert.match(root.textContent, /Resources loaded/);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(root)); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
