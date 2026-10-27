import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, actor } from '../../../framework/tests/helpers.js';
import { hash } from '../../../framework/server/manifest.js';
import { defaults, PLUGIN_ID } from '../src/configuration.js';

test('context-menu package lifecycle preserves independent settings, disable and rollback', async t => {
  const { service, directory, install } = await fixture(t);
  const manifest = JSON.parse(await readFile(new URL('../rivetin.json', import.meta.url)));
  function packageBytes(version) {
    const code = Buffer.from('/* non-executed lifecycle fixture */'), license = Buffer.from('MIT License');
    // This non-executed service fixture declares its simulated Tower build only.
    return Buffer.from(JSON.stringify({ format: 'rivetin-package-v1', manifest: { ...manifest, version, compatibility: { ...manifest.compatibility, towerBuilds: ['4.9.0'] } }, files: [
      { path: 'web/plugin.js', data: code.toString('base64'), sha256: hash(code) },
      { path: 'LICENSE', data: license.toString('base64'), sha256: hash(license) },
    ] }));
  }
  await install('rivetin-other');
  await service.saveConfig('rivetin-other', { enabled: false }, actor);
  const otherPath = path.join(directory, 'plugins/rivetin-other/config.json');
  const otherBefore = await readFile(otherPath);
  const first = await service.upload(packageBytes('0.1.0'), actor);
  await service.change('install', PLUGIN_ID, first.packageId, actor);
  assert.equal((await service.plugins()).find(item => item.id === PLUGIN_ID).active, false);
  await service.enable(actor); await service.change('enable', PLUGIN_ID, null, actor);
  assert.equal((await service.plugins()).find(item => item.id === PLUGIN_ID).active, true);
  await service.saveConfig(PLUGIN_ID, { ...defaults(), resourceTypes: ['vm', 'host'], nativeActions: false }, actor);
  const configPath = path.join(directory, 'plugins', PLUGIN_ID, 'config.json'), before = await readFile(configPath);
  const next = await service.upload(packageBytes('0.1.1'), actor);
  await service.change('update', PLUGIN_ID, next.packageId, actor);
  assert.deepEqual(await readFile(configPath), before);
  assert.equal((await service.plugins()).find(item => item.id === PLUGIN_ID).enabled, false);
  await service.change('rollback', PLUGIN_ID, null, actor);
  assert.equal((await service.plugins()).find(item => item.id === PLUGIN_ID).version, '0.1.0');
  assert.deepEqual(await readFile(configPath), before);
  await service.disable(actor);
  assert.ok((await service.plugins()).every(item => !item.active));
  await service.change('uninstall', PLUGIN_ID, null, actor);
  assert.deepEqual(await readFile(configPath), before);
  assert.deepEqual(await readFile(otherPath), otherBefore);
});
