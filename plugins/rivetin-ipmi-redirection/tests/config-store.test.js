import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createConfigurationStore, createHttpConfigurationBackend } from '../src/config-store.js';
import { sanitizeFunctionalSettings, seedClusterExceptions } from '../src/configuration.js';
import { KEY as STORAGE_KEY } from '../../../framework/src/personal.js';
import { PLUGIN_ID } from '../src/identity.js';
const clone = value => JSON.parse(JSON.stringify(value));
function backend() {
  let value = { revision: 0, updatedAt: null, settings: sanitizeFunctionalSettings() }, writes = 0;
  return { load: async () => clone(value), save: async settings => {
    writes++; value = { revision: value.revision + 1, updatedAt: 'EXAMPLE_TIMESTAMP', settings: clone(settings) }; return clone(value);
  }, writes: () => writes };
}
function fixture(remote, origin = 'https://tower.example.invalid') {
  const dom = new JSDOM('', { url: origin });
  const store = createConfigurationStore(dom.window, remote);
  return { store, win: dom.window, close() { store.dispose(); dom.window.close(); } };
}
test('one generated draft exception per cluster; save applies it, later reload does not restore a deleted exception', async () => {
  const remote = backend(), f = fixture(remote);
  try {
    f.store.setClusters([{ id: 'cluster-a' }, { id: 'cluster-b' }]);
    await f.store.load();
    assert.equal(f.store.status().dirty, true);
    assert.equal(f.store.getDraft().bmcExceptions.length, 2);
    assert.equal(f.store.get().bmcExceptions.length, 0);
    assert.ok(f.store.getDraft().bmcExceptions.every(rule => rule.scope === 'cluster' && rule.vendor === 'generic'));
    assert.equal(remote.writes(), 0);
    assert.equal(await f.store.save(), true);
    assert.equal(f.store.status().dirty, false);
    f.store.update({ bmcExceptions: f.store.getDraft().bmcExceptions.slice(1) });
    await f.store.save(); await f.store.load();
    assert.equal(f.store.getDraft().bmcExceptions.length, 1);
    f.store.setClusters([{ id: 'cluster-a' }, { id: 'cluster-b' }, { id: 'cluster-c' }]);
    assert.deepEqual(f.store.getDraft().bmcExceptions.map(rule => rule.targetId), ['cluster-b', 'cluster-c']);
  } finally { f.close(); }
});
test('independent browser stores share functional settings; personal preference stays local; last save wins', async () => {
  const remote = backend(), a = fixture(remote), b = fixture(remote, 'https://other-browser.example.invalid');
  try {
    await a.store.load(); await b.store.load();
    a.store.update({ showFloatingButton: false, defaultVendor: 'dell-idrac' });
    assert.equal(a.store.get().defaultVendor, 'generic');
    assert.equal(b.store.get().showFloatingButton, true);
    assert.deepEqual(JSON.parse(a.win.localStorage.getItem(STORAGE_KEY)), { showFloatingButton: false, floatingPosition: null });
    assert.equal(await a.store.save(), true); await b.store.load();
    assert.equal(b.store.get().defaultVendor, 'dell-idrac');
    a.store.update({ defaultVendor: 'hpe-ilo' }); b.store.update({ defaultVendor: 'lenovo-xclarity' });
    await a.store.save(); await b.store.save(); await a.store.load();
    assert.equal(a.store.get().defaultVendor, 'lenovo-xclarity');
    assert.equal(a.store.get().showFloatingButton, false);
    assert.ok(!JSON.stringify(await remote.load()).includes('showFloatingButton'));
  } finally { a.close(); b.close(); }
});
test('discard restores saved config; failed saves retain the draft; uncertain writes reconcile without a second PUT', async () => {
  const remote = backend(), f = fixture(remote);
  try {
    await f.store.load();
    f.store.update({ defaultVendor: 'dell-idrac' }); f.store.discard();
    assert.equal(f.store.getDraft().defaultVendor, 'generic');
    assert.equal(f.store.status().dirty, false);
    f.store.update({ defaultVendor: 'hpe-ilo' });
    const original = remote.save; remote.save = async () => { throw new Error('EXAMPLE_FAILURE'); };
    assert.equal(await f.store.save(), false); assert.equal(f.store.status().dirty, true);
    remote.save = async value => { await original(value); throw new Error('EXAMPLE_LOST_RESPONSE'); };
    assert.equal(await f.store.save(), true); assert.equal(remote.writes(), 1);
    assert.equal(f.store.status().dirty, false);
  } finally { f.close(); }
});
test('background reads preserve unsaved drafts and shared config failure never falls back to local functional settings', async () => {
  const remote = backend(), f = fixture(remote);
  try {
    await f.store.load(); f.store.update({ defaultVendor: 'dell-idrac' });
    await remote.save(sanitizeFunctionalSettings({ defaultVendor: 'hpe-ilo' })); await f.store.load();
    assert.equal(f.store.getDraft().defaultVendor, 'dell-idrac');
    assert.equal(f.store.get().defaultVendor, 'hpe-ilo');
    assert.equal(f.store.status().dirty, true);
  } finally { f.close(); }
  const failed = fixture({ load: async () => { throw new Error(); } });
  try {
    failed.win.localStorage.setItem('c89.tower.plugins.preferences.v1', JSON.stringify({ defaultVendor: 'dell-idrac' }));
    await failed.store.load(); failed.store.update({ defaultVendor: 'hpe-ilo', showFloatingButton: false });
    assert.equal(failed.store.status().loaded, false);
    assert.equal(failed.store.get().defaultVendor, 'generic');
    assert.equal(failed.store.get().showFloatingButton, false);
    assert.equal(await failed.store.save(), false);
  } finally { failed.close(); }
});
test('HTTP config backend uses the distinct same-origin API namespace and no local fallback', async () => {
  const requests = [], remote = backend();
  const win = { location: { origin: 'https://tower.example.invalid' }, fetch: async (url, opts) => {
    requests.push({ url, opts });
    const payload = opts.body && JSON.parse(opts.body);
    if (payload) assert.equal(payload.pluginId, PLUGIN_ID);
    return new Response(JSON.stringify({ version: 1, plugins: { [PLUGIN_ID]: opts.method === 'GET' ? await remote.load() : await remote.save(payload.settings) } }));
  } };
  const client = createHttpConfigurationBackend(win);
  await client.load(); await client.save(sanitizeFunctionalSettings());
  assert.ok(requests.every(value => new URL(value.url, win.location.origin).href === 'https://tower.example.invalid/api/rivetin/v1/config'));
  assert.deepEqual(requests.map(value => value.opts.method), ['GET', 'PUT']);
  assert.throws(() => createHttpConfigurationBackend(win, 'https://other.example.invalid/config'));
});
test('rebuilt shared client preserves fixed HTTP errors and rejects arbitrary diagnostics without alternate routes or retry', async () => {
  for (const [status, body, expected] of [[404, { error: 'CONFIGURATION_UNAVAILABLE' }, 'CONFIGURATION_UNAVAILABLE'], [500, { error: 'EXAMPLE_PRIVATE_DIAGNOSTIC\npassword=EXAMPLE_SECRET' }, 'REQUEST_FAILED'], [403, { error: 'ADMIN_REQUIRED' }, 'ADMIN_REQUIRED']]) {
    const requests = [], win = { location: { origin: 'https://tower.example.invalid' }, fetch: async (url, options) => { requests.push({ url, options }); return Response.json(body, { status }); } };
    await assert.rejects(createHttpConfigurationBackend(win).load(), failure => failure.message === expected && failure.code === expected && failure.status === status);
    assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/rivetin/v1/config');
    assert.equal(requests[0].options.credentials, 'same-origin'); assert.equal(requests[0].options.redirect, 'error');
  }
});
test('HTML 404 and malformed API responses fail closed without trying another endpoint or leaking response text', async () => {
  for (const [status, expected] of [[404, 'NOT_FOUND'], [500, 'INVALID_API_RESPONSE'], [200, 'INVALID_API_RESPONSE']]) {
    let calls = 0;
    const win = { location: { origin: 'https://tower.example.invalid' }, fetch: async () => { calls++; return new Response('EXAMPLE_PRIVATE_RESPONSE', { status }); } };
    await assert.rejects(createHttpConfigurationBackend(win).load(), failure => failure.message === expected);
    assert.equal(calls, 1);
  }
});
test('recompiled HTTP backend keeps drafts on an uncertain PUT and performs one confirmation GET without retrying the write', async () => {
  const requests = [], remote = backend();
  const win = { location: { origin: 'https://tower.example.invalid' }, fetch: async (url, options) => {
    requests.push(options.method);
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
    assert.equal(url, '/api/rivetin/v1/config');
    if (options.method === 'PUT') return Response.json({ error: 'EXAMPLE_PRIVATE_DIAGNOSTIC\nsecret=EXAMPLE_SECRET' }, { status: 500 });
    return Response.json({ version: 1, plugins: { [PLUGIN_ID]: await remote.load() } });
  } };
  const f = fixture(createHttpConfigurationBackend(win));
  try {
    await f.store.load(); f.store.update({ defaultVendor: 'dell-idrac' });
    assert.equal(await f.store.save(), false); assert.equal(f.store.status().dirty, true);
    assert.deepEqual(requests, ['GET', 'PUT', 'GET']);
    assert.equal(f.store.getDraft().defaultVendor, 'dell-idrac'); assert.doesNotMatch(f.store.status().error, /EXAMPLE_PRIVATE|EXAMPLE_SECRET/);
  } finally { f.close(); }
});
test('cluster seeding keeps existing custom rules, supports long IDs, and does not silently drop excess clusters', () => {
  const existing = sanitizeFunctionalSettings({ bmcExceptions: [{ id: 'custom', scope: 'cluster', targetId: 'cluster-a', vendor: 'ami-megarac' }] });
  const generated = seedClusterExceptions(existing, [{ id: 'cluster-a' }, { id: 'x'.repeat(128) }]);
  assert.equal(generated.bmcExceptions[0].vendor, 'ami-megarac');
  assert.equal(sanitizeFunctionalSettings(generated).bmcExceptions[1].id, generated.bmcExceptions[1].id);
  assert.throws(() => seedClusterExceptions(existing, Array.from({ length: 2001 }, (_, index) => ({ id: 'cluster-' + index }))));
});
