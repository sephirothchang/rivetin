import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import createPlugin from '../src/definition.js';
import { PLUGIN_ID, CONFIGURATION_ENDPOINT, defaults } from '../src/configuration.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
test('configuration requests use only the canonical Rivetin API and plugin ID', async t => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://tower.example.invalid/' });
  const win = dom.window, requests = [];
  let saved = { revision: 0, updatedAt: null, settings: defaults() };
  win.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body });
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body); assert.equal(body.pluginId, PLUGIN_ID);
      saved = { revision: saved.revision + 1, updatedAt: new Date().toISOString(), settings: body.settings };
    }
    return { ok: true, json: async () => ({ version: 1, plugins: { [PLUGIN_ID]: structuredClone(saved) }, errors: {} }) };
  };
  const plugin = createPlugin({ React: { createElement() {} }, win });
  t.after(() => { plugin.store.dispose(); win.close(); });
  assert.equal(plugin.id, 'rivetin-disk-smart-info');
  await plugin.store.load(); plugin.store.update({ enabled: false }); assert.equal(await plugin.store.save(), true);
  const configRequests = requests.filter(request => new URL(request.url, win.location.origin).pathname === CONFIGURATION_ENDPOINT);
  assert.deepEqual(configRequests.map(request => request.method), ['GET', 'PUT']);
  assert.ok(requests.every(request => new URL(request.url, win.location.origin).pathname.startsWith('/api/rivetin/v1/')));
  assert.equal(plugin.store.get().enabled, false);
});
test('a missing Rivetin API never falls back to the legacy API', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tower.example.invalid/' }), win = dom.window, urls = [];
  win.fetch = async url => { urls.push(url); return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) }; };
  const plugin = createPlugin({ React: { createElement() {} }, win });
  t.after(() => { plugin.store.dispose(); win.close(); });
  await plugin.store.load();
  assert.equal(plugin.store.status().loaded, false);
  assert.ok(urls.length > 0);
  assert.ok(urls.every(url => new URL(url, win.location.origin).pathname.startsWith('/api/rivetin/v1/')));
});
