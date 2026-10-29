import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir, unlink, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, actor } from './helpers.js';
import { createService } from '../server/service.js';
import { FRAMEWORK_VERSION } from '../shared/version.js';
import { runtimeFiles } from '../scripts/runtime-files.mjs';

test('0.2.0 to 0.2.6 upgrades only explicit disabled metadata and does not migrate vault bytes', async t => {
  const { service, directory } = await fixture(t), file = path.join(directory, 'framework/settings.json');
  await writeFile(file, JSON.stringify({ version: '0.2.0', apiVersion: 1, retained: 'EXAMPLE' }));
  const vault = path.join(directory, 'ssh-channel/vault'); await mkdir(vault, { recursive: true });
  const bytes = Buffer.from('EXAMPLE_OPAQUE_V1_CIPHERTEXT'); await writeFile(path.join(vault, 'connections.v1.json'), bytes);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.2.0' })).upgraded, true);
  assert.deepEqual(await readFile(path.join(vault, 'connections.v1.json')), bytes);
  assert.equal((await service.runtime()).enabled, false);
});

test('0.2.1 to 0.2.6 preserves v2 ciphertext and changes only explicit disabled metadata', async t => {
  const { service, directory } = await fixture(t), file = path.join(directory, 'framework/settings.json');
  const original = { version: '0.2.1', apiVersion: 1, retained: 'EXAMPLE' }; await writeFile(file, JSON.stringify(original));
  const vault = path.join(directory, 'ssh-channel/vault'); await mkdir(vault, { recursive: true });
  const bytes = Buffer.from('EXAMPLE_OPAQUE_V2_CIPHERTEXT'); await writeFile(path.join(vault, 'connections.v2.json'), bytes);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.2.1' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(file)), { ...original, version: FRAMEWORK_VERSION });
  assert.deepEqual(await readFile(path.join(vault, 'connections.v2.json')), bytes);
  assert.equal((await service.runtime()).enabled, false);
});

test('0.2.2 to 0.2.6 upgrades explicit disabled metadata while retaining the vault and plugin settings', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'framework/settings.json');
  await f.install(); await f.service.enable(actor);
  const configFile = path.join(f.directory, 'plugins/rivetin-example/config.json'), beforeConfig = await readFile(configFile);
  const vault = path.join(f.directory, 'ssh-channel/vault'); await mkdir(vault, { recursive: true });
  const vaultFile = path.join(vault, 'connections.v1.json'); await writeFile(vaultFile, 'EXAMPLE_ORIGINAL_CIPHERTEXT');
  const original = { version: '0.2.2', apiVersion: 1, retained: 'EXAMPLE' }; await writeFile(file, JSON.stringify(original));
  await assert.rejects(f.service.initialize(actor, { upgradeFrom: '0.2.2' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await f.service.disable(actor);
  assert.equal((await f.service.initialize(actor, { upgradeFrom: '0.2.2' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(file)), { ...original, version: '0.2.6' });
  assert.equal(await readFile(vaultFile, 'utf8'), 'EXAMPLE_ORIGINAL_CIPHERTEXT'); assert.deepEqual(await readFile(configFile), beforeConfig);
});

test('explicit 0.1.0 to 0.2.6 init changes only version metadata and records safe audit', async t => {
  assert.equal(FRAMEWORK_VERSION, '0.2.6');
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
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.2.6' });
  assert.deepEqual(await readFile(config), beforeConfig); assert.deepEqual(await readFile(state), beforeState);
  assert.equal(await readFile(vault, 'utf8'), 'EXAMPLE_OPAQUE_BYTES');
  const after = await readFile(settings);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.0' })).upgraded, false);
  assert.deepEqual(await readFile(settings), after);
  const events = (await service.logs()).items.filter(item => item.action.startsWith('framework.upgrade'));
  assert.equal(events.length, 2); assert.ok(events.every(item => !JSON.stringify(item).includes('OPAQUE_BYTES')));
  assert.equal((await service.runtime()).enabled, false);
});

for (const source of ['0.2.3', '0.2.4', '0.2.5']) test(`${source} to 0.2.6 preserves the diagnostic ledger, vault and plugin settings while requiring a disabled source`, async t => {
  const f = await fixture(t), file = path.join(f.directory, 'framework/settings.json');
  await f.install(); await f.service.enable(actor);
  const configFile = path.join(f.directory, 'plugins/rivetin-example/config.json'), config = await readFile(configFile);
  const vault = path.join(f.directory, 'ssh-channel/vault'); await mkdir(vault, { recursive: true });
  const vaultFile = path.join(vault, 'connections.v1.json'), ledger = path.join(f.directory, 'ssh-channel/identity.v1.json');
  await writeFile(vaultFile, 'EXAMPLE_ORIGINAL_CIPHERTEXT'); await writeFile(ledger, 'EXAMPLE_ORIGINAL_DIAGNOSTIC_LEDGER');
  const original = { version: source, apiVersion: 1, retained: 'EXAMPLE' }; await writeFile(file, JSON.stringify(original));
  await assert.rejects(f.service.initialize(actor, { upgradeFrom: source }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await f.service.disable(actor);
  assert.equal((await f.service.initialize(actor, { upgradeFrom: source })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(file)), { ...original, version: '0.2.6' });
  assert.equal(await readFile(vaultFile, 'utf8'), 'EXAMPLE_ORIGINAL_CIPHERTEXT');
  assert.equal(await readFile(ledger, 'utf8'), 'EXAMPLE_ORIGINAL_DIAGNOSTIC_LEDGER');
  assert.deepEqual(await readFile(configFile), config);
});

test('init rejects unknown versions, schema changes, enabled upgrades, missing source and unsupported direction', async t => {
  const { service, directory } = await fixture(t);
  const file = path.join(directory, 'framework/settings.json');
  for (const original of [{ apiVersion: 2, version: '0.1.0' }, { apiVersion: 1, version: '0.3.0' }]) {
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
  assert.deepEqual(JSON.parse(await readFile(file)), { apiVersion: 1, version: '0.2.6', initializedAt: 'EXAMPLE_ORIGINAL_TIME' });
});

test('explicit CLI metadata migration does not depend on generated builtins in a clean source tree', async t => {
  const { directory } = await fixture(t), code = path.join(directory, 'clean-code'), data = path.join(directory, 'data');
  await mkdir(path.join(data, 'framework'), { recursive: true });
  await writeFile(path.join(data, 'framework/settings.json'), JSON.stringify({ version: '0.1.5', apiVersion: 1, towerBuild: '4.9.0' }));
  await writeFile(path.join(data, 'framework/disabled.json'), JSON.stringify({ disabledAt: 'EXAMPLE_DISABLED_TIME' }));
  for (const name of await runtimeFiles(path.resolve('.'), ['cli.mjs'])) {
    await mkdir(path.dirname(path.join(code, name)), { recursive: true }); await copyFile(name, path.join(code, name));
  }
  await writeFile(path.join(code, 'package.json'), '{"type":"module"}');
  const env = { ...process.env, RIVETIN_TOWER_URL: '' };
  const result = await promisify(execFile)(process.execPath, [path.join(code, 'cli.mjs'), 'init', '--data', data, '--upgrade-from', '0.1.5'], { env });
  assert.equal(JSON.parse(result.stdout).upgraded, true);
  assert.equal(JSON.parse(await readFile(path.join(data, 'framework/settings.json'))).version, FRAMEWORK_VERSION);
  assert.equal(JSON.parse(await readFile(path.join(data, 'framework/disabled.json'))).disabledAt, 'EXAMPLE_DISABLED_TIME');
  await assert.rejects(readFile(path.join(code, 'server/builtins/rivetin-ssh-channel.json')), error => error.code === 'ENOENT');
});

test('explicit 0.1.1 to 0.2.6 preserves metadata/config/approvals and refuses the wrong source', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const file = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.1', initializedAt: 'EXAMPLE_RETAIN_TIME', towerBuild: '4.9.0' };
  await writeFile(file, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), beforeConfig = await readFile(config);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const approvalBytes = '{"EXAMPLE_REVOKED_APPROVAL":"retain-existing-bytes"}'; await writeFile(approvals, approvalBytes);
  await assert.rejects(service.initialize(actor), /FRAMEWORK_MIGRATION_REQUIRED/);
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.0' }), /FRAMEWORK_MIGRATION_REQUIRED/);
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.2.6' }), /FRAMEWORK_MIGRATION_REQUIRED/);
  const result = await service.initialize(actor, { upgradeFrom: '0.1.1' }); assert.equal(result.upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(file)), { ...original, version: '0.2.6' });
  assert.deepEqual(await readFile(config), beforeConfig); assert.equal(await readFile(approvals, 'utf8'), approvalBytes);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.1' })).upgraded, false);
  assert.equal((await service.initialize(actor)).upgraded, false);
});

test('explicit 0.1.2 to 0.2.6 only changes metadata and never restores SSH approvals or schedules', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const settings = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.2', initializedAt: 'EXAMPLE_ORIGINAL_TIME', towerBuild: '4.9.0', retained: true };
  await writeFile(settings, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), state = path.join(directory, 'plugins/rivetin-example/state.json');
  const configBytes = await readFile(config), stateBytes = await readFile(state);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const revoked = JSON.stringify({ version: 1, approvals: {}, schedules: {}, revocations: { global: 'a'.repeat(32), plugins: {} } });
  await writeFile(approvals, revoked);
  for (const upgradeFrom of [undefined, '0.1.0', '0.1.1', '0.2.6']) {
    await assert.rejects(service.initialize(actor, { upgradeFrom }), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.deepEqual(JSON.parse(await readFile(settings)), original);
  }
  await unlink(path.join(directory, 'framework/disabled.json'));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.2' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await writeFile(path.join(directory, 'framework/disabled.json'), '{}');
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.2' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.2.6' });
  assert.deepEqual(await readFile(config), configBytes); assert.deepEqual(await readFile(state), stateBytes);
  assert.equal(await readFile(approvals, 'utf8'), revoked);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.2' })).upgraded, false);
  assert.equal((await service.runtime()).enabled, false);
});

test('explicit 0.1.3 to 0.2.6 only changes metadata and never restores SSH approvals or schedules', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const settings = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.3', initializedAt: 'EXAMPLE_ORIGINAL_TIME', towerBuild: '4.9.0', retained: true };
  await writeFile(settings, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), state = path.join(directory, 'plugins/rivetin-example/state.json');
  const configBytes = await readFile(config), stateBytes = await readFile(state);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const revoked = JSON.stringify({ version: 1, approvals: {}, schedules: {}, revocations: { global: 'a'.repeat(32), plugins: {} } });
  await writeFile(approvals, revoked);
  for (const upgradeFrom of [undefined, '0.1.0', '0.1.1', '0.1.2', '0.2.6']) {
    await assert.rejects(service.initialize(actor, { upgradeFrom }), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.deepEqual(JSON.parse(await readFile(settings)), original);
  }
  await unlink(path.join(directory, 'framework/disabled.json'));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.3' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await writeFile(path.join(directory, 'framework/disabled.json'), '{}');
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.3' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.2.6' });
  assert.deepEqual(await readFile(config), configBytes); assert.deepEqual(await readFile(state), stateBytes);
  assert.equal(await readFile(approvals, 'utf8'), revoked);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.3' })).upgraded, false);
  assert.equal((await service.runtime()).enabled, false);
});

test('explicit 0.1.4 to 0.2.6 only changes metadata and never restores SSH approvals or schedules', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const settings = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.4', initializedAt: 'EXAMPLE_ORIGINAL_TIME', towerBuild: '4.9.0', retained: true };
  await writeFile(settings, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), state = path.join(directory, 'plugins/rivetin-example/state.json');
  const configBytes = await readFile(config), stateBytes = await readFile(state);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const revoked = JSON.stringify({ version: 1, approvals: {}, schedules: {}, revocations: { global: 'a'.repeat(32), plugins: {} } });
  await writeFile(approvals, revoked);
  for (const upgradeFrom of [undefined, '0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.2.6']) {
    await assert.rejects(service.initialize(actor, { upgradeFrom }), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.deepEqual(JSON.parse(await readFile(settings)), original);
  }
  await unlink(path.join(directory, 'framework/disabled.json'));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.4' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await writeFile(path.join(directory, 'framework/disabled.json'), '{}');
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.4' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.2.6' });
  assert.deepEqual(await readFile(config), configBytes); assert.deepEqual(await readFile(state), stateBytes);
  assert.equal(await readFile(approvals, 'utf8'), revoked);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.4' })).upgraded, false);
  assert.equal((await service.runtime()).enabled, false);
});

test('explicit 0.1.5 to 0.2.6 only changes metadata and never restores SSH approvals or schedules', async t => {
  const { service, directory, install } = await fixture(t); await install();
  const settings = path.join(directory, 'framework/settings.json');
  const original = { apiVersion: 1, version: '0.1.5', initializedAt: 'EXAMPLE_ORIGINAL_TIME', towerBuild: '4.9.0', retained: true };
  await writeFile(settings, JSON.stringify(original));
  const config = path.join(directory, 'plugins/rivetin-example/config.json'), state = path.join(directory, 'plugins/rivetin-example/state.json');
  const configBytes = await readFile(config), stateBytes = await readFile(state);
  const history = path.join(directory, 'smart-history/records', 'b'.repeat(64) + '.json'); await mkdir(path.dirname(history), { recursive: true });
  const historyBytes = Buffer.from('{"EXAMPLE_RETAINED_HISTORY":true}'); await writeFile(history, historyBytes);
  const approvals = path.join(directory, 'ssh-channel/approvals.json'); await mkdir(path.dirname(approvals), { recursive: true });
  const revoked = JSON.stringify({ version: 1, approvals: {}, schedules: {}, revocations: { global: 'a'.repeat(32), plugins: {} } });
  await writeFile(approvals, revoked);
  for (const upgradeFrom of [undefined, '0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.2.6']) {
    await assert.rejects(service.initialize(actor, { upgradeFrom }), /FRAMEWORK_MIGRATION_REQUIRED/);
    assert.deepEqual(JSON.parse(await readFile(settings)), original);
  }
  await unlink(path.join(directory, 'framework/disabled.json'));
  await assert.rejects(service.initialize(actor, { upgradeFrom: '0.1.5' }), /FRAMEWORK_DISABLE_BEFORE_UPGRADE/);
  await writeFile(path.join(directory, 'framework/disabled.json'), '{}');
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.5' })).upgraded, true);
  assert.deepEqual(JSON.parse(await readFile(settings)), { ...original, version: '0.2.6' });
  assert.deepEqual(await readFile(config), configBytes); assert.deepEqual(await readFile(state), stateBytes);
  assert.equal(await readFile(approvals, 'utf8'), revoked); assert.deepEqual(await readFile(history), historyBytes);
  assert.equal((await service.initialize(actor, { upgradeFrom: '0.1.5' })).upgraded, false);
  assert.equal((await service.runtime()).enabled, false);
});
