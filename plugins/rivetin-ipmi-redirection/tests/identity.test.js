import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLUGIN_ID, LICENSE_ID } from '../src/identity.js';
import { hash, validateManifest, validateSettings } from '../../../framework/server/manifest.js';
import { checkCompatibility } from '../../../framework/server/compatibility.js';

test('plugin ID, package, lockfile, Island manifest and license agree', async () => {
  const load = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
  const pkg = JSON.parse(await load('package.json')), lock = JSON.parse(await load('package-lock.json')), manifest = JSON.parse(await load('sea-map.json')), descriptor = JSON.parse(await load('rivetin.json'));
  assert.equal(pkg.name, PLUGIN_ID); assert.equal(lock.name, PLUGIN_ID); assert.equal(lock.packages[''].name, PLUGIN_ID);
  assert.equal(manifest.name, PLUGIN_ID); assert.equal(manifest.data[0].island, './RivetinIpmiRedirection');
  assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
  assert.equal(pkg.version, manifest.metadata.version); assert.equal(pkg.version, descriptor.version);
  assert.equal(pkg.license, LICENSE_ID); assert.equal(pkg.license, 'MIT');
  assert.ok((await load('LICENSE')).includes('THE SOFTWARE IS PROVIDED "AS IS"'));
});
test('the executable child manifest rejects unregistered BMC protocol IDs before configuration is saved', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
  const settings = structuredClone(manifest.configuration.defaults);
  assert.doesNotThrow(() => validateSettings(settings, manifest.configuration.schema));
  settings.defaultVendor = 'EXAMPLE_UNREGISTERED_VENDOR';
  assert.throws(() => validateSettings(settings, manifest.configuration.schema));
});

test('current candidate declares the Tower and Rivetin 0.2.x boundary without a SMTX version gate', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.4'); assert.doesNotThrow(() => validateManifest(manifest));
  assert.deepEqual(manifest.compatibility, { schemaVersion: 2, frameworkApi: 1,
    tower: 'CloudTower 4.9.0; Rivetin >=0.2.0 <0.3.0. IPMI HTTPS redirection only.',
    towerBuilds: ['4.9.0'], frameworkMinVersion: '0.2.0', frameworkMaxVersionExclusive: '0.3.0', smtx: 'none' });
  const context = { towerBuild: '4.9.0', frameworkApi: 1, frameworkVersion: '0.2.0' };
  assert.equal(checkCompatibility(manifest, context).compatible, true);
  assert.equal(checkCompatibility(manifest, { ...context, frameworkVersion: '0.2.99' }).compatible, true);
  for (const changes of [{ frameworkVersion: '0.1.9' }, { frameworkVersion: '0.3.0' }, { towerBuild: '4.10.0' }, { frameworkApi: 2 }]) {
    assert.equal(checkCompatibility(manifest, { ...context, ...changes }).compatible, false);
  }
  assert.equal(checkCompatibility(manifest, { ...context, smtx: undefined }).compatible, true);
});

test('current candidate preserves 0.1.2 permissions, configuration and lifecycle defaults', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['inventory.read', 'host.ipmi.enhance', 'bmc.session.launch']);
  assert.deepEqual(manifest.lifecycle, { reset: 'defaults', uninstall: 'retain-config' });
  assert.equal(hash(Buffer.from(JSON.stringify(manifest.configuration))), '762ceb6b4e56f5a20ab702f6f05367f17c9acfc18382763782cb81b199f07360');
  assert.equal(manifest.configuration.defaults.loginMode, 'direct');
  assert.match(manifest.releaseNotes['en-US'], /production BMC browser auto-login is not integrated/);
});
