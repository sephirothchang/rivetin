import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hash, validateManifest, validatePackage } from '../../../framework/server/manifest.js';
import factory from '../src/definition.js';
import { validateUiContributions, readUiContributions, contributionVisible } from '../../../framework/shared/ui-contributions.js';
const { JSDOM } = createRequire(new URL('../../../framework/package.json', import.meta.url))('jsdom');
const id = 'rivetin-network-topology';

test('UI contribution manifest targets framework 0.2.6/Tower 4.9.0 without claiming live acceptance, and rejects obsolete identity/formats', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
  assert.equal(validateManifest(manifest).id, id);
  assert.deepEqual(manifest.compatibility.towerBuilds, ['4.9.0']);
  assert.equal(manifest.compatibility.schemaVersion, 2); assert.equal(manifest.compatibility.frameworkMinVersion, '0.2.6');
  assert.equal(manifest.compatibility.frameworkMaxVersionExclusive, '0.3.0'); assert.equal(manifest.compatibility.smtx, 'none');
  assert.deepEqual(manifest.permissions, ['inventory.read']); assert.match(manifest.releaseNotes['en-US'], /pending/);
  const dom = new JSDOM('');
  const definition = factory({ React: { createElement() {} }, win: dom.window, options: { configurationBackend: () => ({}) } });
  assert.equal(Object.hasOwn(definition, 'workPage'), false);
  const ui = validateUiContributions(definition.ui, manifest);
  assert.equal(readUiContributions(definition, manifest).status, 'registered');
  assert.equal(ui.pages.length, 1); assert.equal(ui.pages[0].id, 'topology-editor');
  assert.equal(ui.pages[0].slot, 'cluster-network-topology.toolbar.actions');
  assert.equal(typeof ui.pages[0].Component, 'function'); assert.deepEqual(ui.actions, []);
  assert.deepEqual(ui.contributions, [{ id: 'open-topology-editor', slot: 'cluster-network-topology.toolbar.actions',
    label: { 'zh-CN': '可视化编辑', 'en-US': 'Visual editor' }, icon: 'edit', order: 100,
    visibility: { requiresContext: ['clusterId'] }, target: { type: 'page', id: 'topology-editor' } }]);
  assert.equal(contributionVisible(ui.contributions[0], { schemaVersion: 1, section: 'cluster-network-topology', clusterId: 'second-cluster' }), true);
  assert.equal(contributionVisible(ui.contributions[0], { schemaVersion: 1, section: 'cluster-network-topology', clusterId: null }), false);
  assert.equal(readUiContributions(definition, { ...manifest, compatibility: { ...manifest.compatibility, frameworkMinVersion: '0.2.5' } }).code, 'UI_FRAMEWORK_MINIMUM_REQUIRED');
  assert.equal(readUiContributions({ ...definition, workPage: {} }, manifest).code, 'UI_CONTRIBUTIONS_INVALID');
  assert.equal(typeof definition.Settings, 'function'); assert.equal(typeof definition.activate(), 'function');
  definition.store.dispose(); dom.window.close();
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
