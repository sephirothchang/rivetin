import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hash, validateManifest, validatePackage } from '../../../framework/server/manifest.js';
import factory from '../src/definition.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const id = 'rivetin-network-topology';

test('Rivetin-only manifest/package contract rejects obsolete IDs and formats; no live compatibility is claimed', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
  assert.equal(validateManifest(manifest).id, id);
  assert.deepEqual(manifest.compatibility.towerBuilds, []);
  const files = [['web/plugin.js', '/* local contract fixture */'], ['LICENSE', 'MIT']].map(([path, value]) => {
    const bytes = Buffer.from(value); return { path, data: bytes.toString('base64'), sha256: hash(bytes) };
  });
  const pkg = { format: 'rivetin-package-v1', manifest, files };
  assert.equal(validatePackage(Buffer.from(JSON.stringify(pkg))).manifest.id, id);
  // Negative fixtures prove rejection; these names are not aliases or migration paths.
  assert.throws(() => validateManifest({ ...manifest, id: 'pluginkit-network-topology' }), /INVALID_MANIFEST/);
  assert.throws(() => validateManifest({ ...manifest, frontend: { ...manifest.frontend, format: 'pluginkit-global-v1' } }), /INVALID_MANIFEST/);
  assert.throws(() => validatePackage(Buffer.from(JSON.stringify({ ...pkg, format: 'pluginkit-package-v1' }))), /INVALID_PACKAGE/);
});

test('SDK and shared settings use only the new ID and /api/rivetin/v1/config endpoint', async () => {
  const dom = new JSDOM('', { url: 'http://127.0.0.1/' }), calls = [];
  dom.window.RivetinSDK = { React: { createElement: (tag, props, text) => ({ tag, text }) } };
  dom.window.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => ({ version: 1, plugins: { [id]: { settings: {}, revision: 0, updatedAt: null } } }) };
  };
  const definition = factory({ win: dom.window });
  await definition.store.load(); assert.equal(await definition.store.save(), true);
  assert.deepEqual(calls.map(call => new URL(call.url, dom.window.location.origin).href), ['http://127.0.0.1/api/rivetin/v1/config', 'http://127.0.0.1/api/rivetin/v1/config']);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT']); assert.equal(calls[1].body.pluginId, id);
  definition.store.dispose(); dom.window.close();
});
