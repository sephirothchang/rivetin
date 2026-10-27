import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLUGIN_ID, LICENSE_ID } from '../src/identity.js';
import { validateSettings } from '../../../framework/server/manifest.js';

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
