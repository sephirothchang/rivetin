import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createClient, loadPlugin } from '../src/client.js';
const reply = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const runtime = { enabled: true, initialized: true, version: '0.1.0' };
const win = fetch => ({ fetch, localStorage: { getItem: () => null } });

test('Rivetin API requests preserve protocol payloads and opaque settings', async () => {
  const calls = [], settings = { label: 'EXAMPLE_LABEL', nested: { pluginId: 'EXAMPLE_OPAQUE_VALUE' } };
  const client = createClient(win(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/runtime')) return reply(200, runtime);
    return reply(200, { version: 1, plugins: { 'rivetin-example': { revision: 0, settings } } });
  }));
  assert.deepEqual(await client('/runtime'), runtime); assert.equal(calls.length, 1);
  const result = await client('/config', 'PUT', { pluginId: 'rivetin-example', settings });
  assert.deepEqual(result.plugins['rivetin-example'].settings, settings);
  assert.deepEqual(JSON.parse(calls[1].options.body), { pluginId: 'rivetin-example', settings });
  assert.ok(calls.every(call => call.url.startsWith('/api/rivetin/v1/')));
});

test('HTTP errors including a read-only 404 never probe another API prefix', async () => {
  for (const status of [401, 403, 404, 503]) {
    const calls = [], client = createClient(win(async url => { calls.push(url); return reply(status, { error: 'EXAMPLE_API_ERROR' }); }));
    await assert.rejects(client('/runtime'));
    assert.deepEqual(calls, ['/api/rivetin/v1/runtime'], String(status));
  }
});

test('unknown mutation outcomes never retry', async () => {
  const calls = [], client = createClient(win(async (url, options) => { calls.push({ url, method: options.method }); throw new Error('EXAMPLE_OUTCOME_UNKNOWN'); }));
  await assert.rejects(client('/plugins', 'POST', { action: 'install', pluginId: 'rivetin-example' }), /EXAMPLE_OUTCOME_UNKNOWN/);
  assert.deepEqual(calls, [{ url: '/api/rivetin/v1/plugins', method: 'POST' }]);
});

test('legacy plugin IDs are rejected before network access', async () => {
  let requests = 0;
  const client = createClient(win(async () => { requests++; return reply(200, {}); }));
  await assert.rejects(client('/plugins', 'POST', { action: 'enable', pluginId: 'pluginkit-example' }), /INVALID_PLUGIN_ID/);
  await assert.rejects(client('/logs?pluginId=pluginkit-example'), /INVALID_PLUGIN_ID/);
  assert.equal(requests, 0);
});

test('package text is transmitted unchanged instead of rewriting signed content', async () => {
  let uploaded;
  const client = createClient(win(async (url, options) => { uploaded = options.body; return reply(201, { packageId: 'a'.repeat(64) }); }));
  const original = '{"format":"rivetin-package-v1","manifest":{"id":"rivetin-example"},"files":[]}';
  await client('/packages', 'POST', original); assert.equal(uploaded, original);
});

test('Rivetin registry exports load once and preserve their strict identity', async () => {
  const dom = new JSDOM('<head></head><body></body>', { url: 'https://tower.example.invalid' });
  const { window } = dom, id = 'rivetin-example', factory = () => ({ id });
  const record = { id, packageId: 'a'.repeat(64), frontendSha256: 'b'.repeat(64), manifest: { frontend: { entry: 'web/plugin.js' } } };
  let scripts = 0, source;
  const append = window.document.head.append.bind(window.document.head);
  window.document.head.append = node => { scripts++; source = node.src; append(node); window.RivetinPlugins[id] = { default: factory }; queueMicrotask(() => node.onload()); };
  const client = { assetUrl: async current => `/api/rivetin/v1/assets/${current.id}/${current.packageId}/web/plugin.js` };
  try {
    const [one, two] = await Promise.all([loadPlugin(window, record, client), loadPlugin(window, record, client)]);
    assert.equal(one, factory); assert.equal(two, factory); assert.equal(scripts, 1);
    assert.ok(source.includes('/api/rivetin/v1/assets/rivetin-example/'));
    assert.equal(window.RivetinPlugins[id], factory); assert.equal(window.document.querySelector('script'), null);
    await assert.rejects(loadPlugin(window, { ...record, id: 'pluginkit-example' }, client), /INVALID_PLUGIN_ENTRY/);
  } finally { dom.window.close(); }
});
