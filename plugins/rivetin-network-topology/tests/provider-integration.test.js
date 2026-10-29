import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import factory from '../src/definition.js';
import { createDataProviders } from '../../../framework/src/data-providers.js';
import { readUiContributions } from '../../../framework/shared/ui-contributions.js';
import { readFile } from 'node:fs/promises';
import { workspaceSnapshot } from './fixtures/workspace.js';
const require = createRequire(new URL('../../../framework/package.json', import.meta.url));
const React = require('react'), ReactDOM = require('react-dom'), { act } = require('react-dom/test-utils.js'), { JSDOM } = require('jsdom');

test('actual framework client provider connects the plugin factory to the second native cluster using GET only; drafts stay local', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>'), previousWindow = globalThis.window, previousDocument = globalThis.document;
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const calls = [], dirty = [], lifecycle = new AbortController(), root = dom.window.document.querySelector('#app');
  dom.window.fetch = () => { throw new Error('Plugin must not create a direct request'); };
  const api = async (route, method, body, options) => {
    calls.push({ route, method, body, signal: options.signal }); const url = new URL(route, 'https://tower.example.invalid');
    assert.equal(url.searchParams.get('pluginId'), 'rivetin-network-topology'); assert.equal(method, 'GET'); assert.equal(body, undefined);
    if (url.pathname.endsWith('/clusters')) return { schemaVersion: 1, source: 'cloudtower', observedAt: new Date().toISOString(), complete: true, clusters: [{ id: 'first-cluster', name: 'First' }, { id: 'second-cluster', name: 'Second' }] };
    assert.equal(url.searchParams.get('clusterId'), 'second-cluster'); return workspaceSnapshot('second-cluster');
  };
  const provider = createDataProviders(api, 'rivetin-network-topology').networkTopology;
  const definition = factory({ React, win: dom.window, options: { networkTopology: { provider }, configurationBackend: () => ({ load: async () => ({ revision: 0, updatedAt: null, settings: {} }) }) } });
  try {
    const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
    const registered = readUiContributions(definition, manifest); assert.equal(registered.status, 'registered');
    const entry = registered.ui.contributions.find(row => row.id === 'open-topology-editor');
    const page = registered.ui.pages.find(row => row.id === entry.target.id); assert.equal(page.slot, entry.slot);
    await definition.store.load(); const stop = definition.activate(); assert.equal(root.childNodes.length, 0); stop();
    await act(async () => { ReactDOM.render(React.createElement(page.Component, { active: true, locale: 'en-US', signal: lifecycle.signal, onDirtyChange: value => dirty.push(value), context: { schemaVersion: 1, section: 'cluster-network-topology', clusterId: 'second-cluster' } }), root); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(calls.length, 2); assert.equal(calls[0].signal.aborted, false); assert.equal(root.querySelector('select').value, 'second-cluster'); assert.match(root.textContent, /Resources loaded/);
    await act(async () => {
      [...root.querySelectorAll('button')].find(button => button.textContent === 'Edit relationship draft').click(); root.querySelector('[data-key="network:net-workload"]').click();
      root.querySelector('.topo-details select').value = 'vds-target'; [...root.querySelectorAll('button')].find(button => button.textContent === 'Add relationship draft').click();
    });
    assert.deepEqual(dirty, [true]); assert.equal(calls.length, 2); assert.match(root.textContent, /Not applied/);
    await act(async () => lifecycle.abort()); assert.equal(root.querySelector('.rvt-topology'), null); assert.deepEqual(dirty, [true, false]);
  } finally { await act(async () => ReactDOM.unmountComponentAtNode(root)); definition.store.dispose(); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
