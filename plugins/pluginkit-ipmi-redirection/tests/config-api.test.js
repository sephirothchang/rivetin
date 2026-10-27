import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createFileConfigurationRepository, createDemoConfigurationHandler } from '../server/config-repository.js';
import { sanitizeFunctionalSettings, validateFunctionalSettings } from '../src/configuration.js';
import { PLUGIN_ID } from '../src/identity.js';

test('shared API persists across server instances, serializes last-save-wins, and rejects non-whitelisted values and origins', async () => {
  const qa = path.resolve('qa'); await mkdir(qa, { recursive: true });
  const folder = await mkdtemp(path.join(qa, 'config-test-')), file = path.join(folder, 'settings.json');
  const repository = createFileConfigurationRepository(file), handler = createDemoConfigurationHandler(repository);
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/api/pluginkit/v1/config`;
  const put = (settings, origin = 'http://127.0.0.1:43170') => fetch(endpoint, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pluginId: PLUGIN_ID, settings }) });
  try {
    assert.equal((await (await fetch(endpoint)).json()).revision, 0);
    assert.equal((await put(sanitizeFunctionalSettings({ defaultVendor: 'hpe-ilo' }))).status, 200);
    const recreated = createFileConfigurationRepository(file);
    assert.equal((await recreated.load()).plugins[PLUGIN_ID].settings.defaultVendor, 'hpe-ilo');
    await Promise.all([
      repository.save(PLUGIN_ID, sanitizeFunctionalSettings({ defaultVendor: 'dell-idrac' })),
      repository.save(PLUGIN_ID, sanitizeFunctionalSettings({ defaultVendor: 'ami-megarac' })),
    ]);
    const result = await (await fetch(endpoint)).json();
    assert.equal(result.plugins[PLUGIN_ID].settings.defaultVendor, 'ami-megarac'); assert.equal(result.revision, 3);
    assert.equal((await put({ ...sanitizeFunctionalSettings(), password: 'EXAMPLE_REJECTED_SECRET' })).status, 400);
    assert.equal((await put({ ...sanitizeFunctionalSettings(), showFloatingButton: false })).status, 400);
    assert.equal((await put(sanitizeFunctionalSettings(), 'https://other.example.invalid')).status, 403);
    assert.ok(!(await readFile(file, 'utf8')).includes('EXAMPLE_REJECTED_SECRET'));
    await writeFile(file, 'EXAMPLE_CORRUPT_FILE');
    assert.equal((await fetch(endpoint)).status, 503);
    assert.equal((await put(sanitizeFunctionalSettings())).status, 503);
    assert.equal(await readFile(file, 'utf8'), 'EXAMPLE_CORRUPT_FILE');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!folder.startsWith(qa + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE');
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('the shared endpoint store isolates plugins and backs up the old prototype format before migrating', async () => {
  const qa = path.resolve('qa'); await mkdir(qa, { recursive: true });
  const folder = await mkdtemp(path.join(qa, 'multi-plugin-test-')), file = path.join(folder, 'settings.json');
  const secondId = 'pluginkit-example', otherSchema = value => {
    if (!value || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') throw new Error('INVALID_SETTINGS');
    return { enabled: value.enabled };
  };
  const repository = createFileConfigurationRepository(file, { [PLUGIN_ID]: validateFunctionalSettings, [secondId]: otherSchema });
  const legacy = { revision: 4, updatedAt: 'EXAMPLE_TIMESTAMP', settings: sanitizeFunctionalSettings({ defaultVendor: 'hpe-ilo' }) };
  try {
    await writeFile(file, JSON.stringify(legacy));
    assert.equal((await repository.load()).plugins[PLUGIN_ID].revision, 4);
    await repository.save(secondId, { enabled: true });
    assert.deepEqual(JSON.parse(await readFile(file + '.legacy-v1.backup', 'utf8')), legacy);
    await repository.save(PLUGIN_ID, sanitizeFunctionalSettings({ defaultVendor: 'dell-idrac' }));
    const data = await repository.load();
    assert.equal(data.plugins[secondId].settings.enabled, true);
    assert.equal(data.plugins[PLUGIN_ID].settings.defaultVendor, 'dell-idrac');
    assert.equal(data.plugins[PLUGIN_ID].revision, 5);
    await assert.rejects(repository.save('pluginkit-unregistered', {}));
    assert.equal((await repository.load()).revision, 6);
  } finally {
    if (!folder.startsWith(qa + path.sep)) throw new Error('TEST_PATH_OUTSIDE_WORKSPACE');
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
