import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture, bundle, actor } from './helpers.js';
import { createService } from '../server/service.js';

test('confirmed Tower mismatch persistently disables plugins and framework without removing settings', async t => {
  const f = await fixture(t); await f.install(); await f.service.enable(actor); await f.service.change('enable', 'rivetin-example', null, actor);
  await f.service.saveConfig('rivetin-example', { enabled: false }, actor);
  const before = await readFile(path.join(f.directory, 'plugins/rivetin-example/config.json'));
  const incompatible = createService(f.directory, { towerBuild: '5.0.0' });
  assert.equal((await incompatible.runtime()).enabled, false);
  const result = await incompatible.reconcileCompatibility(actor);
  assert.deepEqual(result.disabled, ['rivetin-example']);
  assert.equal((await incompatible.plugins())[0].enabled, false);
  assert.deepEqual(await readFile(path.join(f.directory, 'plugins/rivetin-example/config.json')), before);
  await assert.rejects(incompatible.enable(actor), /FRAMEWORK_TOWER_INCOMPATIBLE/);
  assert.equal((await f.service.runtime()).enabled, false);
  await f.service.enable(actor); assert.equal((await f.service.plugins())[0].enabled, false);
});

test('legacy declarations stay available to uninstall but cannot install, enable or silently resume', async t => {
  const f = await fixture(t);
  const bytes = bundle('rivetin-example', '0.1.0', value => { delete value.manifest.compatibility.schemaVersion; delete value.manifest.compatibility.smtx; return value; });
  const stored = await f.service.upload(bytes, actor);
  await assert.rejects(f.service.change('install', 'rivetin-example', stored.packageId, actor), /PLUGIN_COMPATIBILITY_UNDECLARED/);
});

test('required SMTX inventory fails closed and confirmed mismatch is saved disabled', async t => {
  const f = await fixture(t); let current = '6.3.0';
  const service = createService(f.directory, { towerBuild: '4.9.0', productVersionProvider: async () => ({ schemaVersion: 1, source: 'tower-clusters-root', trusted: true, complete: true, checkedAt: new Date().toISOString(), clusters: [{ product: 'SMTX_OS', version: current }], reason: null }) });
  const stored = await service.upload(bundle('rivetin-example', '0.1.0', value => { value.manifest.compatibility.smtx = { product: 'SMTX_OS', scope: 'all-managed-product-clusters', builds: ['6.3.0'] }; return value; }), actor);
  await service.change('install', 'rivetin-example', stored.packageId, actor); await service.enable(actor); await service.change('enable', 'rivetin-example', null, actor);
  assert.equal((await service.plugins(actor))[0].active, true);
  current = '6.4.0'; await service.reconcileCompatibility(actor);
  assert.equal((await service.plugins(actor))[0].enabled, false);
  await assert.rejects(service.change('enable', 'rivetin-example', null, actor), /SMTX_INCOMPATIBLE/);
  const noSnapshot = createService(f.directory, { towerBuild: '4.9.0' });
  await assert.rejects(noSnapshot.change('enable', 'rivetin-example', null, actor), /SMTX_SNAPSHOT_UNAVAILABLE/);
});

test('SMTX none never queries a product inventory or retains actor credentials', async t => {
  const f = await fixture(t), service = createService(f.directory, { towerBuild: '4.9.0', productVersionProvider: async () => { throw new Error('MUST_NOT_QUERY'); } });
  const stored = await service.upload(bundle(), actor); await service.change('install', 'rivetin-example', stored.packageId, actor);
  await service.change('enable', 'rivetin-example', null, actor);
  assert.equal((await service.plugins(actor))[0].compatible, true);
});

test('enable refuses old, invalid or corrupt framework metadata without a success receipt or changing rescue state', async t => {
  const f = await fixture(t), framework = path.join(f.directory, 'framework');
  const settings = path.join(framework, 'settings.json'), disabled = path.join(framework, 'disabled.json');
  const original = JSON.parse(await readFile(settings));
  const disabledBefore = await readFile(disabled), auditBefore = await readFile(path.join(f.directory, 'audit.jsonl'));
  await writeFile(path.join(framework, 'ssh-revocation.json'), JSON.stringify({ nonce: 'EXAMPLE_UNCHANGED_NONCE' }));
  const nonceBefore = await readFile(path.join(framework, 'ssh-revocation.json'));
  for (const value of [JSON.stringify({ ...original, version: '0.1.5' }), JSON.stringify({ ...original, apiVersion: 2 }), 'EXAMPLE_CORRUPT_METADATA']) {
    await writeFile(settings, value);
    await assert.rejects(f.service.enable(actor), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.equal((await f.service.runtime()).enabled, false);
    assert.deepEqual(await readFile(disabled), disabledBefore);
    assert.deepEqual(await readFile(path.join(framework, 'ssh-revocation.json')), nonceBefore);
    assert.deepEqual(await readFile(path.join(f.directory, 'audit.jsonl')), auditBefore);
  }
});
