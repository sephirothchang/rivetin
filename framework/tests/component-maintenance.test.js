import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, lstat, symlink, link } from 'node:fs/promises';
import { createComponentMaintenance, COMPONENT_MAINTENANCE_LIMITS } from '../server/component-maintenance.js';

const actor = { id: 'EXAMPLE_ADMIN', name: 'EXAMPLE_PRIVATE_DISPLAY_NAME', source: 'demo', admin: true, auth: { Authorization: 'EXAMPLE_SECRET_AUTH', Cookie: 'EXAMPLE_SECRET_COOKIE' } };
const request = () => ({ operationId: randomUUID(), acknowledged: true });
const now = () => Date.UTC(2026, 0, 2, 3, 4, 5);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t, overrides = {}) {
  const base = path.resolve('qa'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'maintenance-test-'));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await mkdir(path.join(root, 'framework')); const settings = path.join(root, 'framework/settings.json');
  await writeFile(settings, '{"apiVersion":1,"version":"0.1.5","retained":true}\n');
  const calls = [], audits = [];
  const opts = { dataDirectory: root, now,
    disableAll: async safeActor => { calls.push('disable'); assert.equal(Object.hasOwn(safeActor, 'auth'), false); await writeFile(path.join(root, 'framework/disabled.json'), '{}'); return { enabled: false, sshRevoked: true }; },
    repairMetadata: async () => { calls.push('repair'); await writeFile(settings, '{"apiVersion":1,"version":"0.1.5"}\n'); },
    clearCaches: async () => { calls.push('reset'); },
    inspect: async () => { calls.push('inspect'); return { verified: true, requiresCli: false }; },
    audit: async value => { audits.push(structuredClone(value)); },
    ...overrides,
  };
  return { root, settings, calls, audits, opts, module: createComponentMaintenance(opts) };
}

test('ordinary fixed metadata is backed up byte-for-byte before disable and repair on NTFS and ReFS', async t => {
  const f = await fixture(t), input = request();
  const original = await readFile(f.settings), info = await lstat(f.settings, { bigint: true });
  assert.equal(typeof info.ino, 'bigint');
  f.opts.disableAll = async safeActor => {
    f.calls.push('disable'); assert.equal(Object.hasOwn(safeActor, 'auth'), false);
    assert.deepEqual(await readFile(path.join(f.root, 'components-maintenance/backups', input.operationId, 'settings.json')), original);
    assert.deepEqual(await readFile(f.settings), original);
    await writeFile(path.join(f.root, 'framework/disabled.json'), '{}'); return { enabled: false, sshRevoked: true };
  };
  const result = await createComponentMaintenance(f.opts).run('repair', input, actor);
  assert.equal(result.result, 'success'); assert.equal(result.requiresReload, true);
  assert.deepEqual(f.calls, ['disable', 'repair', 'inspect']);
  assert.deepEqual(Object.keys(result).sort(), ['operationId', 'outcomes', 'requiresReload', 'result']);
  assert.ok(result.outcomes.every(row => ['ok', 'warning', 'failed', 'unknown', 'disabled'].includes(row.status)));
  const backup = path.join(f.root, 'components-maintenance/backups', input.operationId);
  assert.deepEqual((await readdir(backup)).sort(), ['manifest.json', 'settings.json']);
  assert.deepEqual((await readJson(path.join(backup, 'manifest.json'))).files.map(row => row.id), ['framework-settings']);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(backup, 'settings.json'))).mode & 0o777, 0o600);
});

test('corrupt framework metadata and an existing disabled marker retain original bytes, never plugin settings or vault contents', async t => {
  const f = await fixture(t), input = request(), original = Buffer.from('EXAMPLE_CORRUPT_JSON\0BYTES');
  await writeFile(f.settings, original); await writeFile(path.join(f.root, 'framework/disabled.json'), 'EXAMPLE_OLD_DISABLED');
  const retained = ['plugins/rivetin-example/config.json', 'plugins/rivetin-example/state.json', 'packages/EXAMPLE_PACKAGE.json', 'ssh-channel/vault/EXAMPLE_CREDENTIAL', 'smart-history/records/EXAMPLE_HISTORY.json'];
  for (const file of retained) { await mkdir(path.dirname(path.join(f.root, file)), { recursive: true }); await writeFile(path.join(f.root, file), 'EXAMPLE_RETAINED_SECRET_BYTES'); }
  const result = await f.module.run('repair', input, actor); assert.equal(result.result, 'success');
  const backup = path.join(f.root, 'components-maintenance/backups', input.operationId);
  assert.deepEqual(await readFile(path.join(backup, 'settings.json')), original);
  assert.equal(await readFile(path.join(backup, 'disabled.json'), 'utf8'), 'EXAMPLE_OLD_DISABLED');
  assert.deepEqual((await readdir(backup)).sort(), ['disabled.json', 'manifest.json', 'settings.json']);
  for (const file of retained) assert.equal(await readFile(path.join(f.root, file), 'utf8'), 'EXAMPLE_RETAINED_SECRET_BYTES');
  const publicResult = JSON.stringify(result), journal = await readFile(path.join(f.root, 'components-maintenance/operations', input.operationId + '.json'), 'utf8');
  for (const text of [publicResult, journal, JSON.stringify(f.audits)]) assert.doesNotMatch(text, /EXAMPLE_SECRET_AUTH|EXAMPLE_SECRET_COOKIE|EXAMPLE_PRIVATE_DISPLAY_NAME|EXAMPLE_RETAINED_SECRET_BYTES|EXAMPLE_CORRUPT_JSON/);
  assert.equal(publicResult.includes(f.root), false);
});

test('reset invokes only the derived-cache hook and remains disabled without metadata repair or user-file deletion', async t => {
  const f = await fixture(t), before = await readFile(f.settings);
  const result = await f.module.run('reset', request(), actor);
  assert.equal(result.result, 'success'); assert.deepEqual(f.calls, ['disable', 'reset', 'inspect']);
  assert.deepEqual(await readFile(f.settings), before);
  assert.equal(await readFile(path.join(f.root, 'framework/disabled.json'), 'utf8'), '{}');
});

test('CLI scope stays partial even after verified local metadata and disabled-state maintenance', async t => {
  const f = await fixture(t, { inspect: async () => ({ verified: true, requiresCli: true, privatePath: 'EXAMPLE_SECRET_PATH' }) });
  const result = await f.module.run('repair', request(), actor);
  assert.equal(result.result, 'partial'); assert.deepEqual(result.outcomes.find(row => row.id === 'scope'), { id: 'scope', status: 'warning', code: 'CLI_REPAIR_REQUIRED' });
  assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_SECRET_PATH|skipped/);
  const g = await fixture(t, { inspect: async () => ({ verified: true }) });
  assert.equal((await g.module.run('repair', request(), actor)).result, 'partial');
});

test('same operation replays after restart without backup or hooks and rejects another action or actor', async t => {
  const f = await fixture(t), input = request(); const first = await f.module.run('repair', input, actor), calls = [...f.calls], auditCount = f.audits.length;
  const restarted = createComponentMaintenance(f.opts);
  assert.deepEqual(await restarted.run('repair', input, actor), first);
  assert.deepEqual(f.calls, calls); assert.equal(f.audits.length, auditCount);
  await assert.rejects(restarted.run('reset', input, actor), /COMPONENT_MAINTENANCE_OPERATION_CONFLICT/);
  await assert.rejects(restarted.run('repair', input, { ...actor, id: 'EXAMPLE_OTHER_ADMIN' }), /COMPONENT_MAINTENANCE_OPERATION_CONFLICT/);
  assert.equal((await readdir(path.join(f.root, 'components-maintenance/backups'))).length, 1);
});

test('an in-flight durable intent is unknown on another instance and is never executed twice', async t => {
  let unblock, entered; const gate = new Promise(resolve => { unblock = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  let repairs = 0;
  const f = await fixture(t, { repairMetadata: async () => { repairs++; entered(); await gate; } }), input = request();
  const pending = f.module.run('repair', input, actor); await ready;
  const duplicate = await createComponentMaintenance(f.opts).run('repair', input, actor);
  assert.equal(duplicate.result, 'partial'); assert.equal(duplicate.outcomes[0].code, 'MAINTENANCE_OUTCOME_UNKNOWN'); assert.equal(repairs, 1);
  unblock(); const result = await pending; assert.equal(result.result, 'success');
  assert.deepEqual(await f.module.run('repair', input, actor), result); assert.equal(repairs, 1);
});

test('a recovered started marker remains unknown even with no active lock and cannot replay writes', async t => {
  const f = await fixture(t), input = request(); await f.module.run('repair', input, actor);
  const file = path.join(f.root, 'components-maintenance/operations', input.operationId + '.json'), journal = await readJson(file);
  journal.phase = 'started'; journal.report = null; await writeFile(file, JSON.stringify(journal));
  f.calls.length = 0;
  const result = await createComponentMaintenance(f.opts).run('repair', input, actor);
  assert.equal(result.result, 'partial'); assert.equal(result.requiresReload, true); assert.equal(result.outcomes[0].code, 'MAINTENANCE_OUTCOME_UNKNOWN'); assert.deepEqual(f.calls, []);
  assert.equal((await readJson(file)).phase, 'started');
});

test('missing injected capability is explicit partial and never a successful no-op', async t => {
  for (const missing of ['disableAll', 'repairMetadata', 'clearCaches', 'inspect', 'audit']) {
    const f = await fixture(t, { [missing]: undefined }), action = missing === 'clearCaches' ? 'reset' : 'repair';
    const result = await f.module.run(action, request(), actor); assert.equal(result.result, 'partial');
    assert.ok(result.outcomes.some(row => row.code === 'CLI_REPAIR_REQUIRED'));
    if (missing === 'disableAll') assert.deepEqual(f.calls, ['inspect']);
  }
});

test('disable must confirm both the global marker and SSH revocation before any repair or reset hook', async t => {
  for (const response of [undefined, { enabled: true, sshRevoked: true }, { enabled: false }, { enabled: false, sshRevoked: false }]) {
    const f = await fixture(t, { disableAll: async () => response });
    const result = await f.module.run('repair', request(), actor);
    assert.equal(result.result, 'partial'); assert.equal(result.outcomes.find(row => row.id === 'disable').code, 'MAINTENANCE_DISABLE_FAILED');
    assert.equal(f.calls.includes('repair'), false); assert.equal(f.calls.includes('reset'), false);
  }
});

test('hook failures are fixed-code partial reports without raw errors, credentials, stacks or backend paths', async t => {
  for (const failing of ['disableAll', 'repairMetadata', 'clearCaches', 'inspect', 'audit']) {
    const f = await fixture(t, { [failing]: async () => { throw new Error('EXAMPLE_SECRET_AUTH /EXAMPLE_PRIVATE_BACKEND_PATH'); } });
    const result = await f.module.run(failing === 'clearCaches' ? 'reset' : 'repair', request(), actor);
    assert.equal(result.result, 'partial'); assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_SECRET|EXAMPLE_PRIVATE|stack|skipped/);
  }
});

test('bad requests and non-admin actors fail before creating maintenance storage', async t => {
  const f = await fixture(t);
  for (const [action, input, identity] of [
    ['repair', request(), null], ['repair', request(), { ...actor, admin: false }], ['delete', request(), actor],
    ['repair', { ...request(), acknowledged: false }, actor], ['repair', { operationId: randomUUID() }, actor],
    ['repair', { ...request(), path: '/EXAMPLE_PRIVATE_PATH' }, actor], ['repair', { ...request(), command: 'EXAMPLE_COMMAND' }, actor],
    ['repair', { ...request(), operationId: '../EXAMPLE' }, actor], ['repair', { ...request(), operationId: '00000000-0000-1000-8000-000000000000' }, actor],
    ['repair', { ...request(), operationId: {} }, actor], ['repair', null, actor],
  ]) await assert.rejects(f.module.run(action, input, identity), /AUTHENTICATION_REQUIRED|ADMIN_REQUIRED|COMPONENT_MAINTENANCE_REQUEST_INVALID/);
  assert.equal((await readdir(f.root)).includes('components-maintenance'), false); assert.deepEqual(f.calls, []);
});

test('metadata hard size limit blocks mutation and retains the original file unchanged', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(COMPONENT_MAINTENANCE_LIMITS.metadataBytes + 1, 65); await writeFile(f.settings, bytes);
  const result = await f.module.run('repair', request(), actor);
  assert.equal(result.result, 'partial'); assert.equal(result.outcomes[0].code, 'MAINTENANCE_BACKUP_FAILED');
  assert.deepEqual(f.calls, ['inspect']); assert.deepEqual(await readFile(f.settings), bytes);
});

test('metadata hard links cannot redirect backups into other files when supported by the test environment', async t => {
  const f = await fixture(t), original = await readFile(f.settings), linked = path.join(f.root, 'EXAMPLE_METADATA_HARDLINK');
  try { await link(f.settings, linked); } catch (failure) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(failure.code)) { t.skip('Filesystem hard-link creation is unavailable in this sandbox.'); return; } throw failure; }
  const failed = await f.module.run('repair', request(), actor); assert.equal(failed.outcomes[0].code, 'MAINTENANCE_BACKUP_FAILED'); assert.equal(f.calls.includes('disable'), false);
  assert.deepEqual(await readFile(linked), original);
});

test('directory symlinks cannot redirect fixed metadata backups when supported by the test environment', async t => {
  const g = await fixture(t), target = path.join(g.root, 'EXAMPLE_LINK_TARGET'), moved = path.join(g.root, 'framework');
  await mkdir(target); await writeFile(path.join(target, 'settings.json'), 'EXAMPLE_SECRET_METADATA');
  // Only remove this test's own original fixture directory before replacing it with a link.
  assert.equal(path.dirname(moved), g.root); await rm(moved, { recursive: true });
  try { await symlink(target, moved, process.platform === 'win32' ? 'junction' : 'dir'); } catch (failure) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(failure.code)) { t.skip('Filesystem link creation is unavailable in this sandbox.'); return; } throw failure; }
  const redirected = await g.module.run('repair', request(), actor); assert.equal(redirected.result, 'partial'); assert.equal(g.calls.includes('disable'), false);
  assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), 'EXAMPLE_SECRET_METADATA');
});

test('backup capacity refuses new operations without deleting retained backups and permits prior replay', async t => {
  const f = await fixture(t), input = request(); const first = await f.module.run('reset', input, actor);
  const base = path.join(f.root, 'components-maintenance/backups');
  await Promise.all(Array.from({ length: COMPONENT_MAINTENANCE_LIMITS.backups - 1 }, () => mkdir(path.join(base, randomUUID()))));
  const before = (await readdir(base)).sort(), calls = [...f.calls];
  await assert.rejects(f.module.run('reset', request(), actor), /COMPONENT_MAINTENANCE_BACKUP_LIMIT/);
  assert.deepEqual((await readdir(base)).sort(), before); assert.deepEqual(f.calls, calls);
  assert.deepEqual(await f.module.run('reset', input, actor), first);
});

test('journal corruption is fail-closed and does not execute or expose its content', async t => {
  const f = await fixture(t), input = request(); await f.module.run('reset', input, actor); f.calls.length = 0;
  const file = path.join(f.root, 'components-maintenance/operations', input.operationId + '.json');
  await writeFile(file, '{"EXAMPLE_SECRET_JOURNAL":');
  await assert.rejects(f.module.run('reset', input, actor), failure => failure.message === 'COMPONENT_MAINTENANCE_JOURNAL_INVALID');
  assert.deepEqual(f.calls, []);
});

test('operation journals have a separate hard limit and are never pruned automatically', async t => {
  const f = await fixture(t), input = request(); await f.module.run('reset', input, actor);
  const base = path.join(f.root, 'components-maintenance/operations');
  await Promise.all(Array.from({ length: COMPONENT_MAINTENANCE_LIMITS.operations - 1 }, () => writeFile(path.join(base, randomUUID() + '.json'), '{}')));
  f.calls.length = 0;
  await assert.rejects(f.module.run('repair', request(), actor), /COMPONENT_MAINTENANCE_OPERATION_LIMIT/);
  assert.equal((await readdir(base)).length, COMPONENT_MAINTENANCE_LIMITS.operations); assert.deepEqual(f.calls, []);
});


test('a contradictory completed report is rejected instead of replaying a forged success', async t => {
  const f = await fixture(t), input = request(); await f.module.run('repair', input, actor); f.calls.length = 0;
  const file = path.join(f.root, 'components-maintenance/operations', input.operationId + '.json'), journal = await readJson(file);
  journal.report.result = 'success'; journal.report.outcomes[0].status = 'failed'; await writeFile(file, JSON.stringify(journal));
  await assert.rejects(f.module.run('repair', input, actor), /COMPONENT_MAINTENANCE_JOURNAL_INVALID/); assert.deepEqual(f.calls, []);
});
