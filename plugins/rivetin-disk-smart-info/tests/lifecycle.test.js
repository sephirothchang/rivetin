import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, actor } from '../../../framework/tests/helpers.js';
import { hash, validateManifest, validatePackage } from '../../../framework/server/manifest.js';
import { PLUGIN_ID, defaults } from '../src/configuration.js';
import { checkCompatibility } from '../../../framework/server/compatibility.js';
import { storage } from '../../../framework/server/storage.js';
import { assertCurrentReleaseManifest, legacyReleaseDeclaration, syntheticServiceManifest } from './fixtures/service-manifest.js';
test('current candidate declares exact schema-2 compatibility and synchronized metadata versions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url)));
  assertCurrentReleaseManifest(manifest);
  assert.deepEqual(manifest.compatibility.towerBuilds, ['4.9.0']);
  assert.equal(manifest.compatibility.frameworkMinVersion, '0.2.0');
  assert.equal(validateManifest(manifest).version, '0.1.6');
  assert.equal(JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version, manifest.version);
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
  assert.equal(lock.version, manifest.version); assert.equal(lock.packages[''].version, manifest.version);
  for (const frameworkVersion of ['0.2.0', '0.2.99']) assert.equal(checkCompatibility(manifest, { towerBuild: '4.9.0', frameworkVersion }).compatible, true);
  for (const frameworkVersion of ['0.1.4', '0.1.99', '0.3.0']) assert.equal(checkCompatibility(manifest, { towerBuild: '4.9.0', frameworkVersion }).reason, 'PLUGIN_INCOMPATIBLE');
  assert.equal(checkCompatibility(manifest, { towerBuild: '4.9.0', frameworkVersion: '0.2.0', frameworkApi: 2 }).compatible, false);
  const withoutUpperBound = { ...manifest.compatibility }; delete withoutUpperBound.frameworkMaxVersionExclusive;
  for (const compatibility of [withoutUpperBound, { ...manifest.compatibility, towerBuilds: [] },
    { ...manifest.compatibility, frameworkMinVersion: '0.3.0' }, { ...manifest.compatibility, schemaVersion: 3 },
    { ...manifest.compatibility, smtx: 'SMTX_OS 6.3.0' }, { ...manifest.compatibility, undeclared: true }]) {
    assert.throws(() => validateManifest({ ...manifest, compatibility }), /INVALID_MANIFEST/);
    assert.equal(checkCompatibility({ ...manifest, compatibility }, { towerBuild: '4.9.0', frameworkVersion: '0.2.0' }).compatible, false);
  }
  for (const towerBuild of ['4.8.0', '4.9.1', '4.10.0', null]) assert.equal(checkCompatibility(manifest, { towerBuild }).compatible, false);
  assert.deepEqual(manifest.permissions, ['inventory.read', 'ssh.channel.use', 'disk.smart.read']);
  assert.deepEqual(manifest.ssh.commands.map(({ id, operation, hostScope, deviceScope, intervalSeconds }) => ({ id, operation, hostScope, deviceScope, intervalSeconds })), [{ id: 'daily-smart', operation: 'disk.smart.read', hostScope: 'configured', deviceScope: 'configured', intervalSeconds: 86400 }]);
});

test('synthetic service fixture does not upgrade the historical 0.1.3 declaration', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url)));
  const synthetic = syntheticServiceManifest(manifest);
  for (const frameworkVersion of ['0.2.0', '0.2.99']) assert.equal(checkCompatibility(synthetic, { towerBuild: '4.9.0', frameworkVersion }).compatible, true);
  for (const frameworkVersion of ['0.1.99', '0.3.0']) assert.equal(checkCompatibility(synthetic, { towerBuild: '4.9.0', frameworkVersion }).compatible, false);
  assert.equal(checkCompatibility(synthetic, { towerBuild: '4.9.1', frameworkVersion: '0.2.0' }).compatible, false);
  assert.equal(checkCompatibility(synthetic, { towerBuild: '4.9.0', frameworkVersion: '0.2.0', frameworkApi: 2 }).compatible, false);
  assertCurrentReleaseManifest(manifest);
  const legacy = legacyReleaseDeclaration();
  for (const frameworkVersion of ['0.1.2', '0.1.4', '0.2.0']) assert.equal(checkCompatibility(legacy, { towerBuild: '4.9.0', frameworkVersion }).reason, 'PLUGIN_COMPATIBILITY_UNDECLARED');
  assert.equal(legacy.version, '0.1.3'); assert.equal(legacy.compatibility.schemaVersion, undefined);
});
test('framework install/disable/update/rollback/reset/uninstall preserves isolated plugin settings', async t => {
  const { service, directory, install } = await fixture(t);
  const disk = storage(directory);
  const record = async () => (await service.plugins()).find(item => item.id === PLUGIN_ID);
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url)));
  function bytes(version) {
    // These schema-2 versions exercise service state/configuration only.
    const fixtureManifest = syntheticServiceManifest(manifest, version);
    return Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest: fixtureManifest, files: ['web/plugin.js', 'LICENSE'].map(file => {
      const content = Buffer.from(file === 'LICENSE' ? 'MIT License' : '/* unexecuted lifecycle fixture */');
      return { path: file, sha256: hash(content), data: content.toString('base64') };
    }) }));
  }
  await install('rivetin-other'); await service.saveConfig('rivetin-other', { enabled: false }, actor);
  const otherPath = disk.plugin('rivetin-other'), other = await readFile(otherPath);
  const uploaded = await service.upload(bytes('0.1.0'), actor); await service.change('install', PLUGIN_ID, uploaded.packageId, actor);
  assert.equal((await record()).active, false);
  await service.enable(actor); await service.change('enable', PLUGIN_ID, null, actor);
  await service.saveConfig(PLUGIN_ID, { ...defaults(), enabled: false }, actor);
  const config = disk.plugin(PLUGIN_ID), before = await readFile(config);
  const next = await service.upload(bytes('0.1.1'), actor); await service.change('update', PLUGIN_ID, next.packageId, actor);
  assert.deepEqual(await readFile(config), before); assert.equal((await record()).active, false);
  await service.change('rollback', PLUGIN_ID, null, actor); assert.deepEqual(await readFile(config), before);
  await service.change('reset', PLUGIN_ID, null, actor); assert.deepEqual(JSON.parse(await readFile(config)).settings, defaults());
  await service.disable(actor); assert.ok((await service.plugins()).every(item => !item.active));
  const reset = await readFile(config); await service.change('uninstall', PLUGIN_ID, null, actor); assert.deepEqual(await readFile(config), reset);
  assert.deepEqual(await readFile(otherPath), other);
  assert.equal((await readdir(path.join(directory, 'plugins'))).filter(id => id === PLUGIN_ID).length, 1);
});
test('Rivetin-only boundaries reject legacy IDs and package/frontend formats', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url)));
  assert.throws(() => validateManifest({ ...manifest, id: 'pluginkit-disk-smart-info' }), /INVALID_MANIFEST/);
  assert.throws(() => validateManifest({ ...manifest, frontend: { ...manifest.frontend, format: 'pluginkit-global-v1' } }), /INVALID_MANIFEST/);
  const files = ['web/plugin.js', 'LICENSE'].map(name => { const content = Buffer.from('/* local format fixture */'); return { path: name, sha256: hash(content), data: content.toString('base64') }; });
  assert.equal(validatePackage(Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest, files }))).manifest.id, PLUGIN_ID);
  assert.throws(() => validatePackage(Buffer.from(JSON.stringify({ format: 'pluginkit-package-v1', manifest, files }))), /INVALID_PACKAGE/);
});
