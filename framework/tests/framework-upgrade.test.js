import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, actor } from './helpers.js';
import { createService } from '../server/service.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';

test('explicit 0.1.0 to 0.1.4 init changes only version metadata and records safe audit', async t => {
  assert.equal(FRAMEWORK_VERSION, '0.1.4');
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
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.1.4' });
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
  assert.deepEqual(JSON.parse(await readFile(file)), { apiVersion: 1, version: '0.1.4', initializedAt: 'EXAMPLE_ORIGINAL_TIME' });
});

test('explicit 0.1.1 to 0.1.4 preserves metadata/config/approvals and refuses the wrong source', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const file = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.1', initializedAt: 'EXAMPLE_RETAIN_TIME', towerBuild: '4.9.0' };
  await writeFile(file, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), beforeConfig = await readFile(config);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const approvalBytes = '{"EXAMPLE_REVOKED_APPROVAL":"retain-existing-bytes"}'; await writeFile(approvals, approvalBytes);
  await assert.rejects(service.initialize(actor), /FRAMEWORK_MIGRATION_REQUIRED/);
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.0' }), /FRAMEWORK_MIGRATION_REQUIRED/);
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.4' }), /FRAMEWORK_MIGRATION_REQUIRED/);
  const result = await service.initialize(actor, { upgradeFrom: '0.1.1' }); assert.equal(result.upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(file)), { ...original, version: '0.1.4' });
  assert.deepEqual(await readFile(config), beforeConfig); assert.equal(await readFile(approvals, 'utf8'), approvalBytes);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.1' })).upgraded, false);
  assert.equal((await service.initialize(actor)).upgraded, false);
});

test('explicit 0.1.2 to 0.1.4 only changes metadata and never restores SSH approvals or schedules', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const settings = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.2', initializedAt: 'EXAMPLE_ORIGINAL_TIME', towerBuild: '4.9.0', retained: true };
  await writeFile(settings, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), state = path.join(directory, 'plugins/rivetin-example/state.json');
  const configBytes = await readFile(config), stateBytes = await readFile(state);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const revoked = JSON.stringify({ version: 1, approvals: {}, schedules: {}, revocations: { global: 'a'.repeat(32), plugins: {} } });
  await writeFile(approvals, revoked);
  for (const upgradeFrom of [undefined, '0.1.0', '0.1.1', '0.1.4']) {
    await assert.rejects(service.initialize(actor, { upgradeFrom }), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.deepEqual(JSON.parse(await readFile(settings)), original);
  }
  await unlink(path.join(directory, 'framework/disabled.json'));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.2' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await writeFile(path.join(directory, 'framework/disabled.json'), '{}');
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.2' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.1.4' });
  assert.deepEqual(await readFile(config), configBytes); assert.deepEqual(await readFile(state), stateBytes);
  assert.equal(await readFile(approvals, 'utf8'), revoked);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.2' })).upgraded, false);
  assert.equal((await service.runtime()).enabled, false);
});

test('explicit 0.1.3 to 0.1.4 only changes metadata and never restores SSH approvals or schedules', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const settings = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.3', initializedAt: 'EXAMPLE_ORIGINAL_TIME', towerBuild: '4.9.0', retained: true };
  await writeFile(settings, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), state = path.join(directory, 'plugins/rivetin-example/state.json');
  const configBytes = await readFile(config), stateBytes = await readFile(state);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const revoked = JSON.stringify({ version: 1, approvals: {}, schedules: {}, revocations: { global: 'a'.repeat(32), plugins: {} } });
  await writeFile(approvals, revoked);
  for (const upgradeFrom of [undefined, '0.1.0', '0.1.1', '0.1.2', '0.1.4']) {
    await assert.rejects(service.initialize(actor, { upgradeFrom }), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.deepEqual(JSON.parse(await readFile(settings)), original);
  }
  await unlink(path.join(directory, 'framework/disabled.json'));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.3' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await writeFile(path.join(directory, 'framework/disabled.json'), '{}');
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.3' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.1.4' });
  assert.deepEqual(await readFile(config), configBytes); assert.deepEqual(await readFile(state), stateBytes);
  assert.equal(await readFile(approvals, 'utf8'), revoked);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.3' })).upgraded, false);
  assert.equal((await service.runtime()).enabled, false);
});
