import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, actor } from './helpers.js';
import { createService } from '../server/service.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';

test('explicit 0.1.0 to 0.1.1 init changes only version metadata and records safe audit', async t => {
  assert.equal(FRAMEWORK_VERSION, '0.1.1');
  const { directory, install } = await fixture(t); await install();
  const settings = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.0', initializedAt: 'EXAMPLE_ORIGINAL_TIME', towerBuild: '4.9.0', exampleRetained: true };
  await writeFile(settings, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json');
  const state = path.join(directory, 'plugins/rivetin-example/state.json');
  const beforeConfig = await readFile(config), beforeState = await readFile(state);
  const vault = path.join(directory, 'example-retained-vault'); await writeFile(vault, 'EXAMPLE_OPAQUE_BYTES');
  const service = createService(directory, { builtinPackages: [Buffer.from('EXAMPLE_MUST_NOT_READ_BUILTIN')] });
  await assert.rejects(service.initialize(actor), /FRAMEWORK_MIGRATION_REQUIRED/);
  assert.deepEqual(JSON.parse(await readFile(settings)), original);
  const result = await service.initialize(actor, { upgradeFrom: '0.1.0' });
  assert.equal(result.upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.1.1' });
  assert.deepEqual(await readFile(config), beforeConfig); assert.deepEqual(await readFile(state), beforeState);
  assert.equal(await readFile(vault, 'utf8'), 'EXAMPLE_OPAQUE_BYTES');
  const after = await readFile(settings);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.0' })).upgraded, false);
  assert.deepEqual(await readFile(settings), after);
  const events = (await service.logs()).items.filter(item => item.action.startsWith('framework.upgrade'));
  assert.equal(events.length, 2); assert.ok(events.every(item => !JSON.stringify(item).includes('OPAQUE_BYTES')));
  assert.equal((await service.runtime()).enabled, false);
});

test('init rejects unknown versions, schema changes, enabled upgrades, missing source and unsupported direction', async t => {
  const { service, directory } = await fixture(t);
  const file = path.join(directory, 'framework/settings.json');
  for (const original of [{ apiVersion: 2, version: '0.1.0' }, { apiVersion: 1, version: '0.2.0' }]) {
    const bytes = JSON.stringify(original); await writeFile(file, bytes);
    await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.0' }), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.equal(await readFile(file, 'utf8'), bytes);
  }
  await writeFile(file, JSON.stringify({ apiVersion: 1, version: '0.1.0' }));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.0.9' }), /FRAMEWORK_MIGRATION_REQUIRED/);
  await unlink(path.join(directory, 'framework/disabled.json'));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.0' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  assert.equal(JSON.parse(await readFile(file)).version, '0.1.0');
  await unlink(file);
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.0' }), /FRAMEWORK_MIGRATION_REQUIRED/);
});

test('CLI init accepts one explicit upgrade-from argument and rejects malformed flags before metadata mutation', async t => {
  const { directory } = await fixture(t), file = path.join(directory, 'framework/settings.json');
  const old = JSON.stringify({ apiVersion: 1, version: '0.1.0', initializedAt: 'EXAMPLE_ORIGINAL_TIME' });
  await writeFile(file, old);
  for (const args of [['--upgrade-from'], ['--upgrade-from', '0.1.0', '--upgrade-from', '0.1.0'], ['--unexpected', '0.1.0']]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['cli.mjs', 'init', '--data', directory, ...args]), error => error.stderr.trim() === 'INVALID_INIT_ARGUMENTS');
    assert.equal(await readFile(file, 'utf8'), old);
  }
  const output = await promisify(execFile)(process.execPath, ['cli.mjs', 'init', '--data', directory, '--upgrade-from', '0.1.0']);
  assert.equal(JSON.parse(output.stdout).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(file)), { apiVersion: 1, version: '0.1.1', initializedAt: 'EXAMPLE_ORIGINAL_TIME' });
});
