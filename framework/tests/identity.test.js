import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertId, validId } from '../shared/identity.js';
import { createService } from '../server/service.js';
import { createApi } from '../server/http.js';
import { validatePackage, hash } from '../server/manifest.js';
import { createUpdateSource } from '../server/updates.js';
import { actor, bundle, fixture } from './helpers.js';
const id = 'rivetin-example', oldId = 'pluginkit-example';
test('only bounded Rivetin IDs are accepted; old names are not aliases', () => {
  assert.equal(assertId(id), id);
  for (const value of [oldId, 'rivetin-../x', 'rivetin-A', 'rivetin-', 'rivetin-a--b', 'other-a', 'rivetin-' + 'a'.repeat(93)]) {
    assert.equal(validId(value), false); assert.throws(() => assertId(value), /INVALID_PLUGIN_ID/);
  }
});
test('new package bytes keep their digest; old IDs and package/global formats are rejected', () => {
  const bytes = bundle(); assert.equal(validatePackage(bytes).digest, hash(bytes));
  for (const mutate of [pkg => { pkg.manifest.id = oldId; }, pkg => { pkg.format = 'pluginkit-package-v1'; }, pkg => { pkg.manifest.frontend.format = 'pluginkit-global-v1'; }]) {
    assert.throws(() => validatePackage(bundle(id, '0.1.0', pkg => { mutate(pkg); return pkg; })));
  }
});
test('new physical configuration survives restart; old directories remain untouched and unused', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const oldDirectory = path.join(directory, 'plugins', oldId), oldBytes = '{"revision":999,"settings":{"enabled":false}}';
  await mkdir(oldDirectory); await writeFile(path.join(oldDirectory, 'config.json'), oldBytes);
  await service.saveConfig(id, { enabled: false }, actor);
  const next = createService(directory, { towerBuild: '4.9.0' }); await next.initialize(actor);
  assert.deepEqual(Object.keys((await next.loadConfig()).plugins), [id]);
  assert.equal((await next.loadConfig()).plugins[id].settings.enabled, false);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'plugins', id, 'config.json'))).revision, 1);
  assert.equal(await readFile(path.join(oldDirectory, 'config.json'), 'utf8'), oldBytes);
  assert.equal(service.migrateLegacy, undefined);
  await assert.rejects(service.saveConfig(oldId, { enabled: true }, actor), /INVALID_PLUGIN_ID/);
  await assert.rejects(service.change('enable', oldId, null, actor), /INVALID_PLUGIN_ID/);
  assert.equal(await readFile(path.join(oldDirectory, 'config.json'), 'utf8'), oldBytes);
});
test('old API has no handler or side effects; new route preserves opaque settings', async t => {
  const { service, directory } = await fixture(t), text = 'pluginkit-opaque-setting / rivetin-opaque-setting';
  const bytes = bundle(id, '0.1.0', pkg => {
    pkg.manifest.configuration.defaults.note = text;
    pkg.manifest.configuration.schema.properties.note = { type: 'string', maxLength: 200 }; return pkg;
  });
  const uploaded = await service.upload(bytes, actor); await service.change('install', id, uploaded.packageId, actor);
  const handler = createApi(service, { authenticate: async () => actor, origins: ['https://tower.example.invalid'] });
  const server = http.createServer((req, res) => handler(req, res).then(handled => { if (handled === false) { res.writeHead(404); res.end('{}'); } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const before = await readFile(path.join(directory, 'audit.jsonl'), 'utf8');
  const oldResponse = await fetch(url + '/api/pluginkit/v1/disable', { method: 'POST', headers: { Origin: 'https://tower.example.invalid' } });
  assert.equal(oldResponse.status, 404); assert.equal(await readFile(path.join(directory, 'audit.jsonl'), 'utf8'), before);
  const response = await fetch(url + '/api/rivetin/v1/config'); assert.equal(response.status, 200);
  const data = await response.json(); assert.deepEqual(Object.keys(data.plugins), [id]); assert.equal(data.plugins[id].settings.note, text);
});
test('old package upload does not persist package or create plugin configuration', async t => {
  const { service, directory } = await fixture(t); await assert.rejects(service.upload(bundle(oldId), actor));
  assert.deepEqual(await service.packages(), []); assert.deepEqual((await readdir(directory)).filter(name => name === 'plugins'), []);
});
test('catalog rejects old plugin IDs instead of normalizing them', async () => {
  const manifest = JSON.parse(bundle()).manifest;
  const row = { id: oldId, version: manifest.version, frameworkApi: 1, status: 'published', assetId: 123, sha256: 'a'.repeat(64),
    name: manifest.name, description: manifest.description, author: manifest.author, license: manifest.license, permissions: manifest.permissions, compatibility: manifest.compatibility };
  const source = createUpdateSource({ fetchImpl: async () => new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify({ schemaVersion: 2, plugins: [row] })).toString('base64') })) });
  await assert.rejects(source.catalog(), /UPDATE_CATALOG_INVALID/);
});
test('builtin loader uses only new filename without legacy fallback', async t => {
  const { directory } = await fixture(t), moduleFile = path.join(directory, 'builtins.mjs'), builtinDirectory = path.join(directory, 'builtins');
  await copyFile(new URL('../server/builtins.js', import.meta.url), moduleFile); await mkdir(builtinDirectory);
  const loader = await import(pathToFileURL(moduleFile).href);
  await writeFile(path.join(builtinDirectory, 'pluginkit-ssh-channel.json'), 'EXAMPLE_OLD_BYTES');
  assert.deepEqual(await loader.builtinPackages(), []); await assert.rejects(loader.builtinPackages({ required: true }), /BUILTIN_PACKAGE_UNAVAILABLE/);
  await writeFile(path.join(builtinDirectory, 'rivetin-ssh-channel.json'), 'EXAMPLE_NEW_BYTES');
  const result = await loader.builtinPackages(); assert.equal(result.length, 1); assert.equal(result[0].toString(), 'EXAMPLE_NEW_BYTES');
});
test('old SSH approval owners cannot authorize a new Rivetin plugin', async t => {
  const { service, directory } = await fixture(t); await mkdir(path.join(directory, 'ssh-channel'));
  await writeFile(path.join(directory, 'ssh-channel/approvals.json'), JSON.stringify({ version: 1, approvals: { [oldId]: { id: 'old', digest: 'a'.repeat(64) } }, schedules: {}, revocations: { global: '', plugins: {} } }));
  await assert.rejects(service.sshChannel.status(actor), /SSH_APPROVAL_STORE_INVALID/);
  await assert.rejects(service.sshChannel.review(oldId, actor), /INVALID_PLUGIN_ID/);
});
